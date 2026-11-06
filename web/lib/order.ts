import { encodeAbiParameters, getAbiItem, keccak256, type AbiParameterToPrimitiveType, type Address, type Hex } from "viem";

import { routerAbi } from "./contracts";

const send = getAbiItem({ abi: routerAbi, name: "send" });

/// An intent as the router's send takes it.
export type IntentValue = AbiParameterToPrimitiveType<(typeof send.inputs)[0]>;

/// Orders on Arc are keyed by the hash of the whole intent, as the router fills it in. Kept free of
/// wallet and kit code so server routes can use it too.
export function orderKey(intent: IntentValue, id: Hex, payer: Address): Hex {
  return keccak256(encodeAbiParameters([send.inputs[0]], [{ ...intent, id, payer }]));
}
