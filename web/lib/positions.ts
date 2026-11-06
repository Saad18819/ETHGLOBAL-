import { encodeAbiParameters, encodeFunctionData, encodePacked, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";

import { config } from "./config";
import { arc, erc20Abi } from "./contracts";
import { poolKeyOf, type PoolPair } from "./pools";

/// Uniswap v4 on Arc testnet (same addresses as Arc mainnet, docs.uniswap.org/contracts/v4/deployments)
const POSITION_MANAGER = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const positionAbi = parseAbi([
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function nextTokenId() view returns (uint256)",
  "function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) payable returns (int24)",
]);

const MIN_TICK = -887272;
const MAX_TICK = 887272;

const sqrtAtTick = (tick: number) => Math.pow(1.0001, tick / 2);

/// Liquidity a position in [lower, upper] can take from amount0 and amount1 at sqrtPrice, both in raw units.
function liquidityFor(sqrtPrice: number, lower: number, upper: number, amount0: bigint, amount1: bigint): bigint {
  const a = sqrtAtTick(lower);
  const b = sqrtAtTick(upper);
  const p = Math.min(Math.max(sqrtPrice, a), b);
  const from0 = p < b ? (Number(amount0) * p * b) / (b - p) : Infinity;
  const from1 = p > a ? Number(amount1) / (p - a) : Infinity;
  // Stay under what PositionManager will price the liquidity at after rounding.
  return BigInt(Math.floor(Math.min(from0, from1) * 0.995));
}

export function fullRange(spacing: number): [number, number] {
  return [Math.ceil(MIN_TICK / spacing) * spacing, Math.floor(MAX_TICK / spacing) * spacing];
}

/// Arc's predeployed batcher. Each call in a batch runs through the CallFrom precompile, so every target
/// sees the wallet as msg.sender: approvals and the mint go out as one transaction
/// (docs.arc.io/arc/concepts/batched-transactions).
const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const batcherAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])",
]);
type Call = { target: Address; allowFailure: boolean; callData: Hex };

/// Permit2 allowances are granted for the full amount and 30 days, as Uniswap's own app does, so repeat
/// moves skip them. Permit2 only lets PositionManager pull in a transaction the wallet itself sends.
const MAX_UINT160 = 2n ** 160n - 1n;
const PERMIT_DAYS = 30;

/// The approvals PositionManager still needs for this amount of a token: the token to Permit2, then
/// Permit2 to PositionManager.
async function approvalCalls(token: Address, account: Address, amount: bigint): Promise<Call[]> {
  const [allowance, [permitted, expiration]] = await Promise.all([
    readContract(config, { chainId: arc.chainId, address: token, abi: erc20Abi, functionName: "allowance", args: [account, PERMIT2] }),
    readContract(config, {
      chainId: arc.chainId,
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [account, token, POSITION_MANAGER],
    }),
  ]);
  const calls: Call[] = [];
  if (allowance < amount) {
    calls.push({ target: token, allowFailure: false, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }) });
  }
  if (permitted < amount || expiration < Date.now() / 1000 + 600) {
    const until = Math.floor(Date.now() / 1000) + PERMIT_DAYS * 86_400;
    calls.push({
      target: PERMIT2,
      allowFailure: false,
      callData: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, POSITION_MANAGER, MAX_UINT160, until] }),
    });
  }
  return calls;
}

/// Mints a position from the wallet with what it holds of each side. A pool nobody has opened yet is
/// initialized at `open` in the same batch (Multicall3From: approvals, initializePool, then
/// modifyLiquidities).
export async function mintPosition(
  {
    account,
    owner,
    pair,
    amounts,
    sqrtPrice,
    range,
    open,
  }: {
    account: Address;
    owner: Address;
    pair: PoolPair;
    /// Raw amounts by symbol.
    amounts: Record<string, bigint>;
    sqrtPrice: number;
    range: [number, number];
    open?: bigint;
  },
  onStep: (label: string) => void,
): Promise<{ tokenId: bigint; hash: Hex }> {
  const { key, token0, token1 } = poolKeyOf(pair);
  const amount0 = amounts[token0.symbol] ?? 0n;
  const amount1 = amounts[token1.symbol] ?? 0n;
  const [lower, upper] = range;
  const liquidity = liquidityFor(sqrtPrice, lower, upper, amount0, amount1);
  if (liquidity <= 0n) throw new Error("Not enough on both sides to open a position");

  const approvals = [...(await approvalCalls(key.currency0, account, amount0)), ...(await approvalCalls(key.currency1, account, amount1))];

  const keyType = {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  } as const;

  // MINT_POSITION then SETTLE_PAIR (v4-periphery Actions 0x02, 0x0d)
  const mint = encodeAbiParameters(
    [keyType, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [key, lower, upper, liquidity, amount0, amount1, owner, "0x"],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "address" }], [key.currency0, key.currency1]);
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [encodePacked(["uint8", "uint8"], [0x02, 0x0d]), [mint, settle]],
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const tokenId = await readContract(config, {
    chainId: arc.chainId,
    address: POSITION_MANAGER,
    abi: positionAbi,
    functionName: "nextTokenId",
  });
  // Approvals, opening a new pool and the mint, all in one transaction.
  const calls: Call[] = [
    ...approvals,
    ...(open
      ? [{ target: POSITION_MANAGER as Address, allowFailure: false, callData: encodeFunctionData({ abi: positionAbi, functionName: "initializePool", args: [key, open] }) }]
      : []),
    {
      target: POSITION_MANAGER,
      allowFailure: false,
      callData: encodeFunctionData({ abi: positionAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
    },
  ];
  onStep(open ? `Opening the ${pair.id} pool and adding liquidity in one transaction` : "Approving and adding liquidity in one transaction");
  const hash = await writeContract(config, {
    chainId: arc.chainId,
    address: MULTICALL3_FROM,
    abi: batcherAbi,
    functionName: "aggregate3",
    args: [calls],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  return { tokenId, hash };
}
