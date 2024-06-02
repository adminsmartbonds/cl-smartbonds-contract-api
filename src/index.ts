import {deployContract, requestDeployContract, prepareContract, getContractInfo} from "./contract";
import {CorsOptions, HttpMethod, setupAuthPath, setupExpress, setupNoAuthPath} from "@smartbonds/smartbonds-api-lib";

export const smartbonds_contract_api = setupExpress(setup);

// TODO - Add trace ID middleware to the chain of middleware.
// TODO - I should probably be more stringent in what I allow in for CORS. Make it configurable.
function setup() {
    const permissiveCors: CorsOptions = {
        methods: "POST",
        origin: "*"
    }

    setupAuthPath(HttpMethod.POST, "/contract/prepareContract", 'write:contract', prepareContract);
    setupAuthPath(HttpMethod.POST, "/contract/getContractInfo", 'read:contract', getContractInfo);
    setupNoAuthPath(HttpMethod.POST, "/contract/requestDeployContract", requestDeployContract, permissiveCors);
    // TODO - the next item is called internally, may not require permissive cors.
    setupNoAuthPath(HttpMethod.POST, "/contract/deployContract", deployContract);
}
