import type { Address, Chain } from "viem";
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  unichainSepolia,
} from "viem/chains";

export type SourceId = "base" | "ethereum" | "polygon" | "arbitrum" | "optimism" | "avalanche" | "unichain";

/// Token addresses on a source chain; "native" is the gas token. From developers.circle.com/stablecoins.
export type Tokens = Partial<Record<"USDC" | "EURC" | "ETH" | "WETH" | "cirBTC", Address | "native">>;

export type Source = {
  label: string;
  chain: Chain;
  /// Chain identifier in Circle App Kit.
  kitChain: string;
  cctpDomain: number;
  tokens: Tokens;
  /// Chains with a CCIP lane to Arc run the whole flow through our router and settlement contract.
  router?: { address?: Address; usdc: Address; nativeSymbol: string; explorer: string };
};

export const sources: Record<SourceId, Source> = {
  base: {
    label: "Base",
    chain: baseSepolia,
    kitChain: "Base_Sepolia",
    cctpDomain: 6,
    tokens: {
      USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      EURC: "0x808456652fdb597867f38412077A9182bf77359F",
    },
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
    tokens: {
      USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      EURC: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
      ETH: "native",
      WETH: "0xfFf9976782d46CC05630D1f6eBAB18b2324d6B14",
      cirBTC: "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3",
    },
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
    tokens: { USDC: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
    router: {
      address: process.env.NEXT_PUBLIC_ROUTER_POLYGON as Address | undefined,
      usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      nativeSymbol: "POL",
      explorer: "https://amoy.polygonscan.com",
    },
  },
  arbitrum: {
    label: "Arbitrum",
    chain: arbitrumSepolia,
    kitChain: "Arbitrum_Sepolia",
    cctpDomain: 3,
    tokens: { USDC: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  },
  optimism: {
    label: "Optimism",
    chain: optimismSepolia,
    kitChain: "Optimism_Sepolia",
    cctpDomain: 2,
    tokens: { USDC: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  },
  avalanche: {
    label: "Avalanche",
    chain: avalancheFuji,
    kitChain: "Avalanche_Fuji",
    cctpDomain: 1,
    tokens: {
      USDC: "0x5425890298aed601595a70AB815c96711a31Bc65",
      EURC: "0x5E44db7996c682E92a960b65AC713a54AD815c6B",
    },
  },
  unichain: {
    label: "Unichain",
    chain: unichainSepolia,
    kitChain: "Unichain_Sepolia",
    cctpDomain: 10,
    tokens: { USDC: "0x31d0220469e10c4E71834a79b1f276d740d3768F" },
  },
};

export const sourceIds = Object.keys(sources) as SourceId[];

/// Rough CCTP arrival times. Standard waits for finality on the source chain, which for L2s means Ethereum.
export const arrival = (fast: boolean) => (fast ? "under a minute" : "about 15 to 20 minutes");
