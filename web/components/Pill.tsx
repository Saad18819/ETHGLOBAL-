"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import styles from "./Pill.module.css";

type Tone = "violet" | "green" | "sand";

export type Option<T extends string> = {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export function Select<T extends string>({
  value,
  options,
  onChange,
  tone = "violet",
  label,
  children,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  tone?: Tone;
  label: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <span className={styles.anchor} ref={ref}>
      <button
        type="button"
        className={`${styles.pill} ${styles[tone]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? current?.label}
        <Chevron />
      </button>
      {open && (
        <ul className={styles.menu} role="listbox" id={listId}>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                className={styles.option}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.hint && <span className={styles.optionHint}>{option.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

export function Field({
  value,
  onChange,
  placeholder,
  tone = "green",
  label,
  numeric,
  hint,
  warn,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  tone?: Tone;
  label: string;
  numeric?: boolean;
  hint?: string;
  warn?: boolean;
}) {
  const width = Math.max((value || placeholder || "").length, numeric ? 1 : 4);
  return (
    <span className={`${styles.pill} ${styles[tone]} ${styles.field}`}>
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        inputMode={numeric ? "decimal" : "text"}
        spellCheck={false}
        autoComplete="off"
        style={{ width: `${width + 0.15}ch` }}
        onChange={(event) => {
          const next = event.target.value;
          if (numeric && !/^\d*\.?\d*$/.test(next)) return;
          onChange(next);
        }}
      />
      {hint && <span className={`${styles.badge} ${warn ? styles.warn : ""}`}>{hint}</span>}
    </span>
  );
}

export function Fixed({ children, tone = "violet" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`${styles.pill} ${styles[tone]} ${styles.fixed}`}>{children}</span>;
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
