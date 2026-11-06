import { useQuery } from "@tanstack/react-query";

import type { AssetId } from "./plan";

export type Vault = {
  address: string;
  name: string;
  protocol: string;
  asset: string;
  apy: number;
  fee: number;
  deposits: number;
  liquidity: number;
  status: string;
};

export type Market = {
  id: string;
  collateral: string;
  loan: string;
  lltv: number;
  borrowApy: number;
  utilization: number;
  liquidity: number;
  borrowed: number;
};

export type Markets = {
  vaults: Vault[];
  markets: Market[];
  prices: Record<AssetId, number>;
  /// USDC/EURC pool on Arc, last 7 days.
  pool: { volume7d: number; swaps7d: number };
  asOf: string;
};

export function useMarkets() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: async (): Promise<Markets> => {
      const response = await fetch("/api/markets");
      if (!response.ok) throw new Error("Could not load market data");
      return response.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export const percent = (value: number, digits = 2) => `${(value * 100).toFixed(digits)}%`;

export function usd(value: number) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/// Fee APR of a pool from a week of volume: fees earned over the in-range liquidity, annualised.
export const feeApr = (volume7d: number, feeTier: number, depth: number) =>
  depth > 0 ? (volume7d * feeTier * 52) / depth : 0;
