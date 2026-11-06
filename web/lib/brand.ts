import type { AssetId, NextId } from "./plan";
import { tokenBySymbol, type TokenKind } from "./tokens";

export type Swatch = { bg: string; ink: string; accent: string };

/// Light tints of each kind of asset's own color, so the sentence reads at a glance.
const kindColors: Record<TokenKind, Swatch> = {
  stable: { bg: "#e6f0fc", ink: "#1d5aa6", accent: "#2775ca" },
  eth: { bg: "#ecebfc", ink: "#4746a8", accent: "#627eea" },
  btc: { bg: "#fdefdf", ink: "#9a5200", accent: "#f7931a" },
  gold: { bg: "#faf3d9", ink: "#7a5c00", accent: "#c9a227" },
  defi: { bg: "#efeaf8", ink: "#5b3a9a", accent: "#8a63d2" },
  l2: { bg: "#fde8e8", ink: "#a12828", accent: "#e0484a" },
};

/// Tokens with a color of their own that people recognize.
const ownColors: Partial<Record<AssetId, Swatch>> = {
  EURC: { bg: "#e2f4f1", ink: "#0d6b62", accent: "#14a394" },
  USDT: { bg: "#e3f4ee", ink: "#16714f", accent: "#26a17b" },
  ARB: { bg: "#e5f1fb", ink: "#1b5c8f", accent: "#28a0f0" },
  LINK: { bg: "#e7ecfb", ink: "#2a46a8", accent: "#375bd2" },
  POL: { bg: "#f0e9fb", ink: "#6232b8", accent: "#8247e5" },
};

const fallback: Swatch = { bg: "#eeeeec", ink: "#3d3d3a", accent: "#8a8a85" };

export const tokenColor = (asset: AssetId): Swatch =>
  ownColors[asset] ?? (tokenBySymbol[asset] ? kindColors[tokenBySymbol[asset].kind] : fallback);

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
