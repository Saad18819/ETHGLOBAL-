import type { SourceId } from "./chains";
import { isTestnet } from "./network";
import { arcSwappable, tokenBySymbol } from "./tokens";

/// Uniswap v4 pools on Arc the app can add liquidity to. Each side must be something Circle Swap can buy on
/// Arc, so any asset the user moves can be split into the pair. Hookless, at the usual tier for the pair.
/// Plain data, so server routes can use it without loading any wallet code.
const candidates: { a: string; b: string; fee: number; tickSpacing: number }[] = [
  { a: "USDC", b: "EURC", fee: 500, tickSpacing: 10 },
  { a: "USDC", b: "cirBTC", fee: 3000, tickSpacing: 60 },
  { a: "EURC", b: "cirBTC", fee: 3000, tickSpacing: 60 },
  { a: "USDC", b: "WETH", fee: 3000, tickSpacing: 60 },
  { a: "cirBTC", b: "WETH", fee: 3000, tickSpacing: 60 },
];

export type PoolPair = { id: string; a: string; b: string; fee: number; tickSpacing: number };

export const pools: PoolPair[] = candidates
  .filter((pair) => arcSwappable.includes(pair.a) && arcSwappable.includes(pair.b))
  .map((pair) => ({ ...pair, id: `${pair.a}/${pair.b}` }));

/// Each chain's own token, held there through a Uniswap swap from USDC.
const chainTokens: Partial<Record<SourceId, string>> = {
  optimism: "OP",
  arbitrum: "ARB",
  polygon: "POL",
  avalanche: "AVAX",
  unichain: "UNI",
};
/// Tokens with deep Uniswap liquidity on most chains.
const deepTokens = ["ETH", "WETH", "cbBTC", "WBTC", "LINK"];
/// On testnets, only pairs with a Uniswap v4 pool against Circle's USDC that the quoter prices.
const testnetHolds: Partial<Record<SourceId, string[]>> = {
  ethereum: ["ETH", "LINK", "UNI"],
  base: ["ETH"],
  unichain: ["ETH"],
};

/// What a hold can end as on a chain other than Arc beyond USDC and EURC: USDC arrives, and Uniswap on that
/// chain swaps it into the token.
export function destinationHolds(to: SourceId): string[] {
  if (to === "arc") return [];
  if (isTestnet) return testnetHolds[to] ?? [];
  const wanted = [chainTokens[to], ...deepTokens].filter((symbol): symbol is string => Boolean(symbol));
  return wanted.filter((symbol) => tokenBySymbol[symbol]?.sources[to]);
}
