"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useConnect, useConnection } from "wagmi";
import { readContract } from "wagmi/actions";
import { injected } from "wagmi/connectors";

import styles from "./BridgeBack.module.css";
import { Field, Select } from "./Pill";
import { Steps } from "./Tracker";
import { short } from "@/lib/balances";
import { tokenColor } from "@/lib/brand";
import { sourceIds, sources, type SourceId } from "@/lib/chains";
import { config } from "@/lib/config";
import { arc, erc20Abi } from "@/lib/contracts";
import { bridgeBack } from "@/lib/flows";
import { publish, record } from "@/lib/history";
import { tokenBySymbol } from "@/lib/tokens";

type Token = "USDC" | "EURC";

/// USDC stays behind on Arc to pay gas for the bridge itself.
const GAS_RESERVE = 0.1;

/// Sends USDC or EURC from Arc back to another chain, for testing round trips.
export function BridgeBack() {
  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const [token, setToken] = useState<Token>("USDC");
  const [amount, setAmount] = useState("1");
  const [to, setTo] = useState<SourceId>("ethereum");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [steps, setSteps] = useState<{ name: string; explorerUrl?: string }[]>();

  const destinations = sourceIds.filter((id) => tokenBySymbol[token]?.bridge.includes(id));
  const target = destinations.includes(to) ? to : destinations[0];

  const balance = useQuery({
    queryKey: ["arc-balance", token, address],
    enabled: Boolean(address),
    refetchInterval: 15_000,
    queryFn: async () =>
      formatUnits(
        await readContract(config, {
          chainId: arc.chainId,
          address: token === "USDC" ? arc.usdc : arc.eurc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address!],
        }),
        6,
      ),
  });
  const spendable = balance.data ? Math.max(0, Number(balance.data) - (token === "USDC" ? GAS_RESERVE : 0)) : 0;
  const tooMuch = balance.data !== undefined && Number(amount) > spendable;
  const floor = (value: number) => String(Math.floor(value * 100) / 100);

  async function send() {
    if (!address) return;
    setBusy(true);
    setError(undefined);
    setSteps(undefined);
    const summary = `Sent ${amount} ${token} from Arc back to ${sources[target].label}`;
    try {
      const result = await bridgeBack({ token, amount, to: target }, setStatus);
      setSteps(result.steps);
      record(address, {
        purpose: "back",
        summary,
        status: "done",
        steps: result.steps.map((step) => ({ name: step.name, href: step.explorerUrl })),
      });
      publish({ tx: result.sourceTx, account: address, purpose: "back", summary, chain: "arc", asset: token, amount, status: "done" });
      await balance.refetch();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.split("\n")[0] : "The bridge did not go through";
      setError(message);
      if (!/rejected|denied/i.test(message)) record(address, { purpose: "back", summary, status: "failed", steps: [], error: message });
    } finally {
      setStatus(undefined);
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.sentence}>
        Send{" "}
        <Field
          label="Amount"
          numeric
          value={amount}
          onChange={setAmount}
          swatch={tokenColor(token)}
          hint={balance.data !== undefined ? `of ${short(balance.data)}` : undefined}
          presets={
            spendable > 0
              ? [
                  { label: "50%", value: floor(spendable / 2) },
                  { label: "max", value: floor(spendable) },
                ]
              : undefined
          }
        />{" "}
        <Select<Token>
          label="Token"
          swatch={tokenColor(token)}
          value={token}
          options={[
            { value: "USDC", label: "USDC" },
            { value: "EURC", label: "EURC" },
          ]}
          onChange={setToken}
        />{" "}
        from Arc back to{" "}
        <Select<SourceId>
          label="To"
          tone="stone"
          value={target}
          options={destinations.map((id) => ({ value: id, label: sources[id].label }))}
          onChange={setTo}
        />
        .
      </div>
      <p className={styles.hint}>
        {token === "USDC"
          ? `Circle's forwarder mints it on ${sources[target].label}, so no gas is needed there. ${GAS_RESERVE} USDC stays on Arc for gas.`
          : `EURC is minted by your wallet on ${sources[target].label}, so it needs a little gas there.`}
      </p>

      <div className={styles.actions}>
        {isConnected ? (
          <button
            className={styles.primary}
            disabled={busy || !(Number(amount) > 0) || tooMuch}
            onClick={send}
          >
            {busy ? "Working" : "Send back"}
          </button>
        ) : (
          <button className={styles.primary} onClick={() => connect.mutate({ connector: injected() })}>
            Connect wallet
          </button>
        )}
        {status ? (
          <span className={styles.status}>{status}</span>
        ) : (
          tooMuch && <span className={styles.warning}>You can send up to {floor(spendable)} {token}</span>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {steps && (
        <div className={styles.steps}>
          <Steps steps={steps.map((step) => ({ label: step.name, state: "done" as const, href: step.explorerUrl }))} />
        </div>
      )}
    </div>
  );
}
