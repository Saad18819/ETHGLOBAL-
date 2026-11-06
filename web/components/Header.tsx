"use client";

import Link from "next/link";
import { useConnect, useConnection, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";

import styles from "./Header.module.css";
import { isTestnet } from "@/lib/network";

export function Header() {
  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const disconnect = useDisconnect();

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.mark}>
        andthen
      </Link>
      <nav className={styles.nav}>
        <Link href="/">Move</Link>
        <Link href="/invoice">Request a payment</Link>
        <Link href="/stats">Stats</Link>
      </nav>
      {isTestnet && (
        <span className={styles.network} title="Rates, APYs and volumes are read live from Arc mainnet. Every transaction runs on testnet, with test funds.">
          Market data from mainnet, transactions on Arc Testnet
        </span>
      )}
      {isConnected && address ? (
        <button className={styles.wallet} onClick={() => disconnect.mutate()} title="Disconnect">
          <span className={styles.dot} />
          <span className="mono">
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
        </button>
      ) : (
        <button className={styles.wallet} onClick={() => connect.mutate({ connector: injected() })}>
          Connect wallet
        </button>
      )}
    </header>
  );
}
