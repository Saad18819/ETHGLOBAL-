import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";
import { getBalance, readContracts } from "wagmi/actions";

import { sourceIds, sources, type SourceId } from "./chains";
import { config, type ChainId } from "./config";
import { erc20Abi } from "./contracts";
import type { Markets } from "./markets";
import { assets, type AssetId } from "./plan";

export type Holding = { asset: AssetId; from: SourceId; amount: string; usd: number };

/// Every supported token on every source chain the wallet holds, largest USD value first.
export function useBalances(account: Address | undefined, prices: Markets["prices"] | undefined) {
  return useQuery({
    queryKey: ["balances", account, Boolean(prices)],
    enabled: Boolean(account && prices),
    refetchInterval: 30_000,
    queryFn: async (): Promise<Holding[]> => {
      const entries = sourceIds.flatMap((from) =>
        Object.entries(sources[from].tokens).map(([asset, token]) => ({ from, asset: asset as AssetId, token })),
      );

      const erc20 = entries.filter((entry) => entry.token !== "native");
      const results = await readContracts(config, {
        allowFailure: true,
        contracts: erc20.map((entry) => ({
          chainId: sources[entry.from].chain.id as ChainId,
          address: entry.token as Address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [account!] as const,
        })),
      });
      const native = await Promise.all(
        entries
          .filter((entry) => entry.token === "native")
          .map(async (entry) => {
            try {
              const balance = await getBalance(config, { address: account!, chainId: sources[entry.from].chain.id as ChainId });
              return { ...entry, raw: balance.value };
            } catch {
              return { ...entry, raw: 0n };
            }
          }),
      );

      const raw = [
        ...erc20.map((entry, i) => ({ ...entry, raw: results[i].status === "success" ? (results[i].result as bigint) : 0n })),
        ...native,
      ];
      return raw
        .filter((entry) => entry.raw > 0n)
        .map((entry) => {
          const amount = formatUnits(entry.raw, assets[entry.asset].decimals);
          return { asset: entry.asset, from: entry.from, amount, usd: Number(amount) * (prices![entry.asset] ?? 0) };
        })
        .sort((a, b) => b.usd - a.usd);
    },
  });
}

export const holdingOf = (holdings: Holding[] | undefined, asset: AssetId, from: SourceId) =>
  holdings?.find((h) => h.asset === asset && h.from === from);

/// Short display of a token amount: up to 6 significant digits, no trailing zeros.
export function short(amount: string) {
  const value = Number(amount);
  if (value === 0) return "0";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(value.toPrecision(4)).toString();
}
