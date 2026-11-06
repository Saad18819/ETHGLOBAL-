import type { Address, Chain } from "viem";
import { arbitrum, avalanche, base, mainnet, optimism, polygon, unichain } from "viem/chains";

export type SourceId = "base" | "ethereum" | "polygon" | "arbitrum" | "optimism" | "avalanche" | "unichain";

export type Source = {
  label: string;
  chain: Chain;
  /// Chain identifier in Circle App Kit.
  kitChain: string;
  cctpDomain: number;
  explorer: string;
  /// Chains with a CCIP lane to Arc can run the whole flow through our router and settlement contract,
  /// once the router is deployed there.
  router?: { address?: Address; usdc: Address; nativeSymbol: string };
};

/// Mainnet source chains. USDC addresses from developers.circle.com/stablecoins/usdc-contract-addresses.
export const sources: Record<SourceId, Source> = {
  base: {
    label: "Base",
    chain: base,
    kitChain: "Base",
    cctpDomain: 6,
    explorer: "https://basescan.org",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_BASE as Address | undefined,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      nativeSymbol: "ETH",
    },
  },
  ethereum: {
    label: "Ethereum",
    chain: mainnet,
    kitChain: "Ethereum",
    cctpDomain: 0,
    explorer: "https://etherscan.io",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_ETHEREUM as Address | undefined,
      usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      nativeSymbol: "ETH",
    },
  },
  polygon: {
    label: "Polygon",
    chain: polygon,
    kitChain: "Polygon",
    cctpDomain: 7,
    explorer: "https://polygonscan.com",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_POLYGON as Address | undefined,
      usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      nativeSymbol: "POL",
    },
  },
  arbitrum: { label: "Arbitrum", chain: arbitrum, kitChain: "Arbitrum", cctpDomain: 3, explorer: "https://arbiscan.io" },
  optimism: {
    label: "Optimism",
    chain: optimism,
    kitChain: "Optimism",
    cctpDomain: 2,
    explorer: "https://optimistic.etherscan.io",
  },
  avalanche: { label: "Avalanche", chain: avalanche, kitChain: "Avalanche", cctpDomain: 1, explorer: "https://snowtrace.io" },
  unichain: { label: "Unichain", chain: unichain, kitChain: "Unichain", cctpDomain: 10, explorer: "https://uniscan.xyz" },
};

export const sourceIds = Object.keys(sources) as SourceId[];

/// Rough CCTP arrival times. Standard waits for finality on the source chain, which for L2s means Ethereum.
export const arrival = (fast: boolean) => (fast ? "under a minute" : "about 15 to 20 minutes");
