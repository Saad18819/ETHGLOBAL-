import { sources, type SourceId } from "./chains";

export type { SourceId } from "./chains";

export type AssetId = "USDC" | "EURC" | "ETH" | "WETH" | "cirBTC";
export type NextId = "pay" | "hold" | "keep" | "pool" | "lend" | "loop";
export type PayToken = "USDC" | "EURC" | "cirBTC";
export type HoldToken = "EURC" | "cirBTC";
export type Range = "full" | "20" | "5" | "1";
export type Speed = "fast" | "standard";

export type Plan = {
  amount: string;
  asset: AssetId;
  from: SourceId;
  next: NextId;
  recipient: string;
  payAmount: string;
  payToken: PayToken;
  hold: HoldToken;
  range: Range;
  vault: string;
  leverage: string;
  speed: Speed;
  slippage: string;
  /// Where the result of a non-payment goes. Empty means the connected wallet.
  to: string;
};

export const defaultPlan: Plan = {
  amount: "10",
  asset: "USDC",
  from: "base",
  next: "pay",
  recipient: "",
  payAmount: "9",
  payToken: "EURC",
  hold: "EURC",
  range: "full",
  vault: "",
  leverage: "1.5",
  speed: "fast",
  slippage: "0.1",
  to: "",
};

export const assets: Record<AssetId, { decimals: number; sources: SourceId[]; example: string }> = {
  USDC: { decimals: 6, sources: Object.keys(sources) as SourceId[], example: "10" },
  // CCTP for non-USDC routes from the Iris token list
  EURC: { decimals: 6, sources: ["base", "ethereum", "avalanche"], example: "10" },
  ETH: { decimals: 18, sources: ["ethereum"], example: "0.01" },
  WETH: { decimals: 18, sources: ["ethereum"], example: "0.01" },
  cirBTC: { decimals: 8, sources: ["ethereum"], example: "0.001" },
};

export const ranges: Record<Range, string> = {
  full: "full range",
  "20": "within 20% of the price",
  "5": "within 5%",
  "1": "within 1%",
};

/// ETH and WETH go through Uniswap on Ethereum into USDC first, unless WETH is just being moved as is.
export function viaUniswap(plan: Pick<Plan, "asset" | "next">): boolean {
  return plan.asset === "ETH" || (plan.asset === "WETH" && plan.next !== "keep");
}

/// The asset that leaves the source chain.
export const bridgedAsset = (plan: Plan): AssetId => (viaUniswap(plan) ? "USDC" : plan.asset);

/// Router: USDC from a chain with a CCIP lane, finished by the settlement contract.
/// Wallet: bridged with Bridge Kit, finished from the user's wallet on Arc with Circle kits.
export type Route = "router" | "wallet";

const routerActions: NextId[] = ["pay", "hold", "keep", "pool", "lend"];
const walletActions: NextId[] = ["pay", "hold", "keep", "pool", "lend", "loop"];

export function routeOf(plan: Plan): Route | undefined {
  const routerFits =
    bridgedAsset(plan) === "USDC" &&
    // Until the router is deployed on a chain, that chain uses the Bridge Kit route.
    Boolean(sources[plan.from].router?.address) &&
    routerActions.includes(plan.next) &&
    !(plan.next === "hold" && plan.hold !== "EURC") &&
    !(plan.next === "pay" && plan.payToken === "cirBTC");
  if (routerFits) return "router";
  return walletActions.includes(plan.next) ? "wallet" : undefined;
}

export type NextStep = {
  id: NextId;
  title: string;
  body: string;
  verb: string;
};

export const nextSteps: NextStep[] = [
  {
    id: "pay",
    title: "Pay someone",
    body: "They get the exact amount on Arc, in USDC or EURC, tagged with your invoice id.",
    verb: "pay",
  },
  {
    id: "hold",
    title: "Hold EURC or cirBTC",
    body: "Swap on arrival, through the Uniswap pool or Circle Swap.",
    verb: "hold it as",
  },
  {
    id: "keep",
    title: "Keep it on Arc",
    body: "Land it in your wallet and decide later.",
    verb: "keep it",
  },
  {
    id: "pool",
    title: "Uniswap pool on Arc",
    body: "Provide liquidity to USDC/EURC in the range you pick. The position NFT is yours.",
    verb: "add it to the USDC/EURC pool",
  },
  {
    id: "lend",
    title: "Lend on Morpho",
    body: "Deposit into a Morpho USDC vault on Arc and earn the lending rate.",
    verb: "lend it on",
  },
  {
    id: "loop",
    title: "Loop BTC",
    body: "Turn it into cirBTC, borrow USDC against it on Morpho, buy more, repeat.",
    verb: "loop cirBTC to",
  },
];

export const stepOf = (id: NextId) => nextSteps.find((s) => s.id === id)!;

/// Keeps a plan valid after one field changes.
export function normalizePlan(plan: Plan): Plan {
  const from = assets[plan.asset].sources.includes(plan.from) ? plan.from : assets[plan.asset].sources[0];
  const hold = plan.hold === plan.asset ? (plan.asset === "EURC" ? "cirBTC" : "EURC") : plan.hold;
  return { ...plan, from, hold };
}
