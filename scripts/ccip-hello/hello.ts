// Phase 2: send a "hello" message Arc Testnet -> Ethereum Sepolia over Chainlink CCIP,
// paying the fee in Arc's native USDC, and time the delivery.
//
// First run deploys HelloReceiver on Sepolia and saves its address to
// deployments/sepolia-testnet.json; later runs reuse it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

// ---------- config ----------
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const TEXT = process.env.TEXT ?? "hello from arc";

const ARC_ROUTER = "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8" as const;
const SEPOLIA_ROUTER = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59" as const;
const SEPOLIA_SELECTOR = 16015286601757825753n;

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = path.resolve(here, "../../deployments/sepolia-testnet.json");

// ---------- clients ----------
const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");
const account = privateKeyToAccount(pk as Hex);

const arcPublic = createPublicClient({ chain: arcTestnet, transport: http() });
const arcWallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
const sepPublic = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });

// ---------- ABIs ----------
const routerAbi = [
  {
    name: "getFee", type: "function", stateMutability: "view",
    inputs: [{ name: "destinationChainSelector", type: "uint64" }, { name: "message", type: "tuple", components: [
      { name: "receiver", type: "bytes" },
      { name: "data", type: "bytes" },
      { name: "tokenAmounts", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
      { name: "feeToken", type: "address" },
      { name: "extraArgs", type: "bytes" },
    ] }],
    outputs: [{ name: "fee", type: "uint256" }],
  },
  {
    name: "ccipSend", type: "function", stateMutability: "payable",
    inputs: [{ name: "destinationChainSelector", type: "uint64" }, { name: "message", type: "tuple", components: [
      { name: "receiver", type: "bytes" },
      { name: "data", type: "bytes" },
      { name: "tokenAmounts", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
      { name: "feeToken", type: "address" },
      { name: "extraArgs", type: "bytes" },
    ] }],
    outputs: [{ name: "messageId", type: "bytes32" }],
  },
] as const;

const helloEvent = parseAbiItem(
  "event HelloReceived(bytes32 indexed messageId, uint64 sourceChainSelector, address sender, string text, uint256 sentAt)",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

// ---------- Sepolia receiver ----------
function compileReceiver() {
  const source = fs.readFileSync(path.join(here, "HelloReceiver.sol"), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "HelloReceiver.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  const c = out.contracts["HelloReceiver.sol"].HelloReceiver;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
}

async function getReceiver(): Promise<Address> {
  if (fs.existsSync(DEPLOYMENTS)) {
    const saved = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
    const addr = saved?.contracts?.HelloReceiver?.address as Address | undefined;
    if (addr && (await sepPublic.getCode({ address: addr }))) {
      console.log(`Using HelloReceiver on Sepolia: ${addr}`);
      return addr;
    }
  }
  console.log("Deploying HelloReceiver on Sepolia (one time)...");
  const { abi, bytecode } = compileReceiver();
  const hash = await sepWallet.deployContract({ abi, bytecode, args: [SEPOLIA_ROUTER] });
  const rcpt = await sepPublic.waitForTransactionReceipt({ hash });
  const addr = rcpt.contractAddress!;
  console.log(`Deployed: https://sepolia.etherscan.io/address/${addr}`);
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify({
    chainId: 11155111,
    network: "Ethereum Sepolia",
    contracts: { HelloReceiver: { address: addr, source: "scripts/ccip-hello/HelloReceiver.sol", deployTx: hash } },
    external: { CCIPRouter: SEPOLIA_ROUTER },
  }, null, 2) + "\n");
  return addr;
}

// ---------- main ----------
async function main() {
  console.log(`Wallet: ${account.address}`);
  const gas = await arcPublic.getBalance({ address: account.address });
  console.log(`Arc USDC (native): ${formatUnits(gas, 18)}`);

  const receiver = await getReceiver();

  const sentAt = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    receiver: encodeAbiParameters([{ type: "address" }], [receiver]),
    data: encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [TEXT, sentAt]),
    tokenAmounts: [],
    feeToken: zeroAddress, // pay in native USDC
    extraArgs: "0x" as Hex,  // default: 200k gas on Sepolia, enough for an event
  };

  const fee = await arcPublic.readContract({
    address: ARC_ROUTER, abi: routerAbi, functionName: "getFee", args: [SEPOLIA_SELECTOR, message],
  });
  console.log(`CCIP fee: ${formatUnits(fee, 18)} USDC (native)`);
  if (gas < fee) throw new Error("Not enough Arc USDC for the fee (faucet.circle.com)");

  const startBlock = await sepPublic.getBlockNumber();

  // Simulate first to learn the messageId, then send for real
  const { request, result: messageId } = await arcPublic.simulateContract({
    account, address: ARC_ROUTER, abi: routerAbi, functionName: "ccipSend",
    args: [SEPOLIA_SELECTOR, message], value: fee,
  });
  const t0 = Date.now();
  const tx = await arcWallet.writeContract(request);
  const rcpt = await arcPublic.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error("ccipSend reverted");
  console.log(`Arc tx:     https://testnet.arcscan.app/tx/${tx}`);
  console.log(`Message ID: ${messageId}`);
  console.log(`Track it:   https://ccip.chain.link/msg/${messageId}`);
  console.log("Waiting for delivery on Sepolia...");

  for (let i = 0; ; i++) {
    const logs = await sepPublic.getLogs({
      address: receiver, event: helloEvent, args: { messageId }, fromBlock: startBlock,
    }).catch(() => []);
    if (logs.length) {
      const ev = logs[0].args;
      const took = Date.now() - t0;
      console.log("\nDONE: HelloReceived on Sepolia");
      console.log(`  text:     ${ev.text}`);
      console.log(`  from:     ${ev.sender}`);
      console.log(`  Sepolia:  https://sepolia.etherscan.io/tx/${logs[0].transactionHash}`);
      console.log(`  DELIVERY TIME: ${secs(took)} (~${(took / 60000).toFixed(1)} min)`);
      return;
    }
    if (i % 4 === 0) console.log(`  still waiting... ${secs(Date.now() - t0)}`);
    if (Date.now() - t0 > 60 * 60 * 1000) {
      throw new Error(`Not delivered after 60 min. Check https://ccip.chain.link/msg/${messageId}`);
    }
    await sleep(15_000);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
