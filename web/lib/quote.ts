import { useQuery } from "@tanstack/react-query";
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress } from "viem";
import { readContract } from "wagmi/actions";

import { config } from "./config";
import { arc } from "./contracts";

const stateView = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

/// The USDC/EURC pool the settlement contract swaps through: 0.05% fee, tick spacing 10, no hooks.
export const eurcPool = { fee: 500, tickSpacing: 10 } as const;

const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [arc.usdc, arc.eurc, eurcPool.fee, eurcPool.tickSpacing, zeroAddress],
  ),
);

async function readPool() {
  const target = { chainId: arc.chainId, address: stateView, abi: stateViewAbi, args: [poolId] } as const;
  const [[sqrtPriceX96, tick], liquidity] = await Promise.all([
    readContract(config, { ...target, functionName: "getSlot0" }),
    readContract(config, { ...target, functionName: "getLiquidity" }),
  ]);
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  // Amounts the in-range liquidity is worth at the current price, both tokens with 6 decimals.
  const usdcDepth = Number(liquidity) / sqrtPrice / 1e6;
  const eurcDepth = (Number(liquidity) * sqrtPrice) / 1e6;
  return { rate: sqrtPrice * sqrtPrice, sqrtPrice, tick, liquidity, usdcDepth, eurcDepth };
}

/// The USDC/EURC pool on Arc: EURC per USDC, current tick, and in-range depth.
export function usePool() {
  return useQuery({ queryKey: ["eurc-pool"], queryFn: readPool, refetchInterval: 30_000 });
}

/// EURC per USDC from the pool's spot price.
export function useEurcRate() {
  const pool = usePool();
  return { ...pool, data: pool.data?.rate };
}

/// Tick bounds for a range around the current price, aligned to the pool's tick spacing.
export function rangeTicks(tick: number, percent: number): [number, number] {
  const width = Math.log(1 + percent / 100) / Math.log(1.0001);
  const align = (value: number, round: (n: number) => number) =>
    round(value / eurcPool.tickSpacing) * eurcPool.tickSpacing;
  return [align(tick - width, Math.floor), align(tick + width, Math.ceil)];
}
