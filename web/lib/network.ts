/// Which network transactions run on. Market numbers always come from mainnet; transactions run on testnet
/// unless NEXT_PUBLIC_NETWORK is "mainnet".
export type Network = "testnet" | "mainnet";

export const network: Network = process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const isTestnet = network === "testnet";

/// Circle's attestation service for the network transactions run on.
export const IRIS = isTestnet ? "https://iris-api-sandbox.circle.com" : "https://iris-api.circle.com";
