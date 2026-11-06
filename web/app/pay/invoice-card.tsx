import type { Address, Hex } from "viem";

import styles from "./pay.module.css";
import { protocols, swatchStyle } from "@/lib/brand";
import { base } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";

/// The invoice behind a pay link, in the column the next steps use elsewhere: what is owed, to whom,
/// and whether the receipt from Arc has marked it paid on Base yet.
export function InvoiceCard({
  id,
  memo,
  amount,
  token,
  payee,
  paid,
  book,
}: {
  id: Hex;
  memo: string;
  amount: string;
  token: string;
  payee: Address;
  paid: boolean;
  book?: Address;
}) {
  return (
    <aside className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{memo ? `Invoice for ${memo}` : "Invoice"}</span>
        <span className={styles.status} data-paid={paid || undefined} style={swatchStyle(protocols.arc)}>
          {paid ? "Paid" : "Waiting"}
        </span>
      </div>
      <div className={styles.owed}>
        {amount} {token}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Pay to</dt>
          <dd className="mono">{shortAddress(payee)}</dd>
        </div>
        <div>
          <dt>Settles on</dt>
          <dd>Arc, the exact amount</dd>
        </div>
        <div>
          <dt>Invoice</dt>
          <dd>
            {book ? (
              <a href={`${base.explorer}/address/${book}`} target="_blank" rel="noreferrer" className="mono">
                {id.slice(0, 10)}…
              </a>
            ) : (
              <span className="mono">{id.slice(0, 10)}…</span>
            )}{" "}
            on Base
          </dd>
        </div>
      </dl>
      <p className={styles.note}>
        Pay from any chain and token. The invoice on Base turns paid only when the receipt from Arc arrives over
        Chainlink CCIP.
      </p>
    </aside>
  );
}
