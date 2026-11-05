import type { Address, Chain } from "viem";
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  inkSepolia,
  lineaSepolia,
  monadTestnet,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  sonicTestnet,
  unichainSepolia,
  worldchainSepolia,
} from "viem/chains";

export type SourceId =
  | "base"
  | "ethereum"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "avalanche"
  | "unichain"
  | "linea"
  | "worldchain"
  | "ink"
  | "sonic"
  | "monad";

export type Source = {
  label: string;
  chain: Chain;
  /// Chain identifier in Circle App Kit.
  kitChain: string;
  cctpDomain: number;
  /// Chains with a CCIP lane to Arc run the whole flow through our router and settlement contract.
  router?: { address?: Address; usdc: Address; nativeSymbol: string; explorer: string };
};

export const sources: Record<SourceId, Source> = {
  base: {
    label: "Base",
    chain: baseSepolia,
    kitChain: "Base_Sepolia",
    cctpDomain: 6,
    router: {
      address: (process.env.NEXT_PUBLIC_ROUTER_BASE ?? process.env.NEXT_PUBLIC_ROUTER) as Address | undefined,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      nativeSymbol: "ETH",
      explorer: "https://sepolia.basescan.org",
    },
  },
  ethereum: {
    label: "Ethereum",
    chain: sepolia,
    kitChain: "Ethereum_Sepolia",
    cctpDomain: 0,
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_ETHEREUM as Address | undefined,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      nativeSymbol: "ETH",
      explorer: "https://sepolia.etherscan.io",
    },
  },
  polygon: {
    label: "Polygon",
    chain: polygonAmoy,
    kitChain: "Polygon_Amoy_Testnet",
    cctpDomain: 7,
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_POLYGON as Address | undefined,
      usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      nativeSymbol: "POL",
      explorer: "https://amoy.polygonscan.com",
    },
  },
  arbitrum: { label: "Arbitrum", chain: arbitrumSepolia, kitChain: "Arbitrum_Sepolia", cctpDomain: 3 },
  optimism: { label: "Optimism", chain: optimismSepolia, kitChain: "Optimism_Sepolia", cctpDomain: 2 },
  avalanche: { label: "Avalanche", chain: avalancheFuji, kitChain: "Avalanche_Fuji", cctpDomain: 1 },
  unichain: { label: "Unichain", chain: unichainSepolia, kitChain: "Unichain_Sepolia", cctpDomain: 10 },
  linea: { label: "Linea", chain: lineaSepolia, kitChain: "Linea_Sepolia", cctpDomain: 11 },
  worldchain: { label: "World Chain", chain: worldchainSepolia, kitChain: "World_Chain_Sepolia", cctpDomain: 14 },
  ink: { label: "Ink", chain: inkSepolia, kitChain: "Ink_Testnet", cctpDomain: 21 },
  sonic: { label: "Sonic", chain: sonicTestnet, kitChain: "Sonic_Testnet", cctpDomain: 13 },
  monad: { label: "Monad", chain: monadTestnet, kitChain: "Monad_Testnet", cctpDomain: 15 },
};

export const sourceIds = Object.keys(sources) as SourceId[];

/// Rough CCTP arrival times. Standard waits for finality on the source chain, which for L2s means Ethereum.
export const arrival = (fast: boolean) => (fast ? "under a minute" : "about 15 to 20 minutes");
