import fs from "node:fs";

export interface ContractJson {
    bytecode: string;
    abi: string;
}

const CONTRACT_MANAGER_JSON_LOCATION = "src/contracts/SBAbstractFunctionsContractManager.json";
export const CONTRACT_MANAGER_DEF = JSON.parse(fs.readFileSync(CONTRACT_MANAGER_JSON_LOCATION, 'utf8')) as ContractJson;

/* --- Initialize the various constants we'll need in our function ---------- */

export const INFURA_KEY = process.env.INFURA_API_KEY;
if (!INFURA_KEY) {
    throw Error("INFURA API key not defined!");
}

export const SIGNING_KEY = process.env.SIGNING_KEY;
if (!SIGNING_KEY) {
    throw Error("Signing key not defined!");
}

export const TASK_REQUEST_URL = process.env.TASK_REQUEST_URL;
if (!TASK_REQUEST_URL) {
    throw Error("Task URL not defined!");
}

export const TASK_AUDIENCE = process.env.TASK_AUDIENCE;
if (!TASK_AUDIENCE) {
    throw Error("Task Audience - which you get from Cloud Run Function URL - not defined!");
}

export const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT_ID) {
    throw Error("Project ID not defined !");
}

export const PROJECT_REGION = process.env.GOOGLE_FUNCTION_REGION;
if (!PROJECT_REGION) {
    throw Error("Project Region not defined !");
}

export const SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
if (!SERVICE_ACCOUNT) {
    throw Error("Service Account not defined !");
}

export const CONTRACT_QUEUE = process.env.SMARTBONDS_CONTRACT_QUEUE;
if (!CONTRACT_QUEUE) {
    throw Error("Contract Deployment Task Queue not defined !");
}

interface BlockchainNetworkDefinition {
    chainId: string;
    routerAddress: string;
    donId: string;
    rpcUrl: string;
    contractManagerAddress: string;
}

function readKnownNetworks() {
    const knownNetworksEnv = process.env.KNOWN_NETWORKS;
    const result = new Map<bigint, BlockchainNetworkDefinition>;
    if (knownNetworksEnv) {
        try {
            const networkJSONArray = JSON.parse(knownNetworksEnv) as BlockchainNetworkDefinition[];

            for (const network of networkJSONArray) {
                result.set(BigInt(network.chainId), network);
            }
        } catch(err) {
            console.error("Could not read Network Definitions: ", err);
            throw Error("Error in the Network Definitions:");
        }
    }
    return result;
}

export const KNOWN_NETWORKS = readKnownNetworks();

