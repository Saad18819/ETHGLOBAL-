import { createConfig, http } from "wagmi";
import {
  arbitrumSepolia,
  arcTestnet,
  avalancheFuji,
  baseSepolia,
  mainnet,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  unichainSepolia,
} from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const ARC_RPC = "https://rpc.testnet.arc.network";

const chains = [
  arcTestnet,
  baseSepolia,
  sepolia,
  polygonAmoy,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
  unichainSepolia,
  mainnet,
] as const;

export function getConfig() {
  return createConfig({
    chains,
    connectors: [injected()],
    ssr: true,
    transports: {
      [arcTestnet.id]: http(ARC_RPC),
      [baseSepolia.id]: http(),
      [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
      [polygonAmoy.id]: http("https://polygon-amoy-bor-rpc.publicnode.com"),
      [arbitrumSepolia.id]: http(),
      [optimismSepolia.id]: http(),
      [avalancheFuji.id]: http(),
      [unichainSepolia.id]: http(),
      [mainnet.id]: http(),
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
