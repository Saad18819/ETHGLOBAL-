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

/// Uniswap's v4 Quoter on Arc, the same address on testnet and mainnet.
const quoter = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
const quoterAbi = parseAbi([
  "function quoteExactOutputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) view returns (uint256 amountIn, uint256 gasEstimate)",
  "function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);

const usdcToEurc = (exactAmount: bigint) => ({
  poolKey: [arc.usdc, arc.eurc, eurcPool.fee, eurcPool.tickSpacing, zeroAddress] as const,
  zeroForOne: true,
  exactAmount,
  hookData: "0x" as const,
});

/// USDC the pool takes for exactly `eurc` out, quoted by simulating the swap: fee and price impact
/// across every tick included.
export async function usdcForEurc(eurc: bigint): Promise<bigint> {
  const [amountIn] = await readContract(config, {
    chainId: arc.chainId,
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [usdcToEurc(eurc)],
  });
  return amountIn;
}

/// EURC the pool gives for exactly `usdc` in, quoted by simulating the swap.
export async function eurcForUsdc(usdc: bigint): Promise<bigint> {
  const [amountOut] = await readContract(config, {
    chainId: arc.chainId,
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [usdcToEurc(usdc)],
  });
  return amountOut;
}

/// What swapping `usdc` into EURC on the pool returns, kept fresh while the user looks at it.
export function useEurcOut(usdc: number, enabled: boolean) {
  const amount = usdc > 0 ? BigInt(Math.floor(usdc * 1e6)) : 0n;
  return useQuery({
    queryKey: ["eurc-out", amount.toString()],
    queryFn: async () => Number(await eurcForUsdc(amount)) / 1e6,
    enabled: enabled && amount > 0n,
    refetchInterval: 15_000,
    retry: false,
  });
}

/// What an exact EURC payment costs in USDC on the pool, kept fresh while the user looks at it.
export function useEurcCost(eurc: string, enabled: boolean) {
  const amount = Number(eurc) > 0 ? BigInt(Math.round(Number(eurc) * 1e6)) : 0n;
  return useQuery({
    queryKey: ["eurc-cost", amount.toString()],
    queryFn: async () => Number(await usdcForEurc(amount)) / 1e6,
    enabled: enabled && amount > 0n,
    refetchInterval: 15_000,
    retry: false,
  });
}

/// EURC per USDC from the pool's spot price.
export function useEurcRate() {
  const pool = usePool();
  return { ...pool, data: pool.data?.rate };
}

/// Tick bounds for a range around the current price, aligned to the pool's tick spacing.
export function rangeTicks(tick: number, percent: number, spacing: number = eurcPool.tickSpacing): [number, number] {
  const width = Math.log(1 + percent / 100) / Math.log(1.0001);
  const align = (value: number, round: (n: number) => number) =>
    round(value / spacing) * spacing;
  return [align(tick - width, Math.floor), align(tick + width, Math.ceil)];
}
