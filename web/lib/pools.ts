import { useQuery } from "@tanstack/react-query";
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { readContract } from "wagmi/actions";

import { config } from "./config";
import { arc } from "./contracts";
import type { AssetId } from "./plan";
import { pools, type PoolPair } from "./pairs";
import { tokenBySymbol } from "./tokens";

export { pools, type PoolPair } from "./pairs";

export const poolById = (id: string) => pools.find((pool) => pool.id === id) ?? pools[0];

/// The v4 pool key: currencies sorted by address, so `a` may be either side.
export function poolKeyOf(pair: PoolPair) {
  const side = (symbol: AssetId) => ({ symbol, address: tokenBySymbol[symbol].arc!, decimals: tokenBySymbol[symbol].decimals });
  const [token0, token1] = [side(pair.a), side(pair.b)].sort((x, y) =>
    x.address.toLowerCase() < y.address.toLowerCase() ? -1 : 1,
  );
  const key = {
    currency0: token0.address as Address,
    currency1: token1.address as Address,
    fee: pair.fee,
    tickSpacing: pair.tickSpacing,
    hooks: zeroAddress as Address,
  };
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
  return { key, id: id as Hex, token0, token1 };
}

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

export type PoolState = {
  pair: PoolPair;
  /// Whether anyone has opened the pool on Arc yet.
  exists: boolean;
  /// Square root of the raw price of token0 in token1, as a float.
  sqrtPrice: number;
  tick: number;
  /// How many of `b` one `a` buys at the pool price.
  price: number;
  /// In-range liquidity valued in USD, from market prices.
  depthUsd: number;
};

async function readPool(pair: PoolPair, prices: Record<string, number>): Promise<PoolState> {
  const { id, token0, token1 } = poolKeyOf(pair);
  const target = { chainId: arc.chainId, address: STATE_VIEW, abi: stateViewAbi, args: [id] } as const;
  const [[sqrtPriceX96, tick], liquidity] = await Promise.all([
    readContract(config, { ...target, functionName: "getSlot0" }),
    readContract(config, { ...target, functionName: "getLiquidity" }),
  ]);
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  // token1 per token0 in whole units.
  const price01 = sqrtPrice * sqrtPrice * 10 ** (token0.decimals - token1.decimals);
  const amount0 = sqrtPrice > 0 ? Number(liquidity) / sqrtPrice / 10 ** token0.decimals : 0;
  const amount1 = (Number(liquidity) * sqrtPrice) / 10 ** token1.decimals;
  return {
    pair,
    exists: sqrtPriceX96 > 0n,
    sqrtPrice,
    tick,
    price: token0.symbol === pair.a ? price01 : price01 > 0 ? 1 / price01 : 0,
    depthUsd: amount0 * (prices[token0.symbol] ?? 0) + amount1 * (prices[token1.symbol] ?? 0),
  };
}

export function usePoolState(pair: PoolPair, prices: Record<string, number> | undefined) {
  return useQuery({
    queryKey: ["pool-state", pair.id, Boolean(prices)],
    queryFn: () => readPool(pair, prices ?? {}),
    refetchInterval: 30_000,
  });
}

/// sqrtPriceX96 that opens a pool at the market: token1 per token0 from USD prices, in raw units.
export function marketSqrtPriceX96(pair: PoolPair, prices: Record<string, number>): bigint {
  const { token0, token1 } = poolKeyOf(pair);
  const raw = (prices[token0.symbol] / prices[token1.symbol]) * 10 ** (token1.decimals - token0.decimals);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error(`No market price for ${pair.id}`);
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
}
