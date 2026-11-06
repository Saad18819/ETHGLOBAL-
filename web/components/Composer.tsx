"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { useConnect, useConnection } from "wagmi";
import { injected } from "wagmi/connectors";

import styles from "./Composer.module.css";
import { Details } from "./Details";
import { Journey, later, phaseOf, type Phase } from "./Journey";
import { NextPanel } from "./NextPanel";
import { Options } from "./Options";
import { Sentence } from "./Sentence";
import { RouterTracker } from "./Tracker";
import { sources } from "@/lib/chains";
import { arc } from "@/lib/contracts";
import { cctpFees, EURC_SWAP_MARGIN, resolveRecipient, sendElsewhere, StuckTransfer, wrapEth, type CctpFees, sendThroughRouter, sendThroughWallet, type RouterResult } from "@/lib/flows";
import { MAX_LEVERAGE } from "@/lib/loop";
import { holdingOf, short, spendable, useBalances } from "@/lib/balances";
import { describe, publish, record } from "@/lib/history";
import { protocolOf, protocols, swatchStyle } from "@/lib/brand";
import { useMarkets } from "@/lib/markets";
import {
  assets,
  bridgedAsset,
  defaultPlan,
  normalizePlan,
  routeOf,
  swapsAtDestination,
  viaUniswap,
  wrapsIntoWeth,
  type NextId,
  type Plan,
} from "@/lib/plan";
import { quoteToUsdc, quoteUsdcInto, swapToUsdc } from "@/lib/uniswap";
import { marketSqrtPriceX96, poolById, usePoolState, type PoolState } from "@/lib/pools";
import { useEurcCost, useEurcOut, usePool } from "@/lib/quote";

type Run =
  | ({ kind: "router"; outcome: string } & RouterResult)
  | { kind: "wallet"; steps: { name: string; explorerUrl?: string }[] };

const outcomes: Record<NextId, string> = {
  pay: "Paid {recipient}",
  hold: "Holding on Arc",
  pool: "Position minted",
  lend: "Lending on Morpho",
  loop: "Leveraged",
};

export function Composer({
  initialPlan = defaultPlan,
  locked = false,
  invoiceId,
  replyTo,
  compact = false,
  aside,
}: {
  initialPlan?: Plan;
  locked?: boolean;
  invoiceId?: Hex;
  replyTo?: Address;
  /// Less room above, for when the composer sits under tabs.
  compact?: boolean;
  /// Shown in the side column instead of the next steps, such as the invoice on a pay link.
  aside?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(initialPlan);
  // Until the user edits the sentence, it follows their largest holding.
  const [touched, setTouched] = useState(locked);
  // For a payment, the side the user typed last drives the other: the amount moved, or what they get.
  const [anchor, setAnchor] = useState<"source" | "target">(locked ? "target" : "source");
  const setPlan = (next: Plan) => {
    setTouched(true);
    if (next.payAmount !== plan.payAmount) setAnchor("target");
    else if (next.amount !== plan.amount) setAnchor("source");
    // Keep the derived side as shown, so switching anchors starts from what is on screen.
    setDraft(next);
  };
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [stuck, setStuck] = useState<StuckTransfer>();
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run>();
  const [journey, setJourney] = useState<{ plan: Plan; phase: Phase; failed?: boolean }>();
  /// What finished, once a move succeeds: the button then offers the next one.
  const [done, setDone] = useState<string>();
  // How far the running move got, readable from the error handler.
  const reached = useRef<Phase>("source");
  const report = (label: string) => {
    setStatus(label);
    reached.current = later(reached.current, phaseOf(label));
    setJourney((current) => current && { ...current, phase: later(current.phase, phaseOf(label)) });
  };
  // A move through our contracts reports how far its order on Arc got.
  const onProgress = (phase: Phase, failed: boolean) =>
    setJourney((current) => current && { ...current, phase: later(current.phase, phase), failed });
  const reset = () => {
    setDone(undefined);
    setRun(undefined);
    setJourney(undefined);
    setError(undefined);
    setStuck(undefined);
  };

  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const markets = useMarkets();
  const balances = useBalances(address, markets.data?.prices);
  // The default move heads to Arc, so it starts from the largest holding elsewhere.
  const top = balances.data?.find((holding) => holding.from !== "arc");
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
  const prices = markets.data?.prices;
  const unsized = { ...base, vault };
  // Through our contracts an EURC payment is bought on the Arc pool: what that exact amount costs there.
  const eurcCost = useEurcCost(
    unsized.payAmount,
    unsized.next === "pay" && unsized.payToken === "EURC" && routeOf(unsized) === "router",
  );
  const domain = sources[unsized.from].cctpDomain;
  const destination = sources[unsized.to].cctpDomain;
  const fees = useQuery({
    queryKey: ["cctp-fee", domain, destination],
    queryFn: () => cctpFees(domain, destination),
    staleTime: 60_000,
  });
  // Typed what they get: move enough to cover it at market prices plus a margin; the rest stays in the
  // wallet on Arc.
  const sized: Plan =
    unsized.next === "pay" && anchor === "target"
      ? {
          ...unsized,
          amount:
            amountFor(unsized, pricesFor(unsized, prices, eurcCost.data), forwarderFee(unsized, fees.data), bridgeFee(unsized, fees.data)) ??
            unsized.amount,
        }
      : unsized;
  const lltv = markets.data?.markets.find((m) => m.collateral === "cirBTC")?.lltv;
  const chosenPool = usePoolState(poolById(sized.pool), markets.data?.prices);

  const uniswap = viaUniswap(sized);
  const amountIn = parseAmount(sized.amount, assets[sized.asset].decimals);
  const sourceQuote = useQuery({
    queryKey: ["source-quote", sized.asset, sized.from, amountIn.toString(), sized.slippage, markets.data?.prices[sized.asset]],
    queryFn: () =>
      quoteToUsdc(sized.asset, sized.from, amountIn, Number(sized.slippage), address, markets.data?.prices[sized.asset]),
    enabled: uniswap && amountIn > 0n,
    staleTime: 30_000,
    retry: false,
  });
  const route = routeOf(sized);
  // What arrives as USDC when the source leg goes through Uniswap.
  const amount = uniswap
    ? Number(formatUnits(sourceQuote.data?.amountOut ?? 0n, 6))
    : Number(sized.amount) || 0;
  const slippage = 1 - Number(sized.slippage) / 100;
  const swaps =
    uniswap ||
    (sized.next === "hold" && sized.hold !== bridgedAsset(sized)) ||
    sized.next === "loop" ||
    sized.next === "pool" ||
    sized.next === "lend" ||
    (sized.next === "pay" && sized.payToken !== sized.asset);
  // What the move is worth on arrival, in USD: the market value, or less when the source swap quotes less.
  // Circle's forwarder mints USDC on Arc for a flat fee.
  const forwardFee = bridgedAsset(sized) === "USDC" && route === "wallet" ? (fees.data?.forward ?? 0) : 0;
  const marketUsd = (Number(sized.amount) || 0) * (prices?.[sized.asset] ?? NaN);
  // The lower of the quote and the market, then the bridge's own fees off whichever it is.
  const grossUsd = uniswap ? Math.min(amount, marketUsd) : marketUsd;
  const bridgeBps = (sized.speed === "fast" ? fees.data?.fast : fees.data?.standard) ?? 0;
  const arrivingUsd = grossUsd * (1 - bridgeBps / 10_000) - forwardFee;
  // Through our contracts, holding EURC swaps all the USDC that arrives on the Arc pool, and adding
  // liquidity swaps half of it: what that returns, quoted.
  const swappedOnArc =
    route === "router" ? (sized.next === "hold" && sized.hold === "EURC" ? arrivingUsd : sized.next === "pool" ? arrivingUsd / 2 : 0) : 0;
  const eurcOut = useEurcOut(swappedOnArc, swappedOnArc > 0);
  const eurcFloor = eurcOut.data && (eurcOut.data * slippage) / EURC_SWAP_MARGIN;
  const keep = 0.999 * slippage;
  const payPrice = pricesFor(sized, prices, eurcCost.data)?.[sized.payToken] ?? NaN;
  const maxPay = (arrivingUsd * keep) / marginFor(sized) / payPrice;
  // Typed the amount moved: they get the most it covers.
  const plan =
    sized.next === "pay" && anchor === "source" && Number.isFinite(maxPay) && !(uniswap && !sourceQuote.data)
      ? { ...sized, payAmount: String(Math.floor(maxPay * 100) / 100) }
      : sized;
  const leftover = maxPay - (Number(plan.payAmount) || 0);
  // A hold elsewhere in another token: what the arriving USDC buys there with Uniswap.
  const swapThere = swapsAtDestination(plan);
  const arrivingUsdc = Number.isFinite(arrivingUsd) && arrivingUsd > 0 ? parseUnits(arrivingUsd.toFixed(6), 6) : 0n;
  const destinationQuote = useQuery({
    queryKey: ["destination-quote", plan.hold, plan.to, arrivingUsdc.toString(), plan.slippage],
    queryFn: () => quoteUsdcInto(plan.hold, plan.to, arrivingUsdc, Number(plan.slippage), address),
    enabled: swapThere && arrivingUsdc > 0n,
    staleTime: 30_000,
    retry: false,
  });
  // Until the source swap is quoted, there is nothing to measure the payment against.
  const quoting = uniswap && !sourceQuote.data && !sourceQuote.error;
  // More than the wallet holds can never go through, whatever the token.
  const held = balances.data && holdingOf(balances.data, plan.asset, plan.from);
  const overBalance =
    balances.data !== undefined && Number(plan.amount) > Number(held?.amount ?? 0)
      ? `You have ${held ? short(held.amount) : "no"} ${plan.asset} on ${sources[plan.from].label}`
      : undefined;
  const blocker = overBalance
    ? overBalance
    : quoting || (swapThere && !destinationQuote.data && !destinationQuote.error)
    ? "Getting a Uniswap quote"
    : swapThere && destinationQuote.error
      ? `No Uniswap quote from USDC to ${plan.hold} on ${sources[plan.to].label}: ${destinationQuote.error.message}`
    : uniswap && sourceQuote.error
      ? `No Uniswap quote from ${plan.asset} to USDC on ${sources[plan.from].label}: ${sourceQuote.error.message}`
    : eurcOut.isError
      ? "No quote for EURC on the Arc pool right now"
    : swappedOnArc > 0 && eurcOut.isLoading
      ? "Pricing EURC on Arc"
    : eurcCost.isError
      ? `The EURC pool on Arc can not cover ${plan.payAmount} EURC right now`
    : eurcCost.isLoading
      ? "Pricing EURC on Arc"
      : findBlocker(plan, route, amount, payPrice / (prices?.USDC ?? 1), slippage, maxPay);

  async function go() {
    if (!address) return;
    setBusy(true);
    setError(undefined);
    setRun(undefined);
    setStuck(undefined);
    setDone(undefined);
    reached.current = "source";
    setJourney({ plan, phase: "source" });
    // What the stats record about this move: what left which chain, and what for.
    const shared = {
      account: address,
      purpose: plan.next,
      summary: describe(plan),
      chain: plan.from,
      asset: plan.asset,
      amount: plan.amount,
    };
    try {
      const recipient =
        plan.next === "pay" ? await resolveRecipient(plan.recipient) : address;
      let effective = plan;
      if (wrapsIntoWeth(plan.asset, plan.from) && bridgedAsset(plan) === "WETH") {
        await wrapEth(plan.from, amountIn, report);
        effective = { ...plan, asset: "WETH" };
      } else if (uniswap) {
        const { usdc } = await swapToUsdc(
          { account: address, asset: plan.asset, from: plan.from, amountIn, slippage: Number(plan.slippage) },
          report,
        );
        effective = { ...plan, asset: "USDC", amount: formatUnits(usdc, 6) };
      }

      const context = {
        plan: effective,
        account: address,
        recipient,
        invoiceId,
        replyTo,
        poolTick: pool.data?.tick,
        rate: pool.data?.rate,
        eurcCost: eurcCost.data,
        eurcOut: eurcOut.data,
        pool: chosenPool.data && liquidityTarget(chosenPool.data, markets.data?.prices),
        minOut:
          plan.next === "hold" && plan.hold === "EURC" && eurcFloor ? parseUnits(eurcFloor.toFixed(6), 6) : undefined,
      };

      if (routeOf(effective) === "router") {
        const result = await sendThroughRouter(context, report);
        // From here the order on Arc drives the progress row.
        setJourney((current) => current && { ...current, phase: later(current.phase, "bridge") });
        setRun({ kind: "router", outcome: outcomes[plan.next].replace("{recipient}", plan.recipient), ...result });
        setDone("Sent, on its way to Arc.");
        record(address, {
          purpose: plan.next,
          summary: describe(plan),
          status: "sent",
          steps: [{ name: `Sent from ${sources[plan.from].label}`, href: `${result.explorer}/tx/${result.txHash}` }],
        });
        publish({ ...shared, tx: result.txHash, status: "sent" });
      } else if (effective.to !== "arc") {
        const result = await sendElsewhere(context, fees.data, report);
        setJourney((current) => current && { ...current, phase: "done" });
        setRun({ kind: "wallet", steps: result.steps });
        setDone(`Done. ${describe(plan)}.`);
        record(address, {
          purpose: plan.next,
          summary: describe(plan),
          status: "done",
          steps: result.steps.map((step) => ({ name: step.name, href: step.explorerUrl })),
        });
        publish({ ...shared, tx: result.sourceTx, status: "done" });
      } else {
        const result = await sendThroughWallet(context, report);
        setJourney((current) => current && { ...current, phase: "done" });
        setRun({ kind: "wallet", steps: result.steps });
        setDone(`Done. ${describe(plan)}.`);
        record(address, {
          purpose: plan.next,
          summary: describe(plan),
          status: "done",
          steps: result.steps.map((step) => ({ name: step.name, href: step.explorerUrl })),
        });
        // A source swap or wrap ran first; the burn is still the proof the move left the chain.
        publish({ ...shared, tx: result.sourceTx, status: "done" });
      }
      setStatus(undefined);
    } catch (cause) {
      setStatus(undefined);
      const cancelled = /rejected|denied|cancell?ed/i.test(readable(cause));
      // `report` moves this along during the awaits above.
      const phase: Phase = reached.current as Phase;
      // Declined in the wallet before anything left the source chain: as if the move never started.
      if (cancelled && phase === "source") {
        setJourney(undefined);
        return;
      }
      setJourney((current) => current && { ...current, failed: true });
      if (cause instanceof StuckTransfer) setStuck(cause);
      setError(
        cancelled
          ? phase === "bridge"
            ? "Cancelled in your wallet"
            : "Cancelled in your wallet. What already arrived is in your wallet on Arc"
          : readable(cause),
      );
      // Only a transfer that left the source chain but did not land is history; a failed move moved
      // nothing, and anything that did move shows up from the chain.
      if (cause instanceof StuckTransfer) {
        record(address, {
          purpose: plan.next,
          summary: describe(plan),
          status: "stuck",
          steps: [],
          error: readable(cause),
          stuck: { from: cause.from, tx: cause.txHash },
        });
        publish({ ...shared, tx: cause.txHash, status: "stuck" });
      }
    } finally {
      setBusy(false);
    }
  }

  const poolDepth = pool.data ? pool.data.usdcDepth + pool.data.eurcDepth / pool.data.rate : undefined;

  return (
    <div className={styles.layout} data-compact={compact || undefined}>
      <section className={styles.main}>
        <Sentence
          plan={plan}
          onChange={setPlan}
          vaults={vaults}
          lltv={lltv}
          holdings={balances.data}
          locked={locked}
          poolRates={{
            ...Object.fromEntries(
              (markets.data?.mainnet.references ?? []).map((ref) => [ref.pair, { apr: ref.apr, where: "Ethereum" }]),
            ),
            ...Object.fromEntries((markets.data?.mainnet.pools ?? []).map((pool) => [pool.pair, { apr: pool.apr }])),
          }}
        />

        <Options plan={plan} onChange={setPlan} swaps={swaps} />
        <Details
          plan={plan}
          markets={markets.data && { ...markets.data, vaults }}
          pool={pool.data}
          chosenPool={chosenPool.data}
          leftover={plan.next === "pay" && !quoting && Number.isFinite(leftover) && leftover > 0 ? leftover : undefined}
          fees={fees.data}
          sourceQuote={uniswap ? sourceQuote.data : undefined}
          destinationQuote={swapThere ? destinationQuote.data : undefined}
        />

        <div className={styles.actions}>
          {!isConnected ? (
            <button className={styles.primary} onClick={() => connect.mutate({ connector: injected() })}>
              Connect wallet
            </button>
          ) : busy ? null : done ? (
            <>
              <button
                className={styles.primary}
                style={swatchStyle(protocols[protocolOf[plan.next]])}
                onClick={reset}
              >
                Move more
              </button>
              <span className={run?.kind === "router" && journey?.failed ? styles.failure : styles.success}>
                {run?.kind === "router" && journey?.failed
                  ? "Could not finish, refunded on Arc."
                  : run?.kind === "router" && journey?.phase === "done"
                    ? `${run.outcome}.`
                    : done}
              </span>
            </>
          ) : (
            <button
              className={styles.primary}
              style={swatchStyle(protocols[protocolOf[plan.next]])}
              disabled={Boolean(blocker)}
              onClick={go}
            >
              Move it
            </button>
          )}
          {status ? (
            <span className={styles.status}>{status}</span>
          ) : (
            !busy && !done && blocker && <span className={styles.warning}>{blocker}</span>
          )}
        </div>
        {journey && (
          <Journey plan={journey.plan} phase={journey.phase} failed={journey.failed} receipt={Boolean(invoiceId)} />
        )}
        {error && (
          <p className={styles.error}>
            {error}
            {stuck && (
              <>
                {". "}
                <a href={`${sources[stuck.from].explorer}/tx/${stuck.txHash}`} target="_blank" rel="noreferrer">
                  See the burn
                </a>
              </>
            )}
          </p>
        )}

        {run?.kind === "router" && (
          <div className={styles.tracker}>
            <RouterTracker
              orderKey={run.key}
              txHash={run.txHash}
              explorer={run.explorer}
              source={sources[plan.from].label}
              domain={sources[plan.from].cctpDomain}
              invoiceId={invoiceId}
              onProgress={onProgress}
            />
          </div>
        )}
      </section>

      {aside}
      {!locked && !aside && (
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

function findBlocker(
  plan: Plan,
  route: ReturnType<typeof routeOf>,
  amount: number,
  /// USDC each unit of the payment costs on arrival, swap included.
  unitCost: number,
  slippage: number,
  maxPay: number,
): string | undefined {
  if (!amount) return "Enter an amount";
  if (!route) return `Not available from ${sources[plan.from].label}`;
  if (plan.next === "pay") {
    if (!plan.recipient) return "Who should get paid?";
    const pay = Number(plan.payAmount) || 0;
    // A cent of tolerance: an amount sized for this payment can land a hair under it in floating point.
    if (Number.isFinite(maxPay) && pay > maxPay + 0.005) {
      return `${plan.amount} ${plan.asset} covers about ${round(maxPay, 2)} ${plan.payToken}`;
    }
    // The CCTP fast fee (up to a few basis points) comes off what arrives, so ask for a little more.
    const needed = (route === "router" && plan.payToken === "EURC" && unitCost ? (pay * unitCost) / slippage : pay) / 0.9995;
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

/// Room left between what a move is worth and what it pays, for prices that move before it lands: a
/// little when the money stays the same stablecoin, more when a swap is on the way.
function marginFor(plan: Plan) {
  // An exact EURC payment through our contracts may spend up to this much over its quote on Arc.
  if (plan.next === "pay" && plan.payToken === "EURC" && routeOf(plan) === "router") return EURC_SWAP_MARGIN;
  const swapless = assets[plan.asset].token.kind === "stable" && !viaUniswap(plan) && bridgedAsset(plan) === plan.payToken;
  return swapless ? 1.005 : 1.02;
}

/// Prices as the move will meet them. Through our contracts, EURC is bought on the Arc Uniswap pool,
/// so its price is what the pool takes for this exact amount: fee and price impact included.
function pricesFor(plan: Plan, prices: Record<string, number> | undefined, eurcCost: number | undefined) {
  const pay = Number(plan.payAmount);
  if (!prices || routeOf(plan) !== "router" || plan.payToken !== "EURC" || !eurcCost || !(pay > 0)) return prices;
  return { ...prices, EURC: ((prices.USDC ?? 1) * eurcCost) / pay };
}

/// The share CCTP keeps for the chosen speed, as a fraction.
const bridgeFee = (plan: Plan, fees: CctpFees | undefined) =>
  ((plan.speed === "fast" ? fees?.fast : fees?.standard) ?? 0) / 10_000;

/// The forwarder's fee when the wallet route bridges USDC, in USD.
const forwarderFee = (plan: Plan, fees: CctpFees | undefined) =>
  bridgedAsset(plan) === "USDC" && routeOf(plan) === "wallet" ? (fees?.forward ?? 0) : 0;

/// How much of the asset covers a payment at market prices, with room for fees, slippage and price moves:
/// a little for stablecoins, more for anything that moves. Rounded up so it always covers.
function amountFor(plan: Plan, prices: Record<string, number> | undefined, forwardFee = 0, bridgeShare = 0) {
  const assetPrice = prices?.[plan.asset];
  const payPrice = prices?.[plan.payToken];
  const pay = Number(plan.payAmount);
  if (!assetPrice || !payPrice || !(pay > 0)) return undefined;
  const token = assets[plan.asset].token;
  const margin = marginFor(plan);
  const value =
    ((((pay * payPrice) / (0.999 * (1 - Number(plan.slippage) / 100))) * margin + forwardFee) / (1 - bridgeShare)) /
    assetPrice;
  const digits = Math.min(token.decimals, token.kind === "btc" ? 6 : token.kind === "eth" ? 5 : 2);
  return String(Math.ceil(value * 10 ** digits) / 10 ** digits);
}
