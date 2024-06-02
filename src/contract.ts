import {Request, Response} from "express";
import {ethers} from "ethers";
import {getConnection, PoolClient} from "@smartbonds/smartbonds-api-lib";
import {CloudTasksClient} from "@google-cloud/tasks";
import {inflate} from "pako";
import {
    CONTRACT_MANAGER_DEF, CONTRACT_QUEUE,
    ContractJson,
    INFURA_KEY, KNOWN_NETWORKS,
    PROJECT_ID,
    PROJECT_REGION, SERVICE_ACCOUNT,
    SIGNING_KEY, TASK_AUDIENCE, TASK_REQUEST_URL
} from "./defaults";
import {ContractParameter, SerializedParameters, simpleDeserializeParams} from "./parameters";
import {ContractDeploymentInfo, ObjectSerializer} from "@smartbonds/smartbonds-contract-model";

/* --- Define interfaces needed for contract management ---------- */

interface ContractAndParams {
    contract: ContractJson;
    params?: SerializedParameters[];
}

const TEST_TRANSACTION_HASH = "0x9999999999999999999999999999999999999999999999999999999999999999";
const TEST_CONTRACT_MGR_ADDR = "0x9999999999999999999999999999999999999999"

/**
 * Sign and deploy the smart contract.
 *
 * @param rpcURL The URL of the RPC provide to use to deploy
 * @param contractJson The JSON containing the ABI and bytecode for the contract to deploy
 * @param parameters The parameters to pass to the constructor of the contract
 * @param gasLimit The gas limit to use for deployment
 * @return The transaction has for the contract deployment.
 */
async function signAndDeploy(
    rpcURL: string,
    gasLimit: bigint,
    contractJson: ContractJson,
    parameters: ContractParameter[])
{
    const rpcProvider = new ethers.JsonRpcProvider(`${rpcURL}${INFURA_KEY}`);
    const wallet = new ethers.Wallet(SIGNING_KEY!, rpcProvider);

    // ContractFactory to generate a contract
    const factory = new ethers.ContractFactory(contractJson.abi, contractJson.bytecode, wallet);
    const contract = await factory.deploy(...parameters, {gasLimit: gasLimit});
    await contract.waitForDeployment();

    const tx = contract.deploymentTransaction();
    if (!tx) {
       throw Error("Could not retrieve transaction hash")
    } else {
        return tx.hash;
    }
}

enum DBStatus { proceed, success, failed, timeout, hardfail, nocontract, failed_deploy, executed }

interface DBResult {
    status: DBStatus;
    requestId ?: number;
}

const DB_CHECK_RETRIES = Number(process.env.DB_CHECK_RETRIES) || 10; // Number of times to retry the DB for an update to the status
const DB_CHECK_WAIT = Number(process.env.DB_CHECK_WAIT) || 50; // Number of milliseconds to wait before rechecking the DB.

async function dbCheck(
    connection: PoolClient, chainId: bigint,
    contractMgrAddr: string, contractId: string,
    gasLimit: bigint
): Promise<DBResult> {

    // First we do an immediate INSERT and see what gives.
    try {
        const query = `SELECT id from contract_payloads where contract_id = $1`;
        const queryResult = await connection.query(query, [contractId]);

        if (queryResult.rowCount != 0) {
            const payloadId = queryResult.rows[0].id as number;
            const insert = `
                INSERT INTO contract_deployment_requests(chain_id, contract_mgr_addr, payload_id, gas_limit, status) 
                VALUES ($1, $2, $3, $4, $5) RETURNING id`;
            const insertResult = await connection.query(insert, [chainId, contractMgrAddr, payloadId, gasLimit, 'requesting']);

            if (insertResult.rowCount == 0) {
                console.log("Got zero row count on INSERT -unexpected!");
                return { status: DBStatus.hardfail };
            } else {
                const id = insertResult.rows[0].id as number;

                return {
                    status: DBStatus.proceed,
                    requestId: id
                }
            }
        } else {
            return { status: DBStatus.nocontract };
        }
    } catch (err: any) {
        // We roll back asd in this scenario no further DB updates should be required
        // and the insert failed
        await connection.query("ROLLBACK");
        if (err.code === "23505") {
            console.info("Got expected duplicate error insert - another thread might be working on this");
            let counter = 0;

            while (counter < DB_CHECK_RETRIES) {
                const query = `SELECT r.status FROM contract_deployment_requests r, contract_payloads p
                    WHERE r.chain_id=$1 AND p.contract_id=$2 AND r.payload_id=p.id`;
                const queryResult = await connection.query(query, [chainId, contractId]);

                // If the rowcount is all of a sudden 0, it means the row was rolled back.
                // then we return a fail.
                if (queryResult.rowCount == 0) {
                    return { status: DBStatus.failed };
                } else {
                    const status = queryResult.rows[0].status;

                    // TODO - we may want to check is the initial insert was a long time ago.
                    if (status !== 'requesting') {
                        return { status: DBStatus.success };
                    }
                }
                await new Promise(resolve => setTimeout(resolve, DB_CHECK_WAIT));
                counter++;
            }
            return { status: DBStatus.timeout };
        } else {
            console.log("Unexpected error", JSON.stringify(err));
            return { status: DBStatus.hardfail };
        }
    }
}

async function updateDB(connection: PoolClient, requestId: number, status: DBStatus, txHash ?: string) {
    try {
        let     dbStatus: string;

        switch (status) {
            case DBStatus.success:
                dbStatus = "requested";
                break;
            case DBStatus.executed:
                dbStatus = "executed";
                break;
            case DBStatus.failed_deploy:
                dbStatus = "failed_deployment";
                break;
            default:
                console.error("Unexpected status " + status);
                return false;
        }
        let update: string;
        let params;

        if (txHash) {
            update = `UPDATE contract_deployment_requests
                            SET status=$1, tx_hash = $2
                            WHERE id = $3`;
            params = [dbStatus, txHash, requestId];
        } else {
            update = `UPDATE contract_deployment_requests
                            SET status=$1
                            WHERE id = $2`;
            params = [dbStatus, requestId];
        }
        const updateResult = await connection.query(update, params);

        if (updateResult.rowCount == 0) {
            console.error(`Couldn't update the DB record for ${requestId} - No Record count!`);
            return false;
        }
    } catch (err) {
        console.error(`Couldn't update the DB record for ${requestId}!`, err);
        return false;
    }
    return true;
}

/**
 * Deployment request API. This API requests the deployment of a contract which
 * is logged in the DB and sent for execution through a Google Cloud task
 * Note that this function can be passed a fake request in which case a fake
 * message ID is sent back. The fake message ID is 99999999.
 *
 * @param req See the swagger of the API contract for the details
 * @param res See the swagger of the API contract for the details
 */
export async function requestDeployContract(req: Request, res: Response) {
    const chainId = req.body.chainId ? BigInt(req.body.chainId) : undefined;
    const contractMgrAddr = req.body.contractMgrAddr;
    const contractId = req.body.contractId;
    const gasLimitReq = req.body.gasLimit || process.env.DEPLOYMENT_GAS_LIMIT || "0";

    if (!chainId || !contractMgrAddr || !contractId)  {
        res.status(400).send("Missing parameter");
        return;
    }
    const gasLimit = BigInt(gasLimitReq);

    const connection = await getConnection();
    try {
        await connection.query("BEGIN"); // Begin the transaction.
        const result = await dbCheck(connection, chainId, contractMgrAddr, contractId, gasLimit);

        switch (result.status) {
            case DBStatus.proceed: {
                const taskClient = new CloudTasksClient();
                const body = {
                    requestId: result.requestId
                }
                const bodyBuffer = Buffer.from(JSON.stringify(body)).toString("base64");
                const task = {
                    httpRequest: {
                        httMethod: "POST",
                        url: TASK_REQUEST_URL,
                        oidcToken: {
                            serviceAccountEmail: SERVICE_ACCOUNT,
                            audience: TASK_AUDIENCE
                        },
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: bodyBuffer
                    }
                }

                try {
                    const taskParent = taskClient.queuePath(PROJECT_ID!, PROJECT_REGION!, CONTRACT_QUEUE!);
                    const response = await taskClient.createTask({
                        parent: taskParent,
                        task: task
                    });
                    if (response) {
                        if (await updateDB(connection, result.requestId!, DBStatus.success)) {
                            await connection.query("COMMIT");
                            console.log("Task creation completed successfully!!!"); // TODO - Remove
                            res.status(200).send();
                        } else {
                            await connection.query("ROLLBACK");
                            res.status(500).send();
                        }
                    } else {
                        await connection.query("ROLLBACK");
                        res.status(500).send();
                    }
                } catch (err) {
                    console.error("Could not create a task request to execute the deployment: ", err);
                    await connection.query("ROLLBACK"); // Begin the transaction.
                    res.status(500).send();
                } finally {
                    await taskClient.close();
                }
                break;
            }
            case DBStatus.failed:
                res.status(422).send({
                    code: "SBC-002",
                    message: "Request failed!"
                });
                break;
            case DBStatus.nocontract:
                res.status(422).send({
                    code: "SBC-003",
                    message: "No contract exists with ID - " + contractId
                });
                break;
            case DBStatus.timeout:
            case DBStatus.hardfail:
                res.status(500).send();
                break;
            case DBStatus.success:
                res.status(200).send();
                break;
        }
    } catch(requestErr) {
        console.error("Contract deployment failed: ", requestErr);
        await connection.query("ROLLBACK"); // Begin the transaction.
        res.status(500).send();
    } finally {
        connection.release();
    }
}

/**
 * Contract payload setup function, which is meant to be called
 * from the web client. THis passes along the payload. Reason we do this
 * via web client is to avoid overhead of passing payload into the contracts.
 *
 * @param req See the swagger of the API contract for the details
 * @param res See the swagger of the API contract for the details
 */
export async function prepareContract(req: Request, res: Response) {
    const contractData = req.body.contractData;
    const contractId = req.body.contractId;

    if (!contractData || !contractId)  {
        res.status(400).send("Missing parameter");
        return;
    }
    // Validate if the contract contracts passed matches what we expect
    try {
        const contractZip = Buffer.from(contractData, 'base64')
        const contractJson = Buffer.from(inflate(contractZip)).toString();

        JSON.parse(contractJson) as ContractAndParams;
    } catch {
        res.status(400).send("Invalid payload");
    }
    // Check if this was a test payload without a real contract
    // If that is the case we return right away with a fake transaction hash.
    const connection = await getConnection();
    try {
        const insert = `INSERT INTO contract_payloads(contract_id, payload) VALUES ($1, $2)`;
        const insertResult = await connection.query(insert, [contractId, contractData]);

        if (insertResult.rowCount == 0) {
            res.status(500).send();
        } else {
            res.status(200).send();
        }
    } catch (err: any) {
        if (err.code === "23505") {
            // TODO - We should check if payload is the same and if so we just return 200.
            const query = `SELECT payload FROM contract_payloads WHERE contract_id = $1`;
            const queryResult = await connection.query(query, [contractId]);

            if (queryResult.rowCount != 0) {
                if (queryResult.rows[0].payload === contractData) {
                    res.status(200).send();
                } else {
                    res.status(422).send({
                        code: "SBC-001",
                        message: "Contract ID exists"
                    });
                }
            } else {
                res.status(500).send();
            }
        }
    } finally {
        connection.release();
    }
}


export async function deployContract(req: Request, res: Response) {
    const requestId = req.body.requestId;

    if (!requestId)  {
        res.status(400).send("Missing parameter");
        return;
    }
    let contractObject: ContractAndParams;
    // We're not in test mode and have parsed everything now we deploy
    const connection = await getConnection();
    try {
        // First we retrieve the request details.
        const reqQuery = `
                SELECT r.chain_id, r.contract_mgr_addr, r.status, r.gas_limit, p.payload, p.contract_id 
                FROM contract_deployment_requests r, contract_payloads p 
                WHERE r.id = $1 AND r.payload_id = p.id
        `;
        const reqQueryResult = await connection.query(reqQuery, [requestId])

        if (reqQueryResult.rowCount != 0) {
            const chainId = BigInt(reqQueryResult.rows[0].chain_id);
            const gasLimit = BigInt(reqQueryResult.rows[0].gas_limit);
            const contractMgrAddr = reqQueryResult.rows[0].contract_mgr_addr;
            const status = reqQueryResult.rows[0].status;
            const contractData = reqQueryResult.rows[0].payload;
            const contractId = reqQueryResult.rows[0].contract_id;
            const networkInfo = KNOWN_NETWORKS.get(chainId);
            const rpcURL = networkInfo?.rpcUrl;
            let resultHash: string;

            if (status === "requesting" || status === "executed") {
                // If the status is either one of the above we are not in a proper state to deploy.
                console.error("Invalid state: " + status)
                res.status(400).send("Invalid state");
                return;
            }
            if (!rpcURL) {
                console.error("Unknown chain ID: " + chainId);
                res.status(400).send("Unknown chain ID");
                return;
            }
            try {
                const contractZip = Buffer.from(contractData, 'base64')
                const contractJson = Buffer.from(inflate(contractZip)).toString();

                contractObject = JSON.parse(contractJson) as ContractAndParams;
                // Check if this was a test payload without a real contract
                // If that is the case we return right away with a fake transaction hash.
                if (contractObject.contract.abi === "TEST") {
                    console.log("Handling a test contract, this will not be deployed!!!");
                    resultHash = TEST_TRANSACTION_HASH;
                } else {
                    const contractParams: ContractParameter[] = contractObject.params ? simpleDeserializeParams(contractObject.params) : [];

                    try {
                        resultHash = await signAndDeploy(rpcURL, gasLimit, contractObject.contract, contractParams);
                    } catch (deployErr) {
                        const txHash = (deployErr as any).receipt.hash;

                        console.error("Failed to deploy:", deployErr);
                        await updateDB(connection, requestId, DBStatus.failed_deploy, txHash);
                        return;
                    }
                }
                // Now wew update the DB.
                await updateDB(connection, requestId, DBStatus.executed, resultHash);
                if (TEST_CONTRACT_MGR_ADDR === contractMgrAddr) {
                    console.log("Received test address for contract manager")
                    res.status(200).send();
                    return;
                }

                // Update the contract manager with the transaction hash.
                try {
                    const rpcProvider = new ethers.JsonRpcProvider(`${rpcURL}${INFURA_KEY}`);
                    const wallet = new ethers.Wallet(SIGNING_KEY!, rpcProvider);

                    // ContractFactory to generate a contract
                    const contractMgr = new ethers.Contract(contractMgrAddr, CONTRACT_MANAGER_DEF.abi, wallet);
                    const txResponse = await contractMgr.notifyDeploymentFullfilled(contractId, resultHash, {gasLimit: gasLimit})

                    if (txResponse) {
                        await txResponse.wait();
                    }
                    res.status(200).send();
                } catch (errNotify) {
                    console.error("Could not update contract manager: ", errNotify);
                    res.status(500).send();
                }
            } catch (errUnzip) {
                console.error("Could not decompress encoded / zipped payload - should not happen: ", errUnzip);
                res.status(400).send("Invalid Payload");
            }
        } else {
            res.status(404).send("Request not found");
        }
    } catch(err) {
        console.error("Contract deployment failed: ", err);
        res.status(500).send();
    } finally {
        connection.release();
    }
}

export async function getContractInfo(req: Request, res: Response) {
    const contractId = req.body.contractId;

    if (!contractId) {
        res.status(400).send("Missing parameter");
        return;
    }
    const connection = await getConnection();
    try {
        // First we retrieve the request details.
        const reqQuery = `
            SELECT r.chain_id as "chainId", r.contract_mgr_addr as "contractMgrAddr", 
                   r.status as "status", r.gas_limit as "gasLimit", r.tx_hash as "txHash"
            FROM contract_deployment_requests r,
                 contract_payloads p
            WHERE p.contract_id = $1
              AND r.payload_id = p.id
        `;
        const queryResult = await connection.query<ContractDeploymentInfo>(reqQuery, [contractId]);

        if (queryResult.rowCount == 0) {
            res.status(404).send("Contract not found");
        } else {
            const info =  queryResult.rows[0];

            console.log(`status = ${info.status}, chainId = ${info.chainId}, txHash = ${info.txHash}`);
            res.status(200).send(ObjectSerializer.serialize(info, ContractDeploymentInfo.name));
        }
    } catch (err) {
        console.error("Something went wrong while trying to query the contract data: ", err);
        res.status(500).send();
    } finally {
        connection.release();
    }
}