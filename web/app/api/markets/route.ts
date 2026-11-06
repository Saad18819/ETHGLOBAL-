import { AppKit } from "@circle-fin/app-kit";

import { encodeAbiParameters, keccak256, toEventSelector, zeroAddress } from "viem";

import type { Markets } from "@/lib/markets";

const kit = new AppKit();

/// Readable names for the testnet vaults Circle Earn lists; their onchain names are internal.
const VAULT_NAMES: Record<string, string> = {
  "0xaabbef1d3971c710276ed41ec791bbe14cdb8e88": "Circle Earn USDC",
  "0x8f2d33b5d4b9b5f02df635ae308f7b4c9da8d2dc": "Morpho USDC",
};
const TTL = 60_000;
let cached: { at: number; data: Markets } | undefined;

// Mainnet reference prices; testnet tokens have no market of their own.
const ETHEREUM_PRICES = {
  WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  cirBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
} as const;

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

/// Live Earn vaults, Borrow markets, USD prices and pool volume for Arc testnet.
export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return Response.json(cached.data);

  const [vaults, markets, arcRates, ethRates, pool] = await Promise.all([
    kit.earn.exploreVaults({ chain: "Arc_Testnet", pageSize: 100, sortBy: "apy" }),
    kit.borrow.exploreMarkets({ chain: "Arc_Testnet" }),
    kit.getTokenRates({ chain: "Arc_Testnet", tokens: ["USDC", "EURC"] }),
    kit.getTokenRates({ chain: "Ethereum", tokens: ["WETH", "WBTC"] }),
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
      USDC: price(arc, "0x3600000000000000000000000000000000000000"),
      EURC: price(arc, "0x89b50855aa3be2f677cd6303cec089b5f319d72a"),
      ETH: price(eth, ETHEREUM_PRICES.WETH),
      WETH: price(eth, ETHEREUM_PRICES.WETH),
      cirBTC: price(eth, ETHEREUM_PRICES.cirBTC),
    },
    pool,
    asOf: new Date().toISOString(),
  };

  cached = { at: Date.now(), data };
  return Response.json(data);
}
