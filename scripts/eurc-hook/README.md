# EURC hook transfer (Sepolia → Arc)

Phase 1, Part B: sends EURC from Ethereum Sepolia into `HookReceiver` on Arc Testnet
with `hookData`, using CCTP for non-USDC assets (CrossChainTokenService).

## How the pieces connect

```
scripts/eurc-hook/hook.ts ──calls──▶ Arc Testnet ◀──deployed by── Arc Studio
                                     HookReceiver (address in deployments/arc-testnet.json)
```

- `src/HookReceiver.sol` is the master copy. Paste exactly this file into Arc Studio to deploy.
- After each deploy, put the new address in `deployments/arc-testnet.json` and in `.env` as `RECEIVER`.

## Settings used

- `autoExecuteHookData: true`, finality `2000`, no `FORWARD` in the quote
- `destinationAddress` = receiver as raw 20 bytes (not ABI-padded)
- Approve the **TokenManager**, not the service
- Attestation from `iris-api-sandbox.circle.com/v2/messages/0?transactionHash=…`,
  then `receiveMessage` on Arc's MessageTransmitterV2
- `hookData = abi.encode(string note, uint256 orderId)`

## Run

```bash
cp .env.example .env   # set PRIVATE_KEY and RECEIVER
npm install
npm start
```

The wallet needs Sepolia EURC + ETH, and a little Arc testnet USDC for gas.
Standard finality takes ~15-20 min. To finish an earlier send without sending again:

```bash
SOURCE_TX=0x... npm start
```

Done when the output shows `DONE: HookReceived emitted` with the decoded note and orderId.
