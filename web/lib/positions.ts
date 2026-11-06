import { encodeAbiParameters, encodePacked, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";

import { config } from "./config";
import { arc, erc20Abi } from "./contracts";
import { eurcPool } from "./quote";

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

export function fullRange(): [number, number] {
  const spacing = eurcPool.tickSpacing;
  return [Math.ceil(MIN_TICK / spacing) * spacing, Math.floor(MAX_TICK / spacing) * spacing];
}

async function approveForPositions(token: Address, account: Address, amount: bigint) {
  const allowance = await readContract(config, {
    chainId: arc.chainId,
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, PERMIT2],
  });
  if (allowance < amount) {
    const hash = await writeContract(config, {
      chainId: arc.chainId,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  }
  const [permitted, expiration] = await readContract(config, {
    chainId: arc.chainId,
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [account, token, POSITION_MANAGER],
  });
  if (permitted < amount || expiration < Date.now() / 1000 + 60) {
    const hash = await writeContract(config, {
      chainId: arc.chainId,
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, POSITION_MANAGER, amount, Math.floor(Date.now() / 1000) + 3600],
    });
    await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  }
}

/// Mints a USDC/EURC position from the wallet. USDC is currency0 in this pool.
export async function mintPosition(
  {
    account,
    owner,
    usdc,
    eurc,
    sqrtPrice,
    range,
  }: { account: Address; owner: Address; usdc: bigint; eurc: bigint; sqrtPrice: number; range: [number, number] },
  onStep: (label: string) => void,
): Promise<{ tokenId: bigint; hash: Hex }> {
  const [lower, upper] = range;
  const liquidity = liquidityFor(sqrtPrice, lower, upper, usdc, eurc);
  if (liquidity <= 0n) throw new Error("Not enough on both sides to open a position");

  onStep("Approving the pool tokens");
  await approveForPositions(arc.usdc, account, usdc);
  await approveForPositions(arc.eurc, account, eurc);

  const key = { currency0: arc.usdc, currency1: arc.eurc, fee: eurcPool.fee, tickSpacing: eurcPool.tickSpacing, hooks: "0x0000000000000000000000000000000000000000" } as const;
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
    [key, lower, upper, liquidity, usdc, eurc, owner, "0x"],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "address" }], [arc.usdc, arc.eurc]);
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [encodePacked(["uint8", "uint8"], [0x02, 0x0d]), [mint, settle]],
  );

  const tokenId = await readContract(config, {
    chainId: arc.chainId,
    address: POSITION_MANAGER,
    abi: positionAbi,
    functionName: "nextTokenId",
  });
  onStep("Adding liquidity on Uniswap");
  const hash = await writeContract(config, {
    chainId: arc.chainId,
    address: POSITION_MANAGER,
    abi: positionAbi,
    functionName: "modifyLiquidities",
    args: [unlockData, BigInt(Math.floor(Date.now() / 1000) + 600)],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  return { tokenId, hash };
}
