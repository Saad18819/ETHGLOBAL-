"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseUnits, type Address, type Hex } from "viem";
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
import { useMarkets } from "@/lib/markets";
import { defaultPlan, normalizePlan, routeOf, type NextId, type Plan } from "@/lib/plan";
import { usePool } from "@/lib/quote";

type Run =
  | ({ kind: "router"; outcome: string } & RouterResult)
  | { kind: "wallet"; steps: { name: string; explorerUrl?: string }[] };

const outcomes: Record<NextId, string> = {
  pay: "Paid {recipient}",
  hold: "Swapped into EURC on Uniswap",
  keep: "In your wallet on Arc",
  pool: "Position minted in the USDC/EURC pool",
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
  const [draft, setPlan] = useState(initialPlan);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run>();

  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const markets = useMarkets();
  const pool = usePool();
  // The settlement contract only deposits into vaults it allowlists; Circle Earn can reach all of them.
  const vaults = (markets.data?.vaults ?? []).filter(
    (vault) => routeOf(draft) !== "router" || vault.address.toLowerCase() === arc.morphoVault.toLowerCase(),
  );
  const vault = vaults.some((v) => v.address === draft.vault) ? draft.vault : (vaults[0]?.address ?? "");
  const plan = { ...draft, vault };
  const lltv = markets.data?.markets.find((m) => m.collateral === "cirBTC")?.lltv;
  const domain = sources[plan.from].cctpDomain;
  const fees = useQuery({ queryKey: ["cctp-fee", domain], queryFn: () => cctpFees(domain), staleTime: 60_000 });

  const route = routeOf(plan);
  const amount = Number(plan.amount) || 0;
  const slippage = 1 - Number(plan.slippage) / 100;
  const swaps = plan.next === "hold" || plan.next === "loop" || (plan.next === "pay" && plan.payToken === "EURC");
  const blocker = findBlocker(plan, route, amount, pool.data?.rate, slippage);

  async function go() {
    if (!address) return;
    setBusy(true);
    setError(undefined);
    setRun(undefined);
    try {
      const recipient =
        plan.next === "pay" ? await resolveRecipient(plan.recipient) : plan.to ? await resolveRecipient(plan.to) : address;
      const context = {
        plan,
        account: address,
        recipient,
        invoiceId,
        replyTo,
        poolTick: pool.data?.tick,
        minOut:
          plan.next === "hold" && pool.data
            ? parseUnits((amount * pool.data.rate * slippage).toFixed(6), 6)
            : undefined,
      };

      if (route === "router") {
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
        <Sentence plan={plan} onChange={setPlan} vaults={vaults} lltv={lltv} locked={locked} />

        <Options plan={plan} onChange={setPlan} swaps={swaps} forwards={forwards(plan, route)} />
        <Details
          plan={plan}
          markets={markets.data && { ...markets.data, vaults }}
          pool={pool.data}
          fees={fees.data}
        />

        <div className={styles.actions}>
          {isConnected ? (
            <button className={styles.primary} disabled={busy || Boolean(blocker)} onClick={go}>
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
              id={run.id}
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

/// Whether the result can be sent to someone other than the connected wallet.
function forwards(plan: Plan, route: ReturnType<typeof routeOf>) {
  if (plan.next === "hold" || plan.next === "keep") return true;
  return route === "router" && (plan.next === "pool" || plan.next === "lend");
}

function findBlocker(
  plan: Plan,
  route: ReturnType<typeof routeOf>,
  amount: number,
  rate: number | undefined,
  slippage: number,
): string | undefined {
  if (!amount) return "Enter an amount";
  if (!route) return `Not available from ${sources[plan.from].label}`;
  if (route === "router" && !sources[plan.from].router?.address) {
    return `andthen is not deployed on ${sources[plan.from].label} yet`;
  }
  if (plan.next === "pay") {
    if (!plan.recipient) return "Who should get paid?";
    const pay = Number(plan.payAmount) || 0;
    if (route === "wallet" && pay > amount) return `You can pay at most ${plan.amount} ${plan.asset}`;
    const needed = route === "router" && plan.payToken === "EURC" && rate ? pay / rate / slippage : pay;
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

function readable(cause: unknown): string {
  if (cause && typeof cause === "object" && "shortMessage" in cause) return String(cause.shortMessage);
  if (cause instanceof Error) return cause.message.split("\n")[0];
  return "Something went wrong";
}
