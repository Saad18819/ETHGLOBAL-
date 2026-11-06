import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { arc as arcMainnet } from "viem/chains";

/// Arc mainnet, read only and server side (used by /api/markets): real pool, vault and market numbers to show next to the testnet flow.
const client = createPublicClient({ chain: arcMainnet, transport: http("https://rpc.mainnet.arc.io", { retryCount: 3 }) });

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
/// The RPC answers eth_getLogs for at most this many blocks per call.
const LOG_WINDOW = 5000n;
/// Arc produces a block about every half second.
const BLOCKS_PER_DAY = 172_800n;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export type PoolSpec = {
  id: Hex;
  token0: { symbol: string; address: Address; decimals: number };
  token1: { symbol: string; address: Address; decimals: number };
  fee: number;
};

export type PoolStats = {
  id: Hex;
  pair: string;
  fee: number;
  /// Value of the liquidity within 1% of the current price, which for a stable pair is where it sits.
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  apr: number;
  /// Share of the day's blocks actually read.
  coverage: number;
};

/// Liquidity is read at the current price and valued over a 1% band either side (the virtual reserves of a
/// concentrated pool would overstate it). Volume and fees come from the last day of Swap events.
export async function poolStats(spec: PoolSpec, usdPrice: (symbol: string) => number): Promise<PoolStats> {
  const [[sqrtPriceX96], liquidity] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [spec.id] }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [spec.id] }),
  ]);
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const band = Math.sqrt(1.01);
  const amount0 = (Number(liquidity) * (1 / sqrtPrice - 1 / (sqrtPrice * band))) / 10 ** spec.token0.decimals;
  const amount1 = (Number(liquidity) * (sqrtPrice - sqrtPrice / band)) / 10 ** spec.token1.decimals;
  const price0 = usdPrice(spec.token0.symbol);
  const tvlUsd = amount0 * price0 + amount1 * usdPrice(spec.token1.symbol);

  const head = await client.getBlockNumber();
  const windows: [bigint, bigint][] = [];
  for (let from = head - BLOCKS_PER_DAY; from <= head; from += LOG_WINDOW) {
    windows.push([from, from + LOG_WINDOW - 1n > head ? head : from + LOG_WINDOW - 1n]);
  }
  // Gentle on the public RPC: a few windows at a time, each retried with backoff when rate limited.
  const read = async ([fromBlock, toBlock]: [bigint, bigint]) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await client.getLogs({ address: POOL_MANAGER, event: swapEvent, args: { id: spec.id }, fromBlock, toBlock });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
      }
    }
    return undefined;
  };
  let volume0 = 0;
  let fees0 = 0;
  let covered = 0;
  for (let i = 0; i < windows.length; i += 3) {
    const batch = await Promise.all(windows.slice(i, i + 3).map(read));
    for (const logs of batch) {
      if (!logs) continue;
      covered++;
      for (const log of logs) {
        const amount = Math.abs(Number(log.args.amount0 ?? 0n)) / 10 ** spec.token0.decimals;
        volume0 += amount;
        // The event carries the fee actually charged, in hundredths of a basis point.
        fees0 += (amount * (log.args.fee ?? spec.fee)) / 1_000_000;
      }
    }
  }
  // Windows the RPC never answered are filled in at the average of the ones it did.
  const coverage = covered / windows.length;
  if (coverage === 0) throw new Error("no swap data");
  volume0 /= coverage;
  fees0 /= coverage;
  const volume24hUsd = volume0 * price0;
  const fees24hUsd = fees0 * price0;

  return {
    id: spec.id,
    pair: `${spec.token0.symbol}/${spec.token1.symbol}`,
    fee: spec.fee,
    tvlUsd,
    volume24hUsd,
    fees24hUsd,
    apr: tvlUsd > 0 ? (fees24hUsd * 365) / tvlUsd : 0,
    coverage,
  };
}
