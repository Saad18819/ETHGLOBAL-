import { AppKit } from "@circle-fin/app-kit";

import { encodeAbiParameters, keccak256, toEventSelector, zeroAddress } from "viem";

import type { Markets } from "@/lib/markets";
import { poolStats, type PoolSpec } from "@/lib/mainnet";
import { arc as arcContracts } from "@/lib/contracts";
import { pools as arcPools } from "@/lib/pools";
import { references } from "@/lib/references";
import { mainnetTokens, tokens } from "@/lib/tokens";

const kit = new AppKit();

/// Readable names for the testnet vaults Circle Earn lists; their onchain names are internal.
const VAULT_NAMES: Record<string, string> = {
  "0xaabbef1d3971c710276ed41ec791bbe14cdb8e88": "Circle Earn USDC",
  "0x8f2d33b5d4b9b5f02df635ae308f7b4c9da8d2dc": "Morpho USDC",
};
const TTL = 60_000;
let cached: { at: number; data: Markets } | undefined;

// Testnet tokens have no market of their own, so every token is priced from its Ethereum mainnet
// counterpart: ETH as WETH, cirBTC as WBTC.
const PRICE_AS: Record<string, string> = { ETH: "WETH", cirBTC: "WBTC" };
const mainnetAddress = (symbol: string) => {
  const address = mainnetTokens.find((token) => token.symbol === (PRICE_AS[symbol] ?? symbol))?.sources.ethereum;
  return address && address !== "native" ? address.toLowerCase() : undefined;
};

const EXPLORER = "https://explorer.testnet.arc.io/api";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const SWAP = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
// The USDC/EURC pool the app uses: 0.05% fee, tick spacing 10, no hooks.
const POOL_ID = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    ["0x3600000000000000000000000000000000000000", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", 500, 10, zeroAddress],
  ),
);
const WEEK = 7 * 86_400;

/// USDC volume through the pool over the last 7 days, from its Swap events. The explorer returns at most
/// 1000 logs per call, so this pages forward by block.
async function poolVolume(): Promise<{ volume7d: number; swaps7d: number }> {
  const since = Date.now() / 1000 - WEEK;
  let fromBlock = 0;
  let volume7d = 0;
  let swaps7d = 0;
  for (let page = 0; page < 20; page++) {
    const url = `${EXPLORER}?module=logs&action=getLogs&address=${POOL_MANAGER}&topic0=${SWAP}&topic1=${POOL_ID}&topic0_1_opr=and&fromBlock=${fromBlock}&toBlock=latest`;
    const response = await fetch(url, { cache: "no-store" });
    const logs: { timeStamp: string; blockNumber: string; data: string }[] = (await response.json()).result ?? [];
    for (const log of logs) {
      if (parseInt(log.timeStamp, 16) < since) continue;
      const raw = BigInt(`0x${log.data.slice(2, 66)}`);
      const amount0 = raw >= 2n ** 255n ? raw - 2n ** 256n : raw;
      volume7d += Math.abs(Number(amount0)) / 1e6;
      swaps7d++;
    }
    if (logs.length < 1000) break;
    fromBlock = parseInt(logs[logs.length - 1].blockNumber, 16) + 1;
  }
  return { volume7d, swaps7d };
}

/// Uniswap v4 pools on Arc mainnet without hooks between real assets. Probing every token Morpho lists on Arc
/// against USDC and EURC across all fee tiers finds only this one (plus native USDC against its own ERC20).
const MAINNET_POOLS: PoolSpec[] = [
  {
    id: "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae",
    token0: { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 },
    token1: { symbol: "EURC", address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", decimals: 6 },
    fee: 500,
  },
];
const MAINNET_TTL = 15 * 60_000;
let mainnetCache: { at: number; data: Markets["mainnet"] } | undefined;

/// Real numbers from Arc mainnet: the best Morpho vaults, liquid borrow markets and Uniswap pool APRs.
async function mainnet(prices: Record<string, number>): Promise<Markets["mainnet"]> {
  if (mainnetCache && Date.now() - mainnetCache.at < MAINNET_TTL) return mainnetCache.data;
  const usd = (symbol: string) => prices[symbol] ?? (symbol === "USDC" ? 1 : 0);
  const [vaults, markets, pools] = await Promise.all([
    kit.earn.exploreVaults({ chain: "Arc", pageSize: 100, sortBy: "apy" }),
    kit.borrow.exploreMarkets({ chain: "Arc" }),
    Promise.all(MAINNET_POOLS.map((spec) => poolStats(spec, usd).catch(() => undefined))),
  ]);
  const data: Markets["mainnet"] = {
    vaults: vaults.vaults
      .filter((vault) => vault.status === "active" && Number(vault.liquidity) > 100_000)
      .sort((a, b) => b.currentApy - a.currentApy)
      .slice(0, 6)
      .map((vault) => ({ name: vault.name, apy: vault.currentApy, liquidity: Number(vault.liquidity) })),
    markets: markets.markets
      .filter((market) => Number(market.liquidity?.amount ?? 0) > 1_000)
      .map((market) => ({
        pair: `${market.collateralAsset.symbol}/${market.loanAsset.symbol}`,
        borrowApy: market.borrowApy ?? 0,
        lltv: market.lltv ?? 0,
        liquidity: Number(market.liquidity?.amount ?? 0),
      })),
    pools: pools.filter((pool) => pool !== undefined),
    references: await references(arcPools.filter((pair) => pair.id !== "USDC/EURC")).catch(() => []),
  };
  mainnetCache = { at: Date.now(), data };
  return data;
}

/// Live Earn vaults and Borrow markets on the Arc network transactions run on, USD prices, testnet pool volume
/// and the mainnet reference numbers.
export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return Response.json(cached.data);

  const [vaults, markets, arcRates, ethRates, pool] = await Promise.all([
    kit.earn.exploreVaults({ chain: arcContracts.kitChain as "Arc_Testnet", pageSize: 100, sortBy: "apy" }),
    kit.borrow.exploreMarkets({ chain: arcContracts.kitChain as "Arc_Testnet" }),
    kit.getTokenRates({ chain: "Arc_Testnet", tokens: ["USDC", "EURC"] }),
    kit.getTokenRates({
      chain: "Ethereum",
      tokens: [...new Set(tokens.map((token) => mainnetAddress(token.symbol)).filter((a): a is string => Boolean(a)))],
    }),
    poolVolume().catch(() => ({ volume7d: 0, swaps7d: 0 })),
  ]);

  const arc = arcRates.rates.Arc_Testnet ?? {};
  const eth = ethRates.rates.Ethereum ?? {};
  const price = (rates: Record<string, { priceUSD: string }>, address: string) =>
    Number(rates[address.toLowerCase()]?.priceUSD ?? NaN);

  const data: Markets = {
    vaults: vaults.vaults.map((vault) => ({
      address: vault.vaultAddress,
      name: VAULT_NAMES[vault.vaultAddress.toLowerCase()] ?? vault.name.replace(/\s*\(Arc Testnet\)$/, ""),
      protocol: vault.protocol,
      asset: vault.asset,
      apy: vault.currentApy,
      fee: vault.vaultFee,
      deposits: Number(vault.totalDeposits),
      liquidity: Number(vault.liquidity),
      status: vault.status,
    })),
    markets: markets.markets.map((market) => ({
      id: market.marketId,
      collateral: market.collateralAsset.symbol,
      loan: market.loanAsset.symbol,
      lltv: market.lltv ?? 0,
      borrowApy: market.borrowApy ?? 0,
      utilization: market.utilization ?? 0,
      liquidity: Number(market.liquidity?.amount ?? 0),
      borrowed: Number(market.borrowAssets?.amount ?? 0),
    })),
    prices: {
      ...Object.fromEntries(
        tokens.flatMap((token) => {
          const address = mainnetAddress(token.symbol);
          return address ? [[token.symbol, price(eth, address)]] : [];
        }),
      ),
      USDC: price(arc, "0x3600000000000000000000000000000000000000"),
      EURC: price(arc, "0x89b50855aa3be2f677cd6303cec089b5f319d72a"),
    },
    pool,
    mainnet: await mainnet({ USDC: 1, EURC: price(arc, "0x89b50855aa3be2f677cd6303cec089b5f319d72a") }).catch(
      () => ({ vaults: [], markets: [], pools: [], references: [] }),
    ),
    asOf: new Date().toISOString(),
  };

  cached = { at: Date.now(), data };
  return Response.json(data);
}
