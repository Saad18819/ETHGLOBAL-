import { arcSwappable } from "./tokens";

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
