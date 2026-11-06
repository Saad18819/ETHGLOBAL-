import type { PoolPair } from "./pairs";

/// Fee APYs for pairs that have no pool on Arc yet, from the same pair on Ethereum mainnet. Read from
/// DefiLlama's yields API (yields.llama.fi/pools), which tracks every Uniswap pool's fees and liquidity.
export type Reference = { pair: string; apr: number; tvl: number; source: string };

type LlamaPool = {
  chain: string;
  project: string;
  symbol: string;
  poolMeta: string | null;
  tvlUsd: number;
  apyBase: number | null;
  apyBase7d: number | null;
};

/// Arc tokens priced as their Ethereum counterparts.
const onEthereum: Record<string, string> = { cirBTC: "WBTC", WETH: "WETH", USDC: "USDC", EURC: "EURC" };

export async function references(pairs: PoolPair[]): Promise<Reference[]> {
  const response = await fetch("https://yields.llama.fi/pools", { next: { revalidate: 900 } });
  if (!response.ok) return [];
  const { data } = (await response.json()) as { data: LlamaPool[] };
  const uniswap = data.filter((pool) => pool.chain === "Ethereum" && /^uniswap-v[34]$/.test(pool.project));

  return pairs.flatMap((pair) => {
    const want = new Set([onEthereum[pair.a], onEthereum[pair.b]]);
    // The deepest pool for the same two tokens at the same fee tier.
    const match = uniswap
      .filter((pool) => {
        const symbols = pool.symbol.toUpperCase().split("-");
        const tier = Number.parseFloat(pool.poolMeta ?? "");
        return (
          symbols.length === 2 &&
          symbols.every((symbol) => want.has(symbol)) &&
          Math.abs(tier - pair.fee / 10_000) < 1e-9
        );
      })
      .sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
    const apy = match?.apyBase7d ?? match?.apyBase;
    if (!match || apy === null || apy === undefined) return [];
    return [
      {
        pair: pair.id,
        apr: apy / 100,
        tvl: match.tvlUsd,
        source: `Uniswap ${match.project.slice(-2)} ${match.symbol.replace("-", "/")} ${match.poolMeta} on Ethereum`,
      },
    ];
  });
}
