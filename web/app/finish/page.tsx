"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Hex } from "viem";
import { useConnection } from "wagmi";

import styles from "../invoice/invoice.module.css";
import { Field, Select } from "@/components/Pill";
import { sourceIds, sources, type SourceId } from "@/lib/chains";
import { arc } from "@/lib/contracts";
import { arcGas, mintOnArc, useTransfer } from "@/lib/finish";
import { isTestnet } from "@/lib/network";

/// Arc produces a block about every half second.
const hoursLeft = (blocks: bigint) => Math.max(0, Number(blocks) / 7200);

function Finish() {
  const params = useSearchParams();
  const { address } = useConnection();
  const [from, setFrom] = useState<SourceId>((params.get("from") as SourceId) ?? "ethereum");
  const [tx, setTx] = useState(params.get("tx") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<Hex>();

  const transfer = useTransfer(sources[from]?.cctpDomain, tx.trim());
  const gas = useQuery({
    queryKey: ["arc-gas", address],
    queryFn: () => arcGas(address!),
    enabled: Boolean(address),
    refetchInterval: 10_000,
  });
  const data = transfer.data;
  const amount = data?.amount ? formatUnits(BigInt(data.amount) - BigInt(data.fee ?? "0"), 6) : undefined;
  const ready = data?.state === "attested" && data.toArc && !data.minted && data.openToAnyCaller;
  const noGas = gas.data !== undefined && gas.data.value === 0n;

  async function mint() {
    if (!data?.message || !data.attestation) return;
    setBusy(true);
    setError(undefined);
    try {
      setHash(await mintOnArc(data.message, data.attestation));
      await transfer.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.split("\n")[0] : "The mint did not go through");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.sentence}>
        Finish the transfer sent from{" "}
        <Select<SourceId>
          label="From"
          tone="stone"
          value={from}
          options={sourceIds.map((id) => ({ value: id, label: sources[id].label }))}
          onChange={setFrom}
        />{" "}
        in <Field label="Transaction" tone="sand" placeholder="0x…" value={tx} onChange={setTx} maxChars={9} />.
      </div>
      <p className={styles.hint}>
        A transfer is burned on the source chain and minted on Arc once Circle attests it. If the mint never
        happened, it can be submitted from any wallet with a little USDC on Arc for gas; the USDC still goes to
        the address it was sent to.
      </p>

      {data && (
        <p className={styles.hint}>
          {data.state === "not found" && "Circle has no transfer for this transaction on that chain."}
          {data.state === "pending" && "Circle is still attesting the burn. This page checks again every few seconds."}
          {data.state === "attested" && !data.toArc && "This transfer goes to another chain, not Arc."}
          {data.state === "attested" && data.toArc && data.minted && `Done: ${amount} USDC is on Arc.`}
          {ready &&
            `${amount} USDC is attested and waiting to be minted to ${data.mintRecipient} on Arc` +
              (data.blocksLeft !== undefined ? `, about ${hoursLeft(data.blocksLeft).toFixed(0)} hours before it expires.` : ".")}
          {data.state === "attested" && data.toArc && !data.minted && !data.openToAnyCaller &&
            "Only a specific contract can deliver this transfer, so it cannot be finished from a wallet."}
        </p>
      )}

      <div className={styles.actions}>
        <button className={styles.primary} disabled={!ready || !address || noGas || busy} onClick={mint}>
          {busy ? "Minting" : "Mint on Arc"}
        </button>
        {!address && <span className={styles.muted}>Connect a wallet first</span>}
        {address && ready && noGas && (
          <span className={styles.muted}>
            Your wallet needs a little USDC on Arc for gas
            {isTestnet && (
              <>
                {", "}
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  from Circle&apos;s faucet
                </a>
              </>
            )}
            .
          </span>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {hash && (
        <p className={styles.link}>
          <a href={`${arc.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
            Minted on Arc
          </a>
        </p>
      )}
    </main>
  );
}

export default function FinishPage() {
  return (
    <Suspense>
      <Finish />
    </Suspense>
  );
}
