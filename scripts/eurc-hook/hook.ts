// Phase 1, Part B: bridge 0.1 EURC Sepolia -> Arc INTO a contract, with hookData.
// Differences from Part A (index.ts):
//   - destinationAddress = your HookReceiver on Arc (raw 20 bytes)
//   - autoExecuteHookData = true, hookData = abi.encode(string note, uint256 orderId)
//   - finality 2000 (standard), NO FORWARD in the quote
//   - you fetch the attestation from Iris and call receiveMessage on Arc yourself
//     (so your wallet needs a little Arc USDC for gas)

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  formatEther,
  formatUnits,
  http,
  isAddress,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

// ---------- config ----------
const AMOUNT = process.env.AMOUNT ?? "0.1";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const RECEIVER = process.env.RECEIVER as `0x${string}` | undefined; // HookReceiver on Arc
const NOTE = process.env.NOTE ?? "hello from sepolia";
const ORDER_ID = BigInt(process.env.ORDER_ID ?? "42");
// Set SOURCE_TX=0x... to skip sending and only finish an earlier transfer (attestation + receiveMessage)
const SOURCE_TX = process.env.SOURCE_TX as `0x${string}` | undefined;

const CCTS = "0x63753E722bd2C2A5DF6EE19C5106662208B81077" as const;
const ARC_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;
const ETHEREUM_DOMAIN = 0;
const ARC_DOMAIN = 26;
const IRIS = "https://iris-api-sandbox.circle.com";
const EURC_TOKEN_ID = "0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd" as const;
const FINALITY = 2000; // standard (finalized) transfer

// ---------- clients ----------
const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");
if (!RECEIVER || !isAddress(RECEIVER)) throw new Error("Set RECEIVER=0x... (your HookReceiver on Arc) in .env");
const account = privateKeyToAccount(pk as `0x${string}`);

const sepoliaPublic = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepoliaWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const arcPublic = createPublicClient({ chain: arcTestnet, transport: http() });
const arcWallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

// ---------- ABIs ----------
const serviceAbi = [
  { name: "resolveTokenManager", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { name: "resolveTokenAddress", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { name: "crossChainTransfer", type: "function", stateMutability: "payable",
    inputs: [
      { name: "tokenId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "destinationAddress", type: "bytes" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "claim", type: "tuple", components: [
        { name: "signedQuote", type: "bytes" },
        { name: "refundAddress", type: "address" },
      ] },
      { name: "autoExecuteHookData", type: "bool" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [] },
] as const;

const erc20Abi = [
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const transmitterAbi = [
  { name: "receiveMessage", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;

const receiverEventAbi = [
  { type: "event", name: "HookReceived", inputs: [
    { name: "sourceDomain", type: "uint32", indexed: false },
    { name: "sourceAddress", type: "bytes", indexed: false },
    { name: "tokenId", type: "bytes32", indexed: false },
    { name: "token", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "finalityThresholdExecuted", type: "uint32", indexed: false },
    { name: "note", type: "string", indexed: false },
    { name: "orderId", type: "uint256", indexed: false },
  ] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(): Promise<`0x${string}`> {
  const decimals = 6; // EURC
  const amount = BigInt(Math.round(Number(AMOUNT) * 10 ** decimals));

  const [tokenManager, srcToken] = await Promise.all([
    sepoliaPublic.readContract({ address: CCTS, abi: serviceAbi, functionName: "resolveTokenManager", args: [EURC_TOKEN_ID] }),
    sepoliaPublic.readContract({ address: CCTS, abi: serviceAbi, functionName: "resolveTokenAddress", args: [EURC_TOKEN_ID] }),
  ]);
  const bal = await sepoliaPublic.readContract({ address: srcToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  console.log(`Sepolia EURC balance: ${formatUnits(bal, decimals)}`);
  if (bal < amount) throw new Error("Not enough Sepolia EURC (faucet.circle.com)");

  // Approve the TokenManager, NOT the service
  const current = await sepoliaPublic.readContract({
    address: srcToken, abi: erc20Abi, functionName: "allowance", args: [account.address, tokenManager],
  });
  if (current < amount) {
    const h = await sepoliaWallet.writeContract({
      address: srcToken, abi: erc20Abi, functionName: "approve", args: [tokenManager, amount],
    });
    await sepoliaPublic.waitForTransactionReceipt({ hash: h });
    console.log(`Approved TokenManager ${tokenManager}: https://sepolia.etherscan.io/tx/${h}`);
  }

  // Quote: standard finality, no PRE_FINALITY, no FORWARD
  const qRes = await fetch(`${IRIS}/v2/quote/cctpx/${EURC_TOKEN_ID}/${ETHEREUM_DOMAIN}/${ARC_DOMAIN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amount.toString(), feeToken: zeroAddress, requests: [] }),
  });
  if (!qRes.ok) throw new Error(`quote: ${qRes.status} ${await qRes.text()}`);
  const quote = (await qRes.json()) as { signedQuote: `0x${string}`; feeTotalAmount: string };
  const fee = BigInt(quote.feeTotalAmount ?? "0");
  console.log(`Fee: ${formatEther(fee)} ETH`);

  const hookData = encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [NOTE, ORDER_ID]);

  const tx = await sepoliaWallet.writeContract({
    address: CCTS,
    abi: serviceAbi,
    functionName: "crossChainTransfer",
    args: [
      EURC_TOKEN_ID,
      amount,
      ARC_DOMAIN,
      encodePacked(["address"], [RECEIVER!]), // raw 20 bytes, NOT abi.encode
      `0x${"00".repeat(32)}`,                  // destinationCaller: anyone may call receiveMessage
      FINALITY,
      { signedQuote: quote.signedQuote, refundAddress: zeroAddress },
      true,                                    // autoExecuteHookData
      hookData,
    ],
    value: fee,
  });
  console.log(`Source tx: https://sepolia.etherscan.io/tx/${tx}`);
  const rcpt = await sepoliaPublic.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error("Source transaction reverted");
  return tx;
}

async function fetchAttestation(tx: `0x${string}`) {
  const url = `${IRIS}/v2/messages/${ETHEREUM_DOMAIN}?transactionHash=${tx}`;
  console.log(`Polling ${url}`);
  console.log("Standard finality on Sepolia takes ~15-20 min. If this times out, rerun with SOURCE_TX=" + tx);
  for (let i = 0; i < 180; i++) { // up to 30 min
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as { messages?: { message: `0x${string}`; attestation: string; status: string }[] };
      const m = body.messages?.[0];
      if (m && m.status === "complete" && m.attestation?.startsWith("0x")) {
        return { message: m.message, attestation: m.attestation as `0x${string}` };
      }
      if (i % 6 === 0) console.log(`  status: ${m?.status ?? "not indexed yet"} (${i * 10}s)`);
    } else if (res.status !== 404) {
      console.log(`  iris ${res.status}: ${await res.text()}`);
    }
    await sleep(10_000);
  }
  throw new Error(`No attestation after 30 min. Rerun with SOURCE_TX=${tx}`);
}

async function main() {
  console.log(`Wallet:   ${account.address}`);
  console.log(`Receiver: ${RECEIVER} (Arc)`);

  const arcGas = await arcPublic.getBalance({ address: account.address });
  console.log(`Arc gas balance: ${formatUnits(arcGas, 18)} USDC`);
  if (arcGas === 0n) throw new Error("Wallet needs Arc testnet USDC for gas to call receiveMessage (faucet.circle.com)");

  const tx = SOURCE_TX ?? (await send());
  const { message, attestation } = await fetchAttestation(tx);

  console.log("Calling receiveMessage on Arc MessageTransmitterV2...");
  const h = await arcWallet.writeContract({
    address: ARC_MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: "receiveMessage",
    args: [message, attestation],
  });
  const rcpt = await arcPublic.waitForTransactionReceipt({ hash: h });
  console.log(`Arc tx: https://testnet.arcscan.app/tx/${h} (${rcpt.status})`);
  if (rcpt.status !== "success") throw new Error("receiveMessage reverted");

  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== RECEIVER!.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: receiverEventAbi, data: log.data, topics: log.topics });
      console.log("\nDONE: HookReceived emitted");
      console.log(`  note:    ${ev.args.note}`);
      console.log(`  orderId: ${ev.args.orderId}`);
      console.log(`  amount:  ${formatUnits(ev.args.amount, 6)} EURC (token ${ev.args.token})`);
      console.log(`  from:    domain ${ev.args.sourceDomain}, ${ev.args.sourceAddress}`);
      return;
    } catch {}
  }
  console.log("receiveMessage succeeded but no HookReceived event from your receiver. Check the Arc tx logs.");
  process.exit(1);
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
