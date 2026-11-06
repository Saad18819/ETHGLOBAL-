import { createConfig, http } from "wagmi";
import { arbitrum, arc, avalanche, base, mainnet, optimism, polygon, unichain } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const ARC_RPC = "https://rpc.mainnet.arc.io";

const chains = [arc, base, mainnet, arbitrum, optimism, polygon, avalanche, unichain] as const;

export function getConfig() {
  return createConfig({
    chains,
    connectors: [injected()],
    ssr: true,
    transports: {
      [arc.id]: http(ARC_RPC),
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
