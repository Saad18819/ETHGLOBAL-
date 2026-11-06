import type { Address, Chain } from "viem";
import {
  arbitrum,
  arc,
  arcTestnet,
  arbitrumSepolia,
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
} from "viem/chains";

import { isTestnet } from "./network";

/// Every chain a move can start from or end on. Arc is both: moves land there by default, and money on
/// Arc can go out to any of the others.
export type SourceId = "base" | "ethereum" | "polygon" | "arbitrum" | "optimism" | "avalanche" | "unichain" | "arc";

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
const mainnetSources: Record<SourceId, Source> = {
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
  arc: { label: "Arc", chain: arc, kitChain: "Arc", cctpDomain: 26, explorer: "https://explorer.arc.io" },
};

/// The same chains' testnets, with the same Circle domains.
const testnetSources: Record<SourceId, Source> = {
  base: {
    label: "Base",
    chain: baseSepolia,
    kitChain: "Base_Sepolia",
    cctpDomain: 6,
    explorer: "https://sepolia.basescan.org",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_BASE as Address | undefined,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      nativeSymbol: "ETH",
    },
  },
  ethereum: {
    label: "Ethereum",
    chain: sepolia,
    kitChain: "Ethereum_Sepolia",
    cctpDomain: 0,
    explorer: "https://sepolia.etherscan.io",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_ETHEREUM as Address | undefined,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      nativeSymbol: "ETH",
    },
  },
  polygon: {
    label: "Polygon",
    chain: polygonAmoy,
    kitChain: "Polygon_Amoy_Testnet",
    cctpDomain: 7,
    explorer: "https://amoy.polygonscan.com",
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_POLYGON as Address | undefined,
      usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      nativeSymbol: "POL",
    },
  },
  arbitrum: {
    label: "Arbitrum",
    chain: arbitrumSepolia,
    kitChain: "Arbitrum_Sepolia",
    cctpDomain: 3,
    explorer: "https://sepolia.arbiscan.io",
  },
  optimism: {
    label: "Optimism",
    chain: optimismSepolia,
    kitChain: "Optimism_Sepolia",
    cctpDomain: 2,
    explorer: "https://sepolia-optimism.etherscan.io",
  },
  avalanche: {
    label: "Avalanche",
    chain: avalancheFuji,
    kitChain: "Avalanche_Fuji",
    cctpDomain: 1,
    explorer: "https://testnet.snowtrace.io",
  },
  unichain: {
    label: "Unichain",
    chain: unichainSepolia,
    kitChain: "Unichain_Sepolia",
    cctpDomain: 10,
    explorer: "https://sepolia.uniscan.xyz",
  },
  arc: { label: "Arc", chain: arcTestnet, kitChain: "Arc_Testnet", cctpDomain: 26, explorer: "https://explorer.testnet.arc.io" },
};

export const sources = isTestnet ? testnetSources : mainnetSources;

export const sourceIds = Object.keys(sources) as SourceId[];

/// Chains other than Arc, where a move starts when it heads to Arc.
export const offArc = sourceIds.filter((id) => id !== "arc");

/// Rough CCTP arrival times. Standard waits for finality on the source chain, which for L2s means Ethereum.
export const arrival = (fast: boolean) => (fast ? "under a minute" : "about 15 to 20 minutes");
