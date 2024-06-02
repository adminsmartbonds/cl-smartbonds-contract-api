import {ethers} from "ethers";

// TODO - this logic is shared by the spa and the contract API
// it should be externalized in its own library.

export interface SerializedParameters {
    type: string;
    value: string | undefined | SerializedParameters[];
}

export enum ContractType {_, bigint, uint, int, address, boolean, string, number}
export interface ParamMapping {
    name: string;
    type: ContractType | ParamMapping[];
}
export type ContractParameter =  string | number | boolean | bigint | ContractParameter[];

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getType(defaultType: string, type: ContractType | ParamMapping[] | undefined) {
    if (type) {
        switch (type) {
            case ContractType.address:
                return "address";
            case ContractType.boolean:
                return "boolean";
            case ContractType.bigint:
                return "bigint";
            case ContractType.number:
                return "number";
            case ContractType.int:
                return "int";
            case ContractType.string:
                return "string";
            case ContractType.uint:
                return "uint";
            default:
                return defaultType;
        }
    }
    return defaultType;
}

export function simpleSerializeParams(obj: object, paramMap?: ParamMapping[]) {
    const result: SerializedParameters[] = [];
    const keyList = paramMap ? paramMap.map(mapping => mapping.name) : Object.keys(obj);
    let i = 0;

    for (const key of keyList) {
        // @ts-expect-error: The next element has to be of type any for this to work
        const prop = obj[key];
        const type = paramMap?.[i++].type;

        if (prop === undefined) {
            result.push({
                type: getType("undefined", type),
                value: undefined
            });
        } else if (typeof(prop) === "string") {
            result.push({
                type: getType( "string", type),
                value: prop as string
            });
        } else if (typeof(prop) === "number") {
            result.push({
                type: getType("number", type),
                value: (prop as number).toString()
            });
        } else if (typeof(prop) === "boolean") {
            result.push({
                type: getType("boolean", type),
                value: (prop as boolean).toString()
            });
        } else if (typeof(prop) === "bigint") {
            result.push({
                type: getType("bigint", type),
                value: (prop as bigint).toString()
            });
        } else if (typeof(prop) === "object") {
            if (type instanceof Array) {
                result.push({
                    type: "object",
                    value: simpleSerializeParams(prop as object, type as ParamMapping[])
                });
            } else {
                result.push({
                    type: "object",
                    value: simpleSerializeParams(prop as object)
                });
            }
        }
    }
    return result;
}


export function simpleDeserializeParams(serialized: SerializedParameters[]) {
    const resultArray: ContractParameter[] = [];

    for (const param of serialized) {
        const val = param.value;

        switch (param.type) {
            // The 3 following case statements are here for backward compatibility
            case "ether":
                resultArray.push(val ? ethers.parseEther(param.value as string) : 0n);
                break;
            case "uint":
                resultArray.push(val ? ethers.getUint(val as string) : 0n);
                break;
            case "int":
                resultArray.push(val ? ethers.getBigInt(val as string) : 0n);
                break;
            case "address":
                resultArray.push(val ? val as string : ZERO_ADDRESS);
                break;
            case "string":
                resultArray.push(val ? val as string : "");
                break;
            case "undefined":
                // This is really a catch all, shouldn't happen.
                // The caller should have used a typeList during serialization
                resultArray.push("");
                break;
            case "bigint":
                resultArray.push(val ? BigInt(val as string) : 0n);
                break;
            case "boolean":
                resultArray.push(val ? (val as string) == 'true' : false);
                break;
            case "number":
                resultArray.push(val ? Number(val as string) : 0);
                break;
            case "object":
                resultArray.push(simpleDeserializeParams(param.value as SerializedParameters[]));
                break;
        }
    }
    return resultArray;
}
