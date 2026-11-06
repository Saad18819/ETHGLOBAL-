"use client";

import { useEffect, useState } from "react";

import styles from "./home.module.css";
import { BridgeBack } from "@/components/BridgeBack";
import { Composer } from "@/components/Composer";
import { History } from "@/components/History";

const tabs = [
  { id: "move", label: "Move" },
  { id: "history", label: "History" },
  { id: "back", label: "Bridge back" },
] as const;
type Tab = (typeof tabs)[number]["id"];

const fromHash = (): Tab => {
  const hash = window.location.hash.slice(1);
  return tabs.some((tab) => tab.id === hash) ? (hash as Tab) : "move";
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("move");
  // The tab lives in the URL hash, so a reload or a shared link opens the same one.
  useEffect(() => {
    const sync = () => setTab(fromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const open = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", next === "move" ? window.location.pathname : `#${next}`);
  };

  return (
    <main>
      <nav className={styles.tabs} role="tablist" aria-label="Sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={styles.tab}
            onClick={() => open(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {/* Move stays mounted so a running move and its sentence survive switching tabs. */}
      <div hidden={tab !== "move"}>
        <Composer compact />
      </div>
      {tab === "history" && (
        <div className={styles.panel}>
          <History />
        </div>
      )}
      {tab === "back" && (
        <div className={styles.panel}>
          <BridgeBack />
        </div>
      )}
    </main>
  );
}
