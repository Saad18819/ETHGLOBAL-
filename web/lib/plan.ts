export type AssetId = "USDC" | "EURC" | "WETH" | "cirBTC";
export type SourceId = "base" | "ethereum";
export type NextId = "pay" | "eurc" | "keep" | "pool" | "lend" | "loop";
export type Leverage = "1.3" | "1.5" | "1.7";
export type PayToken = "USDC" | "EURC";

export type Plan = {
  amount: string;
  asset: AssetId;
  from: SourceId;
  next: NextId;
  recipient: string;
  payAmount: string;
  payToken: PayToken;
  leverage: Leverage;
};

export const defaultPlan: Plan = {
  amount: "10",
  asset: "USDC",
  from: "base",
  next: "pay",
  recipient: "",
  payAmount: "9",
  payToken: "EURC",
  leverage: "1.5",
};

export const assets: Record<AssetId, { decimals: number; sources: SourceId[]; example: string }> = {
  USDC: { decimals: 6, sources: ["base"], example: "10" },
  EURC: { decimals: 6, sources: ["base", "ethereum"], example: "10" },
  WETH: { decimals: 18, sources: ["ethereum"], example: "0.01" },
  cirBTC: { decimals: 8, sources: ["ethereum"], example: "0.001" },
};

export const sources: Record<SourceId, { label: string; kitChain: string }> = {
  base: { label: "Base", kitChain: "Base_Sepolia" },
  ethereum: { label: "Ethereum", kitChain: "Ethereum_Sepolia" },
};

/// USDC goes through our router (CCTP for the money, CCIP for the instruction).
/// Everything else is bridged natively with Bridge Kit and finished from the wallet on Arc.
export function routeOf(plan: Pick<Plan, "asset">): "router" | "bridgekit" {
  return plan.asset === "USDC" ? "router" : "bridgekit";
}

export type NextStep = {
  id: NextId;
  title: string;
  body: string;
  verb: string;
  fits: (plan: Plan) => boolean;
};

export const nextSteps: NextStep[] = [
  {
    id: "pay",
    title: "Pay someone",
    body: "They get the exact amount on Arc, tagged with your invoice id.",
    verb: "pay",
    fits: () => true,
  },
  {
    id: "eurc",
    title: "Hold EURC",
    body: "Swap into euros through the Uniswap pool on Arc.",
    verb: "hold it as EURC",
    fits: (plan) => plan.asset === "USDC",
  },
  {
    id: "keep",
    title: "Keep it on Arc",
    body: "Land it in your wallet and decide later.",
    verb: "keep it",
    fits: () => true,
  },
  {
    id: "pool",
    title: "Uniswap pool on Arc",
    body: "Half becomes EURC, both sides go into the USDC/EURC pool. The position NFT is yours.",
    verb: "add it to the USDC/EURC pool",
    fits: (plan) => plan.asset === "USDC",
  },
  {
    id: "lend",
    title: "Lend on Morpho",
    body: "Deposit into a Morpho USDC vault on Arc and earn the lending rate.",
    verb: "lend it on Morpho",
    fits: (plan) => plan.asset === "USDC",
  },
  {
    id: "loop",
    title: "Loop it",
    body: "Borrow USDC against it on Morpho, buy more cirBTC, and add that as collateral.",
    verb: "loop it",
    fits: (plan) => plan.asset === "cirBTC",
  },
];

export const stepOf = (id: NextId) => nextSteps.find((s) => s.id === id)!;
