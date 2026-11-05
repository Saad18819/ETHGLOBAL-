import { createConfig, http } from "wagmi";
import { arcTestnet, baseSepolia, mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const ARC_RPC = "https://rpc.testnet.arc.network";

export function getConfig() {
  return createConfig({
    chains: [baseSepolia, arcTestnet, sepolia, mainnet],
    connectors: [injected()],
    ssr: true,
    transports: {
      [baseSepolia.id]: http(),
      [arcTestnet.id]: http(ARC_RPC),
      [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
      [mainnet.id]: http(),
    },
  });
}

export const config = getConfig();

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}
