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

/// A free numeric value next to the presets, clamped to [min, max].
export type Custom = { min: number; max: number; suffix: string; placeholder?: string };

export function Select<T extends string>({
  value,
  options,
  onChange,
  tone = "violet",
  label,
  custom,
  children,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  tone?: Tone;
  label: string;
  custom?: Custom;
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
          {custom && (
            <li>
              <CustomValue
                custom={custom}
                onSubmit={(next) => {
                  onChange(next as T);
                  setOpen(false);
                }}
              />
            </li>
          )}
        </ul>
      )}
    </span>
  );
}

function CustomValue({ custom, onSubmit }: { custom: Custom; onSubmit: (value: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const number = Number(text);
    if (!text || !Number.isFinite(number)) return;
    onSubmit(String(Math.min(custom.max, Math.max(custom.min, number))));
  };
  return (
    <form
      className={styles.custom}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        aria-label="Custom value"
        inputMode="decimal"
        placeholder={custom.placeholder ?? "Custom"}
        value={text}
        onChange={(event) => /^\d*\.?\d*$/.test(event.target.value) && setText(event.target.value)}
      />
      <span>{custom.suffix}</span>
      <button type="submit">Set</button>
    </form>
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  tone?: Tone;
  label: string;
  numeric?: boolean;
  hint?: string;
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
      {hint && <span className={styles.badge}>{hint}</span>}
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
