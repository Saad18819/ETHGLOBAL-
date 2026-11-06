// Phase 9: one real payment through the contract route, end to end, timed.
//
//   Sepolia: AndThenRouter.send()  -> CCTP burn (hook = intent hash) + CCIP intent
//   Arc:     CCIP delivers the intent to AndThenSettlement (IntentReceived)
//   Arc:     we relay Circle's attestation: Settlement.receiveFunds()   (Funded)
//   Arc:     Settlement pays the recipient                               (Settled)
//
// Env: PRIVATE_KEY, optional AMOUNT (USDC to bridge, default 1), PAY (USDC to pay, default 0.9),
// RECIPIENT (default: your wallet), FAST (default true), SOURCE_TX (resume an earlier send).

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

// ---------- deployed (deployments/andthen-testnet.json) ----------
const ROUTER: Address = "0x29C7119964c2aa6cB66Ade33D73832c9c7da6c3f"; // Sepolia
const SETTLEMENT: Address = "0xddc5b10c8e8001d5bd385025ad9dfc6a56d38bb3"; // Arc, deployed by Arc Studio
const SEPOLIA_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
const IRIS = "https://iris-api-sandbox.circle.com";
const SEPOLIA_DOMAIN = 0;
const ARC_DOMAIN = 26;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://sepolia.gateway.tenderly.co";

// ---------- config ----------
const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");
const account = privateKeyToAccount(pk as Hex);
const AMOUNT = parseUnits(process.env.AMOUNT ?? "1", 6);
const PAY = parseUnits(process.env.PAY ?? "0.9", 6);
const RECIPIENT = (process.env.RECIPIENT as Address | undefined) ?? account.address;
const FAST = (process.env.FAST ?? "true") !== "false";
const SOURCE_TX = process.env.SOURCE_TX as Hex | undefined;

const sep = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const arc = createPublicClient({ chain: arcTestnet, transport: http() });
const arcWallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

// ---------- ABIs ----------
const intentComponents = [
  { name: "id", type: "bytes32" },
  { name: "payer", type: "address" },
  { name: "action", type: "uint8" },
  { name: "recipient", type: "address" },
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "limit", type: "uint256" },
  { name: "deadline", type: "uint64" },
  { name: "refundTo", type: "address" },
  { name: "invoiceId", type: "bytes32" },
  { name: "replyTo", type: "address" },
  { name: "data", type: "bytes" },
] as const;
const intentType = { type: "tuple", components: intentComponents } as const;

const routerAbi = [
  { type: "function", name: "send", stateMutability: "payable",
    inputs: [{ name: "intent", ...intentType }, { name: "amount", type: "uint256" }, { name: "maxFee", type: "uint256" }, { name: "cctpFinality", type: "uint32" }],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ name: "intent", ...intentType }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Sent", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "payer", type: "address", indexed: true },
    { name: "invoiceId", type: "bytes32", indexed: true }, { name: "usdcAmount", type: "uint256", indexed: false },
    { name: "ccipMessageId", type: "bytes32", indexed: false }] },
] as const;

const settlementAbi = parseAbi([
  "function receiveFunds(bytes message, bytes attestation)",
  "event IntentReceived(bytes32 indexed key, bytes32 indexed id, uint64 indexed sourceChain, address payer)",
  "event Funded(bytes32 indexed key, uint256 amount)",
  "event Settled(bytes32 indexed key, bytes32 indexed invoiceId, address payer, address indexed recipient, address token, uint256 amount)",
  "event SettlementFailed(bytes32 indexed key, bytes reason)",
  "event Claimable(address indexed account, uint256 amount)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

type Intent = {
  id: Hex; payer: Address; action: number; recipient: Address; token: Address; amount: bigint;
  limit: bigint; deadline: bigint; refundTo: Address; invoiceId: Hex; replyTo: Address; data: Hex;
};
const keyOf = (i: Intent) => keccak256(encodeAbiParameters([intentType], [i]));

async function send(): Promise<{ tx: Hex; key: Hex }> {
  const intent: Intent = {
    id: `0x${"00".repeat(32)}`, // set by the router
    payer: zeroAddress,         // set by the router
    action: 0,                  // Pay: deliver exactly `amount` of `token` to `recipient`
    recipient: RECIPIENT,
    token: ARC_USDC,
    amount: PAY,
    limit: AMOUNT,              // never spend more than what was bridged
    deadline: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
    refundTo: zeroAddress,      // leftovers and refunds go to the payer on Arc
    invoiceId: `0x${"00".repeat(32)}`,
    replyTo: zeroAddress,       // no receipt back to Sepolia
    data: "0x",
  };

  const usdcBal = await sep.readContract({ address: SEPOLIA_USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
  console.log(`Sepolia USDC: ${formatUnits(usdcBal, 6)}`);
  if (usdcBal < AMOUNT) throw new Error("Not enough Sepolia USDC (faucet.circle.com)");

  const allowance = await sep.readContract({ address: SEPOLIA_USDC, abi: erc20, functionName: "allowance", args: [account.address, ROUTER] });
  if (allowance < AMOUNT) {
    const h = await sepWallet.writeContract({ address: SEPOLIA_USDC, abi: erc20, functionName: "approve", args: [ROUTER, AMOUNT] });
    await sep.waitForTransactionReceipt({ hash: h });
    console.log(`[${at()}] Approved router: https://sepolia.etherscan.io/tx/${h}`);
  }

  // CCTP fee for fast transfers is quoted in basis points
  const finality = FAST ? 1000 : 2000;
  const fees = (await (await fetch(`${IRIS}/v2/burn/USDC/fees/${SEPOLIA_DOMAIN}/${ARC_DOMAIN}`)).json()) as { finalityThreshold: number; minimumFee: number }[];
  const bps = fees.find((f) => f.finalityThreshold === finality)?.minimumFee ?? 0;
  const maxFee = (AMOUNT * BigInt(Math.ceil(bps * 100)) + 999_999n) / 1_000_000n * 2n; // 2x headroom
  if (AMOUNT - maxFee < PAY) throw new Error(`PAY too high: after a CCTP fee of up to ${formatUnits(maxFee, 6)}, less than ${formatUnits(PAY, 6)} may arrive`);

  const ccipFee = await sep.readContract({ address: ROUTER, abi: routerAbi, functionName: "quote", args: [intent] });
  console.log(`CCTP: ${FAST ? "fast" : "standard"}, max fee ${formatUnits(maxFee, 6)} USDC · CCIP fee ${formatUnits(ccipFee, 18)} ETH`);

  const { request } = await sep.simulateContract({
    account, address: ROUTER, abi: routerAbi, functionName: "send",
    args: [intent, AMOUNT, maxFee, finality], value: (ccipFee * 12n) / 10n, // excess is refunded
  });
  const tx = await sepWallet.writeContract(request);
  const rcpt = await sep.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error("Router.send reverted");

  const sent = rcpt.logs
    .filter((l) => l.address.toLowerCase() === ROUTER.toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((e) => e?.eventName === "Sent");
  if (!sent || sent.eventName !== "Sent") throw new Error("No Sent event");

  const key = keyOf({ ...intent, id: sent.args.id, payer: account.address });
  console.log(`[${at()}] Sent on Sepolia: https://sepolia.etherscan.io/tx/${tx}`);
  console.log(`  intent id  ${sent.args.id}`);
  console.log(`  order key  ${key}`);
  console.log(`  CCIP       https://ccip.chain.link/msg/${sent.args.ccipMessageId}`);
  return { tx, key };
}

async function attestation(tx: Hex) {
  for (;;) {
    const res = await fetch(`${IRIS}/v2/messages/${SEPOLIA_DOMAIN}?transactionHash=${tx}`).catch(() => null);
    if (res?.ok) {
      const m = ((await res.json()) as { messages?: { message: Hex; attestation: string; status: string }[] }).messages?.[0];
      if (m?.status === "complete" && m.attestation.startsWith("0x")) return { message: m.message, attestation: m.attestation as Hex };
    }
    if (Date.now() - t0 > 45 * 60_000) throw new Error(`No attestation after 45 min. Resume with SOURCE_TX=${tx}`);
    await sleep(5_000);
  }
}

async function main() {
  console.log(`Wallet ${account.address} → pay ${formatUnits(PAY, 6)} USDC to ${RECIPIENT} on Arc\n`);
  const fromBlock = await arc.getBlockNumber();
  const recipientBefore = await arc.readContract({ address: ARC_USDC, abi: erc20, functionName: "balanceOf", args: [RECIPIENT] });

  let tx: Hex;
  let key: Hex | undefined;
  if (SOURCE_TX) {
    tx = SOURCE_TX;
    console.log(`Resuming ${tx} (order key unknown, watching all Settlement events)`);
  } else {
    ({ tx, key } = await send());
  }

  // Relay the CCTP burn while CCIP delivers the intent on its own
  console.log(`[${at()}] Waiting for Circle's attestation...`);
  const { message, attestation: att } = await attestation(tx);
  console.log(`[${at()}] Attested. Relaying to Arc: Settlement.receiveFunds()`);
  try {
    const { request } = await arc.simulateContract({ account, address: SETTLEMENT, abi: settlementAbi, functionName: "receiveFunds", args: [message, att] });
    const h = await arcWallet.writeContract(request);
    const r = await arc.waitForTransactionReceipt({ hash: h });
    console.log(`[${at()}] receiveFunds ${r.status}: https://testnet.arcscan.app/tx/${h}`);
  } catch (e: any) {
    // Someone else (the app's relayer) may have relayed it already
    console.log(`[${at()}] receiveFunds not sent: ${e.shortMessage ?? e.message}`);
  }

  // Watch Settlement until the order settles or fails
  const seen = new Set<string>();
  let from = fromBlock;
  for (;;) {
    const latest = await arc.getBlockNumber().catch(() => from);
    const to = latest - from > 4000n ? from + 4000n : latest;
    const logs = await arc.getLogs({ address: SETTLEMENT, fromBlock: from, toBlock: to }).catch(() => null);
    if (logs === null) { await sleep(4_000); continue; }
    from = to + 1n;
    for (const l of logs) {
      let ev;
      try { ev = decodeEventLog({ abi: settlementAbi, data: l.data, topics: l.topics }); } catch { continue; }
      const evKey = (ev.args as { key?: Hex }).key;
      if (key && evKey && evKey !== key) continue;
      const id = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const where = `https://testnet.arcscan.app/tx/${l.transactionHash}`;
      if (ev.eventName === "IntentReceived") console.log(`[${at()}] IntentReceived (CCIP intent arrived) ${where}`);
      if (ev.eventName === "Funded") console.log(`[${at()}] Funded ${formatUnits(ev.args.amount, 6)} USDC (CCTP mint) ${where}`);
      if (ev.eventName === "Claimable") console.log(`[${at()}] Claimable ${formatUnits(ev.args.amount, 6)} for ${ev.args.account}`);
      if (ev.eventName === "SettlementFailed") {
        console.log(`[${at()}] SettlementFailed: ${ev.args.reason} ${where}`);
        process.exit(1);
      }
      if (ev.eventName === "Settled") {
        const after = await arc.readContract({ address: ARC_USDC, abi: erc20, functionName: "balanceOf", args: [RECIPIENT] });
        console.log(`\nDONE: Settled on Arc in ${at()}`);
        console.log(`  paid      ${formatUnits(ev.args.amount, 6)} USDC to ${ev.args.recipient}`);
        console.log(`  tx        ${where}`);
        console.log(`  recipient balance change ${formatUnits(after - recipientBefore, 6)} USDC (includes gas if you paid yourself)`);
        return;
      }
    }
    if (Date.now() - t0 > 60 * 60_000) throw new Error("Not settled after 60 min");
    await sleep(4_000);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
