// After deploying AndThenSettlement in Arc Studio: run the owner-only setup from YOUR wallet
// (Studio deploys from its own wallet, so these calls must come from the owner).
// Same steps as DeployArc in script/Deploy.s.sol:
//   setVault(Morpho USDC vault, true)
//   setPool(EURC, USDC/EURC 0.05% pool key)

import { createPublicClient, createWalletClient, http, isAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const SETTLEMENT = process.env.SETTLEMENT as `0x${string}` | undefined;
if (!SETTLEMENT || !isAddress(SETTLEMENT)) throw new Error("Set SETTLEMENT=0x... (the address Arc Studio deployed) in .env");
const pk = process.env.PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("Set PRIVATE_KEY=0x... in .env");

const USDC = "0x3600000000000000000000000000000000000000" as const;
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
const MORPHO_USDC_VAULT = "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC" as const;

const account = privateKeyToAccount(pk as Hex);
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

const abi = parseAbi([
  "function owner() view returns (address)",
  "function setVault(address vault, bool allowed)",
  "function setPool(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
]);

async function send(label: string, fn: "setVault" | "setPool", args: any) {
  const { request } = await pub.simulateContract({ account, address: SETTLEMENT!, abi, functionName: fn, args });
  const hash = await wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${r.status} https://testnet.arcscan.app/tx/${hash}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
}

async function main() {
  const owner = await pub.readContract({ address: SETTLEMENT!, abi, functionName: "owner" });
  console.log(`Settlement ${SETTLEMENT}`);
  console.log(`Owner      ${owner}`);
  console.log(`You        ${account.address}`);
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("You are not the owner. Redeploy in Studio with initialOwner = your wallet.");
  }

  await send("setVault (Morpho USDC vault)", "setVault", [MORPHO_USDC_VAULT, true]);
  await send("setPool (USDC/EURC 0.05%)", "setPool", [
    EURC,
    { currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: zeroAddress },
  ]);
  console.log("\nDONE: Settlement is set up on Arc.");
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
