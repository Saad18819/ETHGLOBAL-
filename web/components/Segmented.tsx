"use client";

import { useState } from "react";

import styles from "./Segmented.module.css";

/// A row of choices with an optional free value at the end, clamped to [min, max].
export function Segmented({
  label,
  value,
  options,
  onChange,
  custom,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  custom?: { min: number; max: number; suffix: string };
}) {
  const isPreset = options.some((option) => option.value === value);
  const [text, setText] = useState(isPreset ? "" : value);

  const commit = () => {
    if (!custom) return;
    const number = Number(text);
    if (!text || !Number.isFinite(number)) return;
    const clamped = String(Math.min(custom.max, Math.max(custom.min, number)));
    setText(clamped);
    onChange(clamped);
  };

  return (
    <div className={styles.field}>
      <span className={styles.caption}>{label}</span>
      <div className={styles.group} role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={styles.segment}
            onClick={() => {
              setText("");
              onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
        {custom && (
          <span className={styles.segment} data-custom aria-checked={!isPreset && text !== ""}>
            <input
              aria-label={`Custom ${label.toLowerCase()}`}
              inputMode="decimal"
              placeholder="Custom"
              value={text}
              onChange={(event) => /^\d*\.?\d*$/.test(event.target.value) && setText(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => event.key === "Enter" && commit()}
            />
            {text && custom.suffix}
          </span>
        )}
      </div>
    </div>
  );
}
