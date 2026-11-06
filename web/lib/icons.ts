import type { Protocol } from "./brand";
import type { SourceId } from "./chains";

/// Logos in public/icons. Most come from web3icons (MIT); MORPHO, ENA, ONDO and WETH from Trust Wallet
/// assets; cbBTC from SmolDapp token assets.
const tokenFiles: Record<string, string> = {
  USDC: "usdc.svg",
  EURC: "eurc.svg",
  USDT: "usdt.svg",
  DAI: "dai.svg",
  PYUSD: "pyusd.svg",
  ETH: "eth.svg",
  WETH: "weth.png",
  BTC: "btc.svg",
  WBTC: "wbtc.svg",
  cbBTC: "cbbtc.svg",
  // Circle's BTC on Arc has no logo of its own yet.
  cirBTC: "btc.svg",
  XAUt: "xaut.svg",
  PAXG: "paxg.svg",
  LINK: "link.svg",
  UNI: "uni.svg",
  AAVE: "aave.svg",
  LDO: "ldo.svg",
  PENDLE: "pendle.svg",
  MORPHO: "morpho.png",
  ENA: "ena.png",
  ONDO: "ondo.png",
  OP: "op.svg",
  ARB: "arb.svg",
  POL: "pol.svg",
  AVAX: "avax.svg",
};

export const tokenIcon = (symbol: string) => (tokenFiles[symbol] ? `/icons/tokens/${tokenFiles[symbol]}` : undefined);

export const chainIcon = (id: SourceId) => `/icons/chains/${id}.svg`;

export const protocolIcon: Record<Protocol, string> = {
  arc: "/icons/chains/arc.svg",
  uniswap: "/icons/uniswap.svg",
  morpho: "/icons/morpho.png",
};
