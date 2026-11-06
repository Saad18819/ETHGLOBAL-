import type { AssetId, NextId } from "./plan";

export type Swatch = { bg: string; ink: string; accent: string };

/// Token colors, light tints of each asset's own color so the sentence reads at a glance.
export const tokenColors: Record<AssetId, Swatch> = {
  USDC: { bg: "#e6f0fc", ink: "#1d5aa6", accent: "#2775ca" },
  EURC: { bg: "#e2f4f1", ink: "#0d6b62", accent: "#14a394" },
  ETH: { bg: "#ecebfc", ink: "#4746a8", accent: "#627eea" },
  WETH: { bg: "#ecebfc", ink: "#4746a8", accent: "#627eea" },
  cirBTC: { bg: "#fdefdf", ink: "#9a5200", accent: "#f7931a" },
};

export type Protocol = "arc" | "uniswap" | "morpho";

export const protocols: Record<Protocol, Swatch & { name: string }> = {
  arc: { name: "Arc", bg: "#e5e9f3", ink: "#14254f", accent: "#14254f" },
  uniswap: { name: "Uniswap", bg: "#ffe4f1", ink: "#b8006a", accent: "#ff007a" },
  morpho: { name: "Morpho", bg: "#e4edff", ink: "#1747c4", accent: "#2470ff" },
};

/// Which protocol does the work for each use case.
export const protocolOf: Record<NextId, Protocol> = {
  pay: "arc",
  hold: "arc",
  pool: "uniswap",
  lend: "morpho",
  loop: "morpho",
};

/// CSS variables a pill reads its colors from.
export const swatchStyle = (swatch: Swatch) =>
  ({ "--pill-bg": swatch.bg, "--pill-ink": swatch.ink, "--pill-accent": swatch.accent }) as React.CSSProperties;
