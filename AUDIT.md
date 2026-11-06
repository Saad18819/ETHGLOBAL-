# andthen security review

Written by Arc Studio (studio.arc.io) from a read of the contracts, then addressed in this repo. The response to each finding is at the end; regression tests for the fixes are in `test/AndThen.t.sol`.

Scope: `AndThenSettlement`, `AndThenRouter`, `InvoiceBook`, `UniswapV4Swapper`, `ICCTP`, `Intent` (staged under `context/src/`, not modified). Balanced depth, target Arc Testnet (CCTP domain 26 confirmed against the project's chain registry).

## Limits of this review

- The contracts could not be compiled and Slither could not run: the Chainlink CCIP 2.0, Uniswap v4 (core and periphery) and Permit2 packages are not installed in the workspace. Findings come from manual source review plus two independent read-throughs.
- CCIP 2.0 specifics (`CCIPReceiver`, `ExtraArgsCodec`, `FinalityCodec`, `getCCVsAndFinalityConfig`) and the Uniswap/Permit2 call signatures were checked against their documented behaviour, not their source. Re-check them once the packages are installed.
- Assumed from your brief: on Arc the native balance and the ERC20 USDC balance are one pool (18 vs 6 decimals), and the owner, CCIP routers, PoolManager, PositionManager, pools and vaults are trusted.

## Summary

| # | Severity | Title |
|---|---|---|
| 1 | High | CCTP funding can be forged: the message header is never authenticated |
| 2 | High | A `Provide` receipt unlocks token-denominated invoices (liquidity is reported as a token amount) |
| 3 | High | `Provide` swaps with no price bound; `Pay` swaps use the whole funding as max input; both atomically sandwichable |
| 4 | Medium | Receipt path can freeze settlement, and a skipped receipt can never be re-sent |
| 5 | Medium | Mandatory push refunds can brick an order, and the CCTP burn is then unmintable |
| 6 | Medium | Funds with no intent, or arriving after a terminal state, are stuck forever |
| 7 | Medium | Intent and funding are linked only by `id`; a source reorg can redirect funds |
| 8 | Medium | Fee reserve can be drained by anyone through `replyTo` |
| 9 | Medium | No deadline: delayed delivery executes against stale bounds |
| 10 | Low | Fast-transfer CCTP fee makes exact-amount `Pay` fail; direct `Deposit` ignores its minimum |
| 11 | Low | Refunds go to the source-chain address, which smart-contract wallets may not control on Arc |
| 12 | Low | No reentrancy guard; order stays `Open` during external calls |
| 13 | Low | Whole `Intent` (including `data`) is written to storage |
| 14 | Low | Router `swapAndSend` does not tie `tokenIn` to the pool key |
| 15 | Low | Smaller items (see below) |

---

## High

### 1. CCTP funding can be forged: the message header is never authenticated

Location: `AndThenSettlement.receiveFunds` (lines 129-150).

The body offsets are right (see "checked"), but every trust decision reads fields from the message body (`burnSender`, `mintRecipient`, `id`). A CCTP message is only attested as "this message was emitted on the source domain". It is not guaranteed to be a TokenMessenger burn. Anyone can emit an arbitrary message on the source chain with `MessageTransmitterV2.sendMessage`, and Circle attests it like any other. The header `sender` and `recipient` (offsets 44 and 76) are never compared with the real TokenMessengers.

Scenario:
1. Alice's router order will get id `X = keccak256(chainid, router, n)`. The id is predictable (it is a public nonce).
2. Mallory emits on the allowed source domain a message with header recipient set to her own contract `H` on Arc, and a body that copies the burn layout: `messageSender = router`, `mintRecipient = settlement`, hook data `= X`.
3. She relays it through `receiveFunds`. `H.handleReceive...` transfers 1 wei of USDC to settlement. The balance-delta check passes, so `orders[X].funded = 1`.
4. Alice's intent arrives. `_trySettle` runs with `funded = 1`, fails (`Underfunded`), the order becomes `Failed`, and 1 wei is refunded.
5. Alice's real burn arrives. `funded += minted`, but the order is terminal and `_trySettle` returns. Her funds sit in the contract with no function that can move them.

It also lets Mallory settle an order early with an amount she picks. Cost to her is dust plus gas.

Fix:
- Pin the local `TokenMessengerV2` address and require header `recipient == tokenMessenger`, header `sender == remoteTokenMessenger[sourceDomain]`, header `destinationCaller == address(this)`, and body version `== 1` and `burnToken` is the expected USDC. The real TokenMessenger already rejects a body that does not come from its remote peer.
- Credit `funded` only for orders that exist and are `Open` (or hold early funding in a separate mapping keyed by id that is bound to the intent hash, see 7).
- Add a rescue path for funds that land on a terminal order (see 6).

### 2. A `Provide` receipt unlocks token-denominated invoices

Location: `AndThenSettlement._provide` (returns liquidity as `delivered`, line 251), `_sendReceipt` (receipt carries `token = intent.token`, `amount = delivered`), `InvoiceBook._ccipReceive` (lines 72-73).

For `Provide` the receipt amount is liquidity units, but the receipt labels it with the counter-token and the position owner as `recipient`. `InvoiceBook` compares `receipt.amount >= invoice.amount` and `receipt.token == invoice.token`. Liquidity units and token units are unrelated numbers.

Scenario: a merchant issues an invoice for 100 EURC (`token = EURC`, `payee = M`, `amount = 100e6`). Bob sends a `Provide` intent on the EURC/USDC pool with `recipient = M`, `invoiceId = that invoice`, `replyTo = InvoiceBook`. A full-range position worth a few dollars can mint liquidity above `100e6`. The receipt says `success`, `token = EURC`, `recipient = M`, `amount = L`. The invoice is marked paid while M received an LP NFT instead of 100 EURC. `Earn` has the same shape (shares versus invoice units) but is consistent when the invoice itself is denominated in the vault token.

Fix: put `action` (and a delivered-asset type) in `Receipt`. `InvoiceBook` must accept only `Pay` and `Deposit` receipts (token amounts actually transferred to the payee), and treat `Earn`/`Provide` as separate typed invoices or reject them.

### 3. No price bound on `Provide`; `Pay` uses all funding as the max input

Location: `_provide` line 217 (`_swapExactIn(key, usdc, half, 0)`), `execute` line 190 (`_swapExactOut(..., funded)`).

`receiveFunds` and `ccipReceive` are permissionless, and the attestation is public, so an attacker can wrap them: move the pool price, call `receiveFunds`, move it back, all in one transaction.
- `Provide`: half the funding is swapped with `minOut = 0`. The only protection is the optional liquidity floor `intent.amount`, which users cannot easily compute and which a front end will often leave at 0. The swap loss is limited only by the attacker's fees.
- `Pay` in EURC: the max input is `funded`, so any over-funding (for a CCTP fee, or a price margin) can be taken by the attacker.

Fix: put an explicit price bound in the intent (`maxIn` for `Pay`, `minOut` for the `Provide` swap, or a max `sqrtPriceX96` deviation checked against a reference), and enforce it on Arc. Return the unspent part to the payer (already done for `Pay`).

---

## Medium

### 4. Receipt path can freeze settlement; skipped receipts are unrecoverable

Location: `_trySettle` lines 164 and 169 call `_sendReceipt` outside any try/catch; inside it `router.getFee`, `forceApprove` and the ceil math are not guarded either.

- If `getFee` reverts (lane paused or cursed, a wrong `feeToken`, bad `receiptGasLimit`), every settlement reverts. A `receiveFunds` call rolls back the CCTP mint, and because the burn's `destinationCaller` is the settlement contract, nobody else can mint it, so the funds wait until config is fixed. `ccipReceive` falls back to manual execution.
- If the receipt is skipped (`ReceiptSkipped` for fee or a reverted `ccipSend`), the order is already terminal and nothing can resend it, so an invoice that was truly paid stays unpaid in `InvoiceBook`.

Fix: wrap quoting, approval and sending in one guarded call (a self-call in try/catch), never let it revert the settlement, and persist the receipt payload so a permissionless `retryReceipt(id)` can send it later (paying from the reserve or the caller).

### 5. Mandatory push refunds can brick an order

Location: `_trySettle` lines 165 and 170 (`usdc.safeTransfer(intent.payer, ...)`).

If `payer` is blocklisted by USDC when the order settles (blocklisting after the burn), the refund reverts, which reverts the whole inbound call, including the CCTP mint in `receiveFunds`. The mint can only be done through this contract, so the burned funds are stuck, and the CCIP message fails permanently. The payer is normally the only party affected, so this is Medium, not Critical, but the cost is a frozen order.

Fix: do not push. Credit refunds to a `claimable[payer]` mapping (or to an explicit `refundTo` address from the intent) and let the owner of the claim pull it.

### 6. Funds with no intent, or arriving after a terminal state, are stuck

Location: `receiveFunds` line 146, no recovery function anywhere (`withdrawReserve` only moves `feeReserve`).

- CCTP lands, the CCIP intent never executes (failed message not manually executed, wrong `sourceRouters` after a `setSource`, over-sized `data`, see 13): the funds wait forever with no timeout and no refund.
- Anything credited to a `Settled`/`Failed` order (see 1) cannot be moved.
- Stray USDC or other tokens sent to the contract cannot be swept.

Fix: add `claimStuck(id)` after a timeout (refund to the burn's `payer` once the intent is known, or to a recorded source), and an owner `sweep` of balances above `feeReserve + open funded`.

### 7. Intent and funding are linked only by `id`

Location: `Router._bridge` (id from `nonce`), `receiveFunds`, `_ccipReceive`.

The CCTP hook carries only `id`; the intent (recipient, action, token) travels separately over CCIP and is not committed in the burn. `getCCVsAndFinalityConfig` allows faster-than-finality delivery for the intent (`allowedFinality` = block depth 1). On a source chain that can reorg: Bob's `send` is included, the CCIP intent is delivered at depth 1 and registered on Arc, then the block is reorged out. Router state rolls back, so `nonce` is reused by Carol's later `send` with the same `id` but a different recipient and funding. On Arc, `orders[id]` already holds Bob's intent: Carol's intent reverts as `DuplicateIntent`, and Carol's USDC executes Bob's instruction (pays Bob's recipient). Likelihood depends on the chain's finality; the loss is a full redirect of funds.

Fix: make the CCTP hook data `keccak256(abi.encode(intent))` (or `id` plus that hash) and require that the funded burn and the registered intent match; keep faster-than-finality off unless the source chain has instant finality.

### 8. Fee reserve drain through `replyTo`

Location: `_sendReceipt` lines 297-304; `Router.send` lets the payer choose `replyTo`.

A `Pay` of a tiny amount has no surplus, so `fromOrder = 0` and the full receipt fee comes from `feeReserve`. Anyone can repeat this, paying roughly the source-side gas plus intent fee for each drain. Once the reserve is empty every later receipt is skipped (see 4), so merchants stop getting unlocks.

Fix: charge the receipt fee to the order up front (reserve it in the burn amount, or skip the receipt when the order cannot cover it), and cap per-order draw from the reserve.

### 9. No expiry on intents

Location: `Intent` has no deadline; `execute` and `_provide` never check age.

Delivery can lag (a CCTP standard transfer plus a manual CCIP execution, or a stuck attestation, since a burn expires after 24 hours and needs re-attesting). The order then executes at whatever price exists at that time against bounds chosen earlier.

Fix: add `deadline` to the intent; past it, refund instead of swapping.

---

## Low

### 10. Fast-transfer fee and direct `Deposit` minimum

- `Pay` in USDC requires `funded >= intent.amount`, but `funded` is the minted amount net of the CCTP fee. If the user burns exactly `amount` on a fast transfer with a non-zero fee, it can never succeed: it fails on Arc and is refunded minus the receipt fee. Fix: have the router reject `Pay` (direct or swapped) when `amount - maxFee < intent.amount`, or burn `amount + maxFee`.
- `execute` line 194: when `intent.token == usdc` for `Deposit`, `intent.amount` (the minimum) is never checked, unlike the swapped branch. Add `if (delivered < intent.amount) revert BelowMinimum(...)`.

### 11. Refund and surplus go to `intent.payer`

`payer` is `msg.sender` of the source call. For a smart-contract wallet, counterfactual wallet or a relayer, the same address on Arc may be controlled by nobody. Add an explicit `refundTo` in the intent (defaulting to payer) and document it.

### 12. No reentrancy guard; status set late

`order.status` stays `Open` during `execute`, and `receiveFunds` / `_ccipReceive` are not guarded. All current callees (USDC, v4, PositionManager, allowlisted vaults) are trusted and have no callbacks, so this is not exploitable today, but a hook on an owner-added pool or a vault with callbacks could re-enter `receiveFunds` for the same id and execute twice. Set a transient status before the external calls and add `nonReentrant` to both entry points.

### 13. Whole `Intent` stored

`order.intent = intent` (line 121) writes `data` to storage. A payer can send a very large `data`; the storage writes exceed `gasLimit = 600_000`, so the CCIP message never executes and that payer's burned USDC sticks (see 6). Store only the fields needed (or a hash) and cap `data.length` on the router.

### 14. Router `swapAndSend` does not tie `tokenIn` to the key

`tokenOut` is derived from `tokenIn`, so a `tokenIn` that is neither currency makes the router pull one token from the caller but swap another from its own balance. The router should hold nothing, but any stray balance can be swept by anyone this way. Require `tokenIn` to be `currency0` or `currency1`.

### 15. Smaller items

- `liquidity -= liquidity / 10_000 + 1` panics (not `BelowMinimum`) when liquidity is 0. The order still fails and refunds.
- `_earn` with `intent.amount == 0` has no share-price protection; allowlist only vaults with virtual-share protection.
- Residual ERC20 allowance to Permit2 after `_provide` (the Permit2 allowance itself expires in the same block). Reset approvals to 0.
- A second payer on an already-paid invoice gets a `Rejected` receipt but the payee still received the funds (`InvoiceBook` cannot refund).
- `Ownable` is single-step and `renounceOwnership` would freeze pools, vaults and sources. Use `Ownable2Step`. `setSource` can strand in-flight orders; document it.
- Constructor parameter `owner` shadows `Ownable.owner()`.
- `setPool` does not validate `hooks` and `fee`; `setVault` checks `asset()` only at registration time.
- Default `gasLimit = 600_000` is likely tight when the intent is the last leg and runs `Provide` plus a receipt in one CCIP execution; a revert there needs manual execution.

---

## Checked and found fine

- CCTP V2 offsets in `receiveFunds`: header is 148 bytes; `sourceDomain` at header 4-8; body `mintRecipient` 36, `messageSender` 100, `hookData` 228; `abi.encode(id)` is exactly `body[228:260]`. Matches Circle's published layout. Short messages revert on slice bounds.
- Replay of a real burn: the CCTP nonce is consumed by `receiveMessage`. The router sets `destinationCaller = settlement`, so a real burn can only be minted through `receiveFunds` and cannot bypass the accounting.
- Minted amount is measured by balance delta, so the CCTP fee is handled correctly.
- Intent authenticity: `ccipReceive` is gated by the CCIP router, `sourceRouters[selector] == sender`, and `DuplicateIntent`; ids include chain id, router and a monotonic nonce. A zero id never settles.
- `execute` is `OnlySelf`; the external self-call makes swaps, deposits and transfers roll back as a whole, and the failure branch refunds the payer minus the receipt fee.
- try/catch gas griefing (63/64 rule): to make `execute` run out of gas while leaving enough for the catch block, the caller would need `execute` to cost over ~60x the catch block's cost (millions of gas). Not reachable here; an out-of-gas outcome reverts the whole call instead of recording `Failed`.
- Native fee scaling: `cost = ceilDiv(fee, 1e12)` rounds the 6-decimal accounting up, so the 18-decimal native payment never exceeds what is deducted; any rounding dust stays in the contract. `feeReserve` is restored if `ccipSend` reverts; `fromOrder <= available`, so `surplus -= fromOrder` and `funded - fromOrder` cannot underflow. Only `value: fee` is sent.
- v4 swaps: sign convention (negative = exact in, positive = exact out), price limits, `sync` / transfer / `settle` / `take` order, `unlockCallback` restricted to the PoolManager, exact-out partial fills revert on `Slippage`.
- `_provide`: `MINT_POSITION` + `SETTLE_PAIR` parameter encoding and order; PositionManager pulls through Permit2 from `msg.sender` (settlement); Permit2 `approve` with expiry equal to `block.timestamp` is still valid; position NFT minted with `_mint` (no receiver callback); leftover USDC goes to the payer and leftover counter-token to the recipient, both from balance deltas, so other orders' funds are not touched.
- `_earn`: allowlist plus `asset() == usdc`, exact approval, min-shares check.
- Router: payer and id are overwritten by the contract, exact approval to TokenMessenger, burn and CCIP send are atomic, excess `msg.value` is refunded after state updates.
- InvoiceBook: source selector and sender pinned, single payment per invoice, unmatched receipts only emit `Rejected`.
- `ARC_DOMAIN = 26` matches the project's chain registry.

---

## Response

Status after the fixes in this repo. Every fixed item has a regression test in `test/AndThen.t.sol` (42 tests, all passing), which compiles against the real CCIP 2.0, Uniswap v4 core and periphery, and Permit2 sources.

| # | Status | What changed |
|---|---|---|
| 1 | Fixed | `receiveFunds` checks the header: sender is the source chain's TokenMessenger, recipient is ours, `destinationCaller` is the settlement contract, and the burn token is that chain's USDC. Funds for a finished order go back to its payer. |
| 2 | Fixed | `Receipt` carries the action; `InvoiceBook` only accepts `Pay` receipts. |
| 3 | Fixed | `Intent.limit` bounds every swap: the most USDC an exact-out `Pay` may spend, the least the `Provide` half swap must return. Swaps without a bound revert and refund. The app sets the bound from the pool price and the user's slippage. |
| 4 | Fixed | The receipt is quoted, paid and sent in its own guarded call and can never revert settlement. `retryReceipt` lets anyone send a skipped receipt, paying the CCIP fee. |
| 5 | Fixed | Refunds use `trySafeTransfer`; a refund that cannot be pushed becomes `claimable` and is pulled with `claim`. |
| 6 | Fixed | Funds for a finished order are refunded; funds whose intent never arrives can be rescued by the owner after `RESCUE_DELAY` (1 day). |
| 7 | Fixed | Orders are keyed by `keccak256(abi.encode(intent))` and the CCTP hook carries that hash, so a burn can only fund the exact intent it was sent with. Faster-than-finality for the intent stays on, since a reorged intent can no longer take other funds. |
| 8 | Fixed | The shared fee reserve is gone. Receipts are paid from the order's own leftover; without one the receipt is skipped and can be retried by someone who pays. |
| 9 | Fixed | `Intent.deadline`; past it the order is refunded instead of run. The app sets one hour for fast transfers, three for standard. |
| 10 | Fixed | Direct `Deposit` checks its minimum. The app burns enough to cover the CCTP fee for exact payments. |
| 11 | Fixed | `Intent.refundTo`, defaulting to the payer. |
| 12 | Fixed | `nonReentrant` on `ccipReceive`, `receiveFunds`, `claim`, `rescue` and `retryReceipt`. |
| 13 | Fixed | The router rejects `data` longer than 64 bytes, so the stored intent always fits the CCIP gas limit. |
| 14 | Fixed | `swapAndSend` requires `tokenIn` to be one of the pool's currencies and the other to be USDC. |
| 15 | Partly | Zero liquidity reverts with `BelowMinimum`; Permit2 approvals are reset after minting; `Ownable2Step`; `setPool` rejects pools with hooks; the constructor no longer shadows `owner`. Vault share-price protection relies on the allowlist. A second payment of a paid invoice still reaches the payee. |
