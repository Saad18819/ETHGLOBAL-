// Phase 3: one manual swap USDC -> EURC on the Uniswap v4 USDC/EURC pool on Arc Testnet.
// Pool: 0.05% fee, tick spacing 10, no hooks. It is shallow, so keep AMOUNT small (1 USDC works).

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const AMOUNT = process.env.AMOUNT ?? "1"; // USDC in
const SLIPPAGE_BPS = 100n; // 1%

// Uniswap v4 on Arc Testnet (checked on-chain)
const UNIVERSAL_ROUTER = "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1" as const;
const QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
const POOL_KEY = { currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: zeroAddress } as const;

const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");
const account = privateKeyToAccount(pk as Hex);
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const permit2 = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const quoter = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const router = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

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

/// V4_SWAP input: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f).
/// `withMinHop` = newer v4-periphery params (extra minHopPriceX36 field).
function v4SwapInput(amountIn: bigint, minOut: bigint, withMinHop: boolean): Hex {
  const swap = withMinHop
    ? encodeAbiParameters(
        [{ type: "tuple", components: [
          { name: "poolKey", ...keyType }, { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" },
        ] }],
        [{ poolKey: POOL_KEY, zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
      )
    : encodeAbiParameters(
        [{ type: "tuple", components: [
          { name: "poolKey", ...keyType }, { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ] }],
        [{ poolKey: POOL_KEY, zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: "0x" }],
      );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [USDC, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [EURC, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
}

async function main() {
  const amountIn = parseUnits(AMOUNT, 6);
  const bal = (t: `0x${string}`) => pub.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [account.address] });
  const [usdc0, eurc0] = await Promise.all([bal(USDC), bal(EURC)]);
  console.log(`Wallet ${account.address}`);
  console.log(`Before: ${formatUnits(usdc0, 6)} USDC, ${formatUnits(eurc0, 6)} EURC`);

  // 1. Quote
  const { result: [quoted] } = await pub.simulateContract({
    address: QUOTER, abi: quoter, functionName: "quoteExactInputSingle",
    args: [{ poolKey: POOL_KEY, zeroForOne: true, exactAmount: amountIn, hookData: "0x" }],
  });
  const minOut = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(`Quote: ${AMOUNT} USDC -> ${formatUnits(quoted, 6)} EURC (min ${formatUnits(minOut, 6)})`);

  // 2. Approvals: token -> Permit2, Permit2 -> UniversalRouter
  const a1 = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [account.address, PERMIT2] });
  if (a1 < amountIn) {
    const h = await wallet.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [PERMIT2, amountIn * 100n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`Approved Permit2: https://testnet.arcscan.app/tx/${h}`);
  }
  const [a2, exp] = await pub.readContract({ address: PERMIT2, abi: permit2, functionName: "allowance", args: [account.address, USDC, UNIVERSAL_ROUTER] });
  const now = Math.floor(Date.now() / 1000);
  if (a2 < amountIn || exp < now + 600) {
    const h = await wallet.writeContract({
      address: PERMIT2, abi: permit2, functionName: "approve",
      args: [USDC, UNIVERSAL_ROUTER, amountIn * 100n, now + 30 * 24 * 3600],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`Permit2 -> UniversalRouter: https://testnet.arcscan.app/tx/${h}`);
  }

  // 3. Swap (try the newer params format first, fall back to the older one)
  const deadline = BigInt(now + 600);
  let request;
  for (const withMinHop of [true, false]) {
    try {
      ({ request } = await pub.simulateContract({
        account, address: UNIVERSAL_ROUTER, abi: router, functionName: "execute",
        args: ["0x10", [v4SwapInput(amountIn, minOut, withMinHop)], deadline],
      }));
      console.log(`Router format: ${withMinHop ? "new (minHopPriceX36)" : "classic"}`);
      break;
    } catch (e: any) {
      console.log(`  ${withMinHop ? "new" : "classic"} format failed: ${e.shortMessage ?? e.message}`);
    }
  }
  if (!request) throw new Error("Swap simulation failed in both formats");

  const hash = await wallet.writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("Swap reverted");

  const [usdc1, eurc1] = await Promise.all([bal(USDC), bal(EURC)]);
  console.log(`\nDONE: swapped on Uniswap v4 (Arc)`);
  console.log(`  tx:   https://testnet.arcscan.app/tx/${hash}`);
  console.log(`  got:  ${formatUnits(eurc1 - eurc0, 6)} EURC`);
  console.log(`  After: ${formatUnits(usdc1, 6)} USDC (includes gas), ${formatUnits(eurc1, 6)} EURC`);
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
