import { AppKit } from "@circle-fin/app-kit";

import type { Markets } from "@/lib/markets";

const kit = new AppKit();
const TTL = 60_000;
let cached: { at: number; data: Markets } | undefined;

// Mainnet reference prices; testnet tokens have no market of their own.
const ETHEREUM_PRICES = {
  WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  cirBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
} as const;

/// Live Earn vaults, Borrow markets and USD prices for Arc testnet, from Circle App Kit.
export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return Response.json(cached.data);

  const [vaults, markets, arcRates, ethRates] = await Promise.all([
    kit.earn.exploreVaults({ chain: "Arc_Testnet", pageSize: 100, sortBy: "apy" }),
    kit.borrow.exploreMarkets({ chain: "Arc_Testnet" }),
    kit.getTokenRates({ chain: "Arc_Testnet", tokens: ["USDC", "EURC"] }),
    kit.getTokenRates({ chain: "Ethereum", tokens: ["WETH", "WBTC"] }),
  ]);

  const arc = arcRates.rates.Arc_Testnet ?? {};
  const eth = ethRates.rates.Ethereum ?? {};
  const price = (rates: Record<string, { priceUSD: string }>, address: string) =>
    Number(rates[address.toLowerCase()]?.priceUSD ?? NaN);

  const data: Markets = {
    vaults: vaults.vaults.map((vault) => ({
      address: vault.vaultAddress,
      name: vault.name.replace(/\s*\(Arc Testnet\)$/, ""),
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
      WETH: price(eth, ETHEREUM_PRICES.WETH),
      cirBTC: price(eth, ETHEREUM_PRICES.cirBTC),
    },
    asOf: new Date().toISOString(),
  };

  cached = { at: Date.now(), data };
  return Response.json(data);
}
