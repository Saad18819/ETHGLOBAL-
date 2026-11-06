"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { useConnect, useConnection } from "wagmi";
import { injected } from "wagmi/connectors";

import styles from "./Composer.module.css";
import { Details } from "./Details";
import { NextPanel } from "./NextPanel";
import { Options } from "./Options";
import { Sentence } from "./Sentence";
import { RouterTracker, Steps } from "./Tracker";
import { sources } from "@/lib/chains";
import { arc } from "@/lib/contracts";
import { cctpFees, resolveRecipient, sendThroughRouter, sendThroughWallet, type RouterResult } from "@/lib/flows";
import { MAX_LEVERAGE } from "@/lib/loop";
import { spendable, useBalances } from "@/lib/balances";
import { protocolOf, protocols, swatchStyle } from "@/lib/brand";
import { useMarkets } from "@/lib/markets";
import { assets, bridgedAsset, defaultPlan, normalizePlan, routeOf, viaUniswap, type NextId, type Plan } from "@/lib/plan";
import { quoteToUsdc, swapToUsdc } from "@/lib/uniswap";
import { marketSqrtPriceX96, poolById, usePoolState, type PoolState } from "@/lib/pools";
import { usePool } from "@/lib/quote";

type Run =
  | ({ kind: "router"; outcome: string } & RouterResult)
  | { kind: "wallet"; steps: { name: string; explorerUrl?: string }[] };

const outcomes: Record<NextId, string> = {
  pay: "Paid {recipient}",
  hold: "Holding on Arc",
  pool: "Position minted",
  lend: "Lending on Morpho",
  loop: "Looped",
};

export function Composer({
  initialPlan = defaultPlan,
  locked = false,
  invoiceId,
  replyTo,
}: {
  initialPlan?: Plan;
  locked?: boolean;
  invoiceId?: Hex;
  replyTo?: Address;
}) {
  const [draft, setDraft] = useState(initialPlan);
  // Until the user edits the sentence, it follows their largest holding.
  const [touched, setTouched] = useState(locked);
  const setPlan = (next: Plan) => {
    setTouched(true);
    setDraft(next);
  };
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run>();

  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const markets = useMarkets();
  const balances = useBalances(address, markets.data?.prices);
  const top = balances.data?.[0];
  const pool = usePool();
  // The settlement contract only deposits into the vault it allowlists; Circle Earn can reach all of them.
  const base =
    !touched && top
      ? normalizePlan({ ...draft, asset: top.asset, from: top.from, amount: spendable(top.asset, top.from, top.amount) })
      : draft;
  const vaults = (markets.data?.vaults ?? []).filter(
    (vault) =>
      routeOf(base) !== "router" || vault.address.toLowerCase() === arc.morphoVault?.toLowerCase(),
  );
  const vault = vaults.some((v) => v.address === base.vault) ? base.vault : (vaults[0]?.address ?? "");
  const plan = { ...base, vault };
  const lltv = markets.data?.markets.find((m) => m.collateral === "cirBTC")?.lltv;
  const chosenPool = usePoolState(poolById(plan.pool), markets.data?.prices);
  const domain = sources[plan.from].cctpDomain;
  const fees = useQuery({ queryKey: ["cctp-fee", domain], queryFn: () => cctpFees(domain), staleTime: 60_000 });

  const uniswap = viaUniswap(plan);
  const amountIn = parseAmount(plan.amount, assets[plan.asset].decimals);
  const sourceQuote = useQuery({
    queryKey: ["source-quote", plan.asset, plan.from, amountIn.toString(), plan.slippage, markets.data?.prices.ETH],
    queryFn: () => quoteToUsdc(plan.asset, plan.from, amountIn, Number(plan.slippage), address, markets.data?.prices.ETH),
    enabled: uniswap && amountIn > 0n,
    staleTime: 30_000,
    retry: false,
  });
  const route = routeOf(plan);
  // What arrives as USDC when the source leg goes through Uniswap.
  const amount = uniswap
    ? Number(formatUnits(sourceQuote.data?.amountOut ?? 0n, 6))
    : Number(plan.amount) || 0;
  const slippage = 1 - Number(plan.slippage) / 100;
  const swaps =
    uniswap ||
    (plan.next === "hold" && plan.hold !== bridgedAsset(plan)) ||
    plan.next === "loop" ||
    plan.next === "pool" ||
    plan.next === "lend" ||
    (plan.next === "pay" && plan.payToken !== plan.asset);
  // What the move is worth on arrival, in USD: the market value, or less when the source swap quotes less.
  const prices = markets.data?.prices;
  const marketUsd = (Number(plan.amount) || 0) * (prices?.[plan.asset] ?? NaN);
  const arrivingUsd = uniswap ? Math.min(amount, marketUsd) : marketUsd;
  const keep = 0.999 * slippage;
  const payPrice = prices?.[plan.payToken] ?? NaN;
  const maxPay = (arrivingUsd * keep) / payPrice;
  // How much of the asset covers the payment, the same way round.
  const neededAmount =
    ((Number(plan.payAmount) || 0) * payPrice) / keep / (prices?.[plan.asset] ?? NaN) *
    (uniswap && amount > 0 ? Math.max(1, marketUsd / amount) : 1);
  // Until the source swap is quoted, there is nothing to measure the payment against.
  const quoting = uniswap && !sourceQuote.data && !sourceQuote.error;
  const blocker = quoting
    ? "Getting a Uniswap quote"
    : uniswap && sourceQuote.error
      ? `No Uniswap quote from ${plan.asset} to USDC on ${sources[plan.from].label}: ${sourceQuote.error.message}`
      : findBlocker(plan, route, amount, pool.data?.rate, slippage, maxPay);

  async function go() {
    if (!address) return;
    setBusy(true);
    setError(undefined);
    setRun(undefined);
    try {
      const recipient =
        plan.next === "pay" ? await resolveRecipient(plan.recipient) : plan.to ? await resolveRecipient(plan.to) : address;
      let effective = plan;
      if (uniswap) {
        const { usdc } = await swapToUsdc(
          { account: address, asset: plan.asset, from: plan.from, amountIn, slippage: Number(plan.slippage) },
          setStatus,
        );
        effective = { ...plan, asset: "USDC", amount: formatUnits(usdc, 6) };
      }
      const effectiveAmount = Number(effective.amount);

      const context = {
        plan: effective,
        account: address,
        recipient,
        invoiceId,
        replyTo,
        poolTick: pool.data?.tick,
        rate: pool.data?.rate,
        pool: chosenPool.data && liquidityTarget(chosenPool.data, markets.data?.prices),
        minOut:
          plan.next === "hold" && plan.hold === "EURC" && pool.data
            ? parseUnits((effectiveAmount * pool.data.rate * slippage).toFixed(6), 6)
            : undefined,
      };

      if (routeOf(effective) === "router") {
        const result = await sendThroughRouter(context, setStatus);
        setRun({ kind: "router", outcome: outcomes[plan.next].replace("{recipient}", plan.recipient), ...result });
      } else {
        const result = await sendThroughWallet(context, setStatus);
        setRun({ kind: "wallet", steps: result.steps });
      }
      setStatus(undefined);
    } catch (cause) {
      setStatus(undefined);
      setError(readable(cause));
    } finally {
      setBusy(false);
    }
  }

  const poolDepth = pool.data ? pool.data.usdcDepth + pool.data.eurcDepth / pool.data.rate : undefined;

  return (
    <div className={styles.layout}>
      <section className={styles.main}>
        <Sentence
          plan={plan}
          onChange={setPlan}
          vaults={vaults}
          lltv={lltv}
          holdings={balances.data}
          maxPay={!quoting && Number.isFinite(maxPay) ? maxPay : undefined}
          neededAmount={Number.isFinite(neededAmount) && neededAmount > 0 ? neededAmount : undefined}
          locked={locked}
        />

        <Options plan={plan} onChange={setPlan} swaps={swaps} forwards={forwards(plan, route)} />
        <Details
          plan={plan}
          markets={markets.data && { ...markets.data, vaults }}
          pool={pool.data}
          chosenPool={chosenPool.data}
          fees={fees.data}
          sourceQuote={uniswap ? sourceQuote.data : undefined}
        />

        <div className={styles.actions}>
          {isConnected ? (
            <button
              className={styles.primary}
              style={swatchStyle(protocols[protocolOf[plan.next]])}
              disabled={busy || Boolean(blocker)}
              onClick={go}
            >
              {busy ? "Working" : "Move it"}
            </button>
          ) : (
            <button className={styles.primary} onClick={() => connect.mutate({ connector: injected() })}>
              Connect wallet
            </button>
          )}
          {status ? (
            <span className={styles.status}>{status}</span>
          ) : (
            blocker && <span className={styles.warning}>{blocker}</span>
          )}
        </div>
        {error && <p className={styles.error}>{error}</p>}

        {run?.kind === "router" && (
          <div className={styles.tracker}>
            <RouterTracker
              orderKey={run.key}
              txHash={run.txHash}
              explorer={run.explorer}
              source={sources[plan.from].label}
              domain={sources[plan.from].cctpDomain}
              outcome={run.outcome}
              invoiceId={invoiceId}
            />
          </div>
        )}
        {run?.kind === "wallet" && (
          <div className={styles.tracker}>
            <Steps
              steps={run.steps.map((step) => ({ label: step.name, state: "done" as const, href: step.explorerUrl }))}
            />
          </div>
        )}
      </section>

      {!locked && (
        <NextPanel
          plan={plan}
          markets={markets.data}
          poolDepth={poolDepth}
          onPick={(next) => setPlan(normalizePlan({ ...plan, next }))}
        />
      )}
    </div>
  );
}

/// A round amount to move from a balance, keeping some native ETH for gas.
/// Whether the result can be sent to someone other than the connected wallet.
function forwards(plan: Plan, route: ReturnType<typeof routeOf>) {
  if (plan.next === "hold") return true;
  return route === "router" && (plan.next === "pool" || plan.next === "lend");
}

function findBlocker(
  plan: Plan,
  route: ReturnType<typeof routeOf>,
  amount: number,
  rate: number | undefined,
  slippage: number,
  maxPay: number,
): string | undefined {
  if (!amount) return "Enter an amount";
  if (!route) return `Not available from ${sources[plan.from].label}`;
  if (plan.next === "pay") {
    if (!plan.recipient) return "Who should get paid?";
    const pay = Number(plan.payAmount) || 0;
    if (Number.isFinite(maxPay) && pay > maxPay) {
      return `${plan.amount} ${plan.asset} covers about ${round(maxPay, 2)} ${plan.payToken}`;
    }
    // The CCTP fast fee (up to a few basis points) comes off what arrives, so ask for a little more.
    const needed = (route === "router" && plan.payToken === "EURC" && rate ? pay / rate / slippage : pay) / 0.9995;
    if (route === "router" && needed > amount) return `Move at least ${Math.ceil(needed * 100) / 100} USDC`;
  }
  if (plan.next === "loop") {
    const leverage = Number(plan.leverage);
    if (!(leverage > 1 && leverage <= MAX_LEVERAGE)) {
      return `Leverage goes from 1.1x to ${MAX_LEVERAGE}x on this market`;
    }
  }
  return undefined;
}

const round = (value: number, digits: number) => Math.floor(value * 10 ** digits) / 10 ** digits;

function readable(cause: unknown): string {
  if (cause && typeof cause === "object" && "shortMessage" in cause) return String(cause.shortMessage);
  if (cause instanceof Error) return cause.message.split("\n")[0];
  return "Something went wrong";
}

function parseAmount(amount: string, decimals: number) {
  try {
    return parseUnits(amount || "0", decimals);
  } catch {
    return 0n;
  }
}

/// Where liquidity goes in: the live pool price, or the market price for a pool nobody has opened yet.
function liquidityTarget(state: PoolState, prices: Record<string, number> | undefined) {
  if (state.exists) return { pair: state.pair, tick: state.tick, sqrtPrice: state.sqrtPrice };
  if (!prices) throw new Error("Market prices are not loaded yet");
  const open = marketSqrtPriceX96(state.pair, prices);
  const sqrtPrice = Number(open) / 2 ** 96;
  return { pair: state.pair, tick: Math.floor(Math.log(sqrtPrice * sqrtPrice) / Math.log(1.0001)), sqrtPrice, open };
}
