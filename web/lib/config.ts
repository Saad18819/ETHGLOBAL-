import { createConfig, http } from "wagmi";
import {
  arbitrum,
  arbitrumSepolia,
  arc,
  arcTestnet,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from "wagmi/chains";
import { injected } from "wagmi/connectors";

import { isTestnet } from "./network";

export const ARC_RPC = isTestnet ? "https://rpc.testnet.arc.network" : "https://rpc.mainnet.arc.io";
export const arcChain = isTestnet ? arcTestnet : arc;

/// Both networks are registered; the network setting decides which ones the app sends to. Ethereum mainnet
/// is always needed for ENS.
const chains = [
  arcTestnet,
  baseSepolia,
  sepolia,
  polygonAmoy,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
  unichainSepolia,
  arc,
  base,
  mainnet,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  unichain,
] as const;

export function getConfig() {
  return createConfig({
    chains,
    connectors: [injected()],
    ssr: true,
    transports: {
      [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
      [baseSepolia.id]: http(),
      [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
      [polygonAmoy.id]: http("https://polygon-amoy-bor-rpc.publicnode.com"),
      [arbitrumSepolia.id]: http(),
      [optimismSepolia.id]: http(),
      [avalancheFuji.id]: http(),
      [unichainSepolia.id]: http(),
      [arc.id]: http("https://rpc.mainnet.arc.io"),
      [base.id]: http(),
      [mainnet.id]: http("https://ethereum-rpc.publicnode.com"),
      [arbitrum.id]: http(),
      [optimism.id]: http(),
      [polygon.id]: http("https://polygon-bor-rpc.publicnode.com"),
      [avalanche.id]: http(),
      [unichain.id]: http(),
    },
  });
}

export const config = getConfig();

export type ChainId = (typeof chains)[number]["id"];

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}
