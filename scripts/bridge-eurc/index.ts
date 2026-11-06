// Phase 1, Part A: bridge 0.1 EURC from Ethereum Sepolia to Arc Testnet
// using Circle's CCTP for non-USDC assets (CrossChainTokenService).
// Forwarded mint: Circle completes the mint on Arc, so you need no Arc gas.
// Based on Circle's quickstart "Transfer EURC from Ethereum to Arc".

import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatEther,
  formatUnits,
  http,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

// ---------- config ----------
const AMOUNT = process.env.AMOUNT ?? "0.1"; // EURC to send
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

const CCTS = "0x63753E722bd2C2A5DF6EE19C5106662208B81077" as const; // same address on Sepolia and Arc
const ETHEREUM_DOMAIN = 0;
const ARC_DOMAIN = 26;
const IRIS = "https://iris-api-sandbox.circle.com";
const EURC_TOKEN_ID =
  "0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd" as const;
const FAST = 1000; // EURC supports fast transfer (it has an FX price)

// ---------- clients ----------
const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");
const account = privateKeyToAccount(pk as `0x${string}`);
const recipient = (process.env.RECIPIENT as `0x${string}` | undefined) ?? account.address;

const sepoliaPublic = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepoliaWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const arcPublic = createPublicClient({ chain: arcTestnet, transport: http() });

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Wallet:    ${account.address}`);
  console.log(`Recipient: ${recipient} (on Arc)`);

  // 1. Token metadata from Iris
  const infoRes = await fetch(`${IRIS}/v2/cctpx/tokens?tokenid=${EURC_TOKEN_ID}`);
  if (!infoRes.ok) throw new Error(`token info: ${await infoRes.text()}`);
  const { data } = (await infoRes.json()) as { data: { symbol: string; decimals: number }[] };
  const decimals = data[0].decimals;
  const amount = BigInt(Math.round(Number(AMOUNT) * 10 ** decimals));
  console.log(`Sending ${AMOUNT} ${data[0].symbol} (${amount} base units)`);

  // 2. Resolve contracts on both chains
  const [tokenManager, srcToken, dstToken] = await Promise.all([
    sepoliaPublic.readContract({ address: CCTS, abi: serviceAbi, functionName: "resolveTokenManager", args: [EURC_TOKEN_ID] }),
    sepoliaPublic.readContract({ address: CCTS, abi: serviceAbi, functionName: "resolveTokenAddress", args: [EURC_TOKEN_ID] }),
    arcPublic.readContract({ address: CCTS, abi: serviceAbi, functionName: "resolveTokenAddress", args: [EURC_TOKEN_ID] }),
  ]);
  console.log(`Sepolia EURC ${srcToken}, TokenManager ${tokenManager}`);
  console.log(`Arc EURC     ${dstToken}`);

  // 3. Balance checks
  const [eurcBal, ethBal] = await Promise.all([
    sepoliaPublic.readContract({ address: srcToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    sepoliaPublic.getBalance({ address: account.address }),
  ]);
  console.log(`Sepolia balances: ${formatUnits(eurcBal, decimals)} EURC, ${formatEther(ethBal)} ETH`);
  if (eurcBal < amount) throw new Error("Not enough Sepolia EURC. Get some at https://faucet.circle.com");

  // 4. Fast-transfer capacity (Circle's sample check had a rounding bug; this one compares properly)
  const alRes = await fetch(`${IRIS}/v2/cctpx/allowances`);
  if (!alRes.ok) throw new Error(`allowances: ${await alRes.text()}`);
  const { allowances } = (await alRes.json()) as { allowances: { tokenId: string; allowance: number }[] };
  const capacity = allowances.find((a) => a.tokenId.toLowerCase() === EURC_TOKEN_ID)?.allowance ?? 0;
  if (capacity < Number(AMOUNT)) throw new Error(`Fast-transfer capacity too low: ${capacity}`);

  // 5. Approve the TokenManager (NOT the service)
  const current = await sepoliaPublic.readContract({
    address: srcToken, abi: erc20Abi, functionName: "allowance", args: [account.address, tokenManager],
  });
  if (current < amount) {
    const h = await sepoliaWallet.writeContract({
      address: srcToken, abi: erc20Abi, functionName: "approve", args: [tokenManager, amount],
    });
    await sepoliaPublic.waitForTransactionReceipt({ hash: h });
    console.log(`Approved TokenManager: https://sepolia.etherscan.io/tx/${h}`);
  }

  // 6. Signed fee quote (fast + forwarded mint)
  const qRes = await fetch(`${IRIS}/v2/quote/cctpx/${EURC_TOKEN_ID}/${ETHEREUM_DOMAIN}/${ARC_DOMAIN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amount.toString(),
      feeToken: zeroAddress,
      requests: [
        { type: "PRE_FINALITY" },
        { type: "FORWARD", params: { msgType: "TransferMessage", destinationAddress: recipient } },
      ],
    }),
  });
  if (!qRes.ok) throw new Error(`quote: ${await qRes.text()}`);
  const quote = (await qRes.json()) as { signedQuote: `0x${string}`; feeTotalAmount: string };
  const fee = BigInt(quote.feeTotalAmount);
  console.log(`Fee: ${formatEther(fee)} ETH (paid on Sepolia, not taken from the EURC)`);

  // 7. Starting balance on Arc
  const startBal = await arcPublic.readContract({
    address: dstToken, abi: erc20Abi, functionName: "balanceOf", args: [recipient],
  });

  // 8. Send
  const tx = await sepoliaWallet.writeContract({
    address: CCTS,
    abi: serviceAbi,
    functionName: "crossChainTransfer",
    args: [
      EURC_TOKEN_ID,
      amount,
      ARC_DOMAIN,
      encodePacked(["address"], [recipient]), // raw 20 bytes, NOT abi.encode
      `0x${"00".repeat(32)}`,                   // destinationCaller: anyone
      FAST,
      { signedQuote: quote.signedQuote, refundAddress: zeroAddress },
      false,                                    // no hook in Part A
      "0x",
    ],
    value: fee,
  });
  console.log(`Source tx: https://sepolia.etherscan.io/tx/${tx}`);
  const rcpt = await sepoliaPublic.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error("Source transaction reverted");

  // 9. Wait for Circle to mint on Arc
  console.log("Waiting for the mint on Arc (usually under a minute with fast transfer)...");
  for (let i = 0; i < 120; i++) {
    const bal = await arcPublic.readContract({
      address: dstToken, abi: erc20Abi, functionName: "balanceOf", args: [recipient],
    });
    if (bal >= startBal + amount) {
      console.log(`Done after ~${i * 5}s. Arc EURC balance: ${formatUnits(bal, decimals)}`);
      console.log(`Check: https://testnet.arcscan.app/address/${recipient}`);
      return;
    }
    await sleep(5000);
  }
  throw new Error(`No mint after 10 min. Check status: ${IRIS}/v2/messages/${ETHEREUM_DOMAIN}?transactionHash=${tx}`);
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
