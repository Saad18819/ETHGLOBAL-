# andthen

Nobody bridges for fun. There is always an "and then": pay someone, get paid, earn, put it in a pool. Bridges stop at "funds arrived". andthen finishes the job on Arc.

The whole app is one sentence:

> Move 10 USDC from Base to Arc, and then pay alex.eth 9 EURC.

Every part of it is a dropdown. "and then" is fixed. The panel on the side lists what can come next and fills the sentence when you pick one.

## Built in Arc Studio

**Bounty:** Best Use of Bridge Kit for Non-USDC Assets, Built in Arc Studio.

**Arc Studio project (build + deploy):** https://studio.arc.io/app/cb20c8eb-57e8-49eb-abda-1c60be57f23f

**Arc Studio project (security audit):** https://studio.arc.io/app/c329f65a-36b6-4a31-ba41-e2cdf176402e

- **The live settlement contract on Arc was compiled and deployed by Arc Studio.** Studio's workspace has no Chainlink, Uniswap v4 or Permit2 packages, so we flatten `src/AndThenSettlement.sol` into [`studio/AndThenSettlement.flat.sol`](studio/AndThenSettlement.flat.sol) and send it with the Arc Studio CLI. Studio compiles it (0.8.28, viaIR, optimizer 200, cancun) and deploys it on Arc Testnet with our wallet as owner. Steps, prompt and checks: [`studio/README.md`](studio/README.md).
- **Arc Studio audited every contract.** Report and fixes: [AUDIT.md](AUDIT.md).
- **Arc Studio also deployed `HookReceiver`**, the receiver we used to prove EURC with hook data lands in an Arc contract (CCTP for non-USDC assets).
- **Bridge Kit for non-USDC assets:** EURC, WETH and cirBTC are bridged with Circle Bridge Kit and finished on Arc (see "How it works").

## Main use case: pay links

A merchant requests 25 EURC on Arc and gets a link. The payer opens it, pays from Base, and the merchant receives exactly 25 EURC on Arc, tagged with the invoice id. The invoice on Base only unlocks when a receipt from Arc arrives.

## How it works

```
Base Sepolia                                   Arc testnet
AndThenRouter                                  AndThenSettlement
  swap input to USDC (Uniswap v4, optional)
  CCTP burn, hook data = the intent  ───────▶  receiveFunds: mint USDC and
                                               run the action in the same tx
                                                 pay exact USDC
                                                 pay exact EURC via the v4 pool
                                                 swap everything into EURC
                                                 add liquidity to the v4 pool
                                                 lend on Morpho
InvoiceBook                                    emit Settled(id, invoiceId, ...)
  ccipReceive: unlock the invoice    ◀───────  CCIP receipt
```

- **CCTP moves the money and the instruction, CCIP moves the receipt.** The router burns USDC over CCTP with the whole intent as hook data, so one message carries both, and the settlement contract runs the action in the same transaction that mints the USDC. No second message to wait for and no CCIP fee on the way there. The CCTP sender is checked against our router, so only intents our router built are run.
- **CCIP where only CCIP can do it.** CCTP moves USDC; it can not tell the invoice on Base that a payment settled on Arc. The receipt goes back over Chainlink CCIP and changes state on Base: the invoice turns paid only when it arrives.
- **Uniswap is a destination, not only a source.** The settlement contract swaps through the USDC/EURC v4 pool on Arc to pay an exact EURC amount or convert everything into EURC, and it can put the funds into that pool: half is swapped into EURC and a full-range position is minted to the user through PositionManager. The router can also swap any token with a v4 pool against USDC on Base before bridging.
- **Many chains, two routes.** USDC from Base, Ethereum or Polygon (the chains with a CCIP lane between them and Arc, for receipts) runs through our router and settlement contract. USDC from Arbitrum, Optimism, Avalanche, Unichain, Linea, World Chain, Ink, Sonic or Monad, and EURC, WETH and cirBTC, are bridged with Bridge Kit and finished from the wallet on Arc with Circle's kits.
- **Real numbers from mainnet.** Next to the testnet flow the app shows Arc mainnet figures: the best Morpho vaults and borrow markets from Circle's kits, and the Uniswap USDC/EURC pool's fee APR from its last 24 hours of swaps. Probing every token Morpho lists on Arc against USDC and EURC across all fee tiers finds no other hookless Uniswap v4 pool between real assets yet.
- **Numbers before you sign.** Vault APY and liquidity, the borrow market's rate and LLTV, and USD prices come live from Circle App Kit; the pool price and in-range depth come from the v4 StateView. The app shows rate, cost, loan to value and liquidation price for the option you pick.
- **Lend and loop on Morpho.** USDC can land straight in a Morpho USDC vault on Arc (one of the vaults Circle Earn lists), with the shares going to the user. Any asset can be looped into BTC: it is swapped into cirBTC, Circle Borrow takes it as collateral on Morpho, the borrowed USDC buys more cirBTC through Circle Swap and goes back into the same loan, round after round until the chosen leverage.
- **Bridge Kit for non-USDC assets.** WETH and cirBTC (from Ethereum Sepolia) and EURC (from Base or Ethereum) are bridged natively with Circle Bridge Kit. The "and then" runs from the user's wallet on Arc. Payments go through Arc's `Memo` contract, which only accepts calls from an EOA.
- **Exact amounts, bounded prices.** Pay actions deliver exactly the requested amount. Every swap carries a price bound and every intent a deadline. Whatever is left after the CCTP fee, the swap and the receipt fee goes back to the payer on Arc. If the action can not run, everything is refunded and a failed receipt goes back.
- **Funds only settle their own intent.** The intent travels inside the attested CCTP message from our router, and orders are keyed by its hash, so a second burn for the same order is refunded rather than run twice.

## Uniswap v4 integration

Where to look (developer feedback: [FEEDBACK.md](FEEDBACK.md)):

| What | Code |
| - | - |
| Swaps straight against the v4 PoolManager: `unlock` → `unlockCallback` → `swap` → `settle` / `take`, exact-in and exact-out | [`src/UniswapV4Swapper.sol#L32-L86`](src/UniswapV4Swapper.sol#L32-L86) |
| Pay an exact EURC amount (exact-out) or convert everything into EURC (exact-in) through the USDC/EURC pool on Arc | [`src/AndThenSettlement.sol#L220-L238`](src/AndThenSettlement.sol#L220-L238) |
| Provide liquidity: swap half, then `PositionManager.modifyLiquidities` with `MINT_POSITION` + `SETTLE_PAIR`, position minted to the user | [`src/AndThenSettlement.sol#L255-L300`](src/AndThenSettlement.sol#L255-L300) |
| Permit2 approval of the PositionManager from the contract | [`src/AndThenSettlement.sol#L309-L312`](src/AndThenSettlement.sol#L309-L312) |
| Source chain: swap any token with a v4 pool into USDC, then bridge | [`src/AndThenRouter.sol#L61-L79`](src/AndThenRouter.sol#L61-L79) |
| Quotes before signing: V4Quoter `quoteExactInputSingle` / `quoteExactOutputSingle`, StateView `getSlot0` / `getLiquidity` | [`web/lib/quote.ts`](web/lib/quote.ts) |
| Wallet swaps through the Uniswap Trading API | [`web/lib/uniswap.ts`](web/lib/uniswap.ts), [`web/app/api/uniswap/[action]/route.ts`](web/app/api/uniswap/%5Baction%5D/route.ts) |
| Wallet LP positions on Arc (Permit2 + `modifyLiquidities`) | [`web/lib/positions.ts`](web/lib/positions.ts) |
| Tests against a real v4 PoolManager | [`test/AndThen.t.sol`](test/AndThen.t.sol) |

Pool used on Arc testnet: USDC/EURC, fee 500, tickSpacing 10, no hooks, through PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` and PositionManager `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B`.

## Chain facts that shaped the design

- CCIP lanes with Arc testnet exist for Base Sepolia, Ethereum Sepolia and Polygon Amoy, not Arbitrum or Optimism. They are CCIP 2.0, so messages use `ExtraArgsV3`.
- CCTP V2 messages take hook data up to the 8192 byte message body limit, far more than an intent needs.
- Arc to Base fees can not be paid with the USDC ERC20 (`TokenNotSupported`), but native value works. On Arc native value is USDC with 18 decimals, so receipts are paid in native USDC.
- Arc's `Memo` contract reverts when called by a contract. The settlement contract emits its own `Settled` event with the invoice id instead.

## Repository

| Path | What |
| - | - |
| `src/AndThenSettlement.sol` | Arc. Mints CCTP funds, runs the intent from their hook data, sends the receipt |
| `src/AndThenRouter.sol` | Source chain. Optional v4 swap, CCTP burn with the intent as hook data |
| `src/InvoiceBook.sol` | Source chain. Invoices unlocked by CCIP receipts |
| `src/UniswapV4Swapper.sol` | Exact-in and exact-out swaps straight against the v4 PoolManager |
| `test/AndThen.t.sol` | Full flow against a real v4 PoolManager with CCTP and CCIP mocks |
| `script/Deploy.s.sol` | Deploy and wire up on Arc testnet and Base Sepolia |
| `src/HookReceiver.sol` | Arc. Test receiver for EURC with hook data (`executeWithCrossChainToken`), deployed in Arc Studio |
| `studio/` | Flattened settlement for Arc Studio, the deploy prompt, and the deploy record |
| `scripts/router-e2e` | One real payment through the contracts, end to end and timed |
| `scripts/eurc-hook`, `scripts/ccip-hello`, `scripts/uniswap-swap` | The rail tests: EURC hook, CCIP Arc → Sepolia, v4 swap on Arc |
| `deployments/`, `ADDRESSES.md`, `broadcast/` | Deployed and external addresses, and the forge deploy logs |
| `web/` | Next.js app: the sentence, pay links, and the CCTP relayer route |

## Deployed on testnet

| Contract | Chain | Address | Deployed with |
| - | - | - | - |
| `AndThenSettlement` | Arc testnet | [`0xae165c6b45d17bb1ffe2a6941a07e07a534c5271`](https://explorer.testnet.arc.io/address/0xae165c6b45d17bb1ffe2a6941a07e07a534c5271) | **Arc Studio** |
| `HookReceiver` (EURC hook test) | Arc testnet | [`0x86f5d77bDb889Ec3B4550049fCbF79265Ede5012`](https://explorer.testnet.arc.io/address/0x86f5d77bDb889Ec3B4550049fCbF79265Ede5012) | **Arc Studio** |
| `AndThenRouter` | Ethereum Sepolia | [`0xE903D614De200198Fd03D73BbA1832f523d847a6`](https://sepolia.etherscan.io/address/0xE903D614De200198Fd03D73BbA1832f523d847a6) | `DeploySource` |
| `InvoiceBook` | Ethereum Sepolia | [`0xd595E25FeEd90b2647E66A82d26B9ad97542eb3A`](https://sepolia.etherscan.io/address/0xd595E25FeEd90b2647E66A82d26B9ad97542eb3A) | `DeploySource` |
| `AndThenRouter` | Base Sepolia | [`0x6A79d63D85184112FBa127Ca9096e11812309911`](https://sepolia.basescan.org/address/0x6A79d63D85184112FBa127Ca9096e11812309911) | `DeploySource` |

The settlement is set up with the Morpho USDC vault, the USDC/EURC v4 pool and both routers (`setVault`, `setPool`, `setSource`). Every other address we use (CCTP, CCIP, Uniswap v4, tokens) is in [ADDRESSES.md](ADDRESSES.md).

### Proved on testnet

| What | Result | Script |
| - | - | - |
| **Full route:** Sepolia `Router.send` → CCTP fast with the intent as hook data → Studio-deployed `Settlement` pays on Arc | **Settled in 36 s**: attested at 31 s, minted and paid in one tx, 0.9 USDC paid, leftover refunded ([send](https://sepolia.etherscan.io/tx/0xbddee2a236a899252ca674fd50684f6720ed0923e4212a0b676d08af467de3a7), [settled](https://testnet.arcscan.app/tx/0x88dd627e41316e730635b37cc784339533afda9a5c7ba4811000b11482f990b0)) | [`scripts/router-e2e/pay-hook.ts`](scripts/router-e2e/pay-hook.ts) |
| Earlier design, CCIP carrying the intent next to CCTP | settled in 92 s, which is why the intent moved into the hook data | [`scripts/router-e2e/pay.ts`](scripts/router-e2e/pay.ts) |
| EURC Sepolia → Arc with hook data (CCTP for non-USDC) | landed in `HookReceiver`, hook data decoded | [`scripts/eurc-hook`](scripts/eurc-hook/README.md) |
| CCIP message Arc → Sepolia, fee in native USDC (the receipt lane) | delivered in 17 s | `scripts/ccip-hello` |
| Uniswap v4 swap on Arc's USDC/EURC pool | 1 USDC → 0.851 EURC | `scripts/uniswap-swap` |

## Run it

```bash
npm install                 # Chainlink CCIP contracts
forge test
```

Deploy, with `PRIVATE_KEY` and `DEPLOYER` in `.env`:

```bash
source .env
forge script script/Deploy.s.sol:DeployArc --rpc-url arc_testnet --broadcast --private-key $PRIVATE_KEY
# once per source chain: SOURCE is base, sepolia or amoy, with the matching --rpc-url
SOURCE=base SETTLEMENT=0x... forge script script/Deploy.s.sol:DeploySource --rpc-url base_sepolia --broadcast --private-key $PRIVATE_KEY
SOURCE=base SETTLEMENT=0x... ROUTER=0x... forge script script/Deploy.s.sol:ConnectArc --rpc-url arc_testnet --broadcast --private-key $PRIVATE_KEY
```

Web app, with the deployed addresses in `web/.env.local` (see `web/.env.example`):

```bash
cd web
npm install
npm run dev
```

## Security

The contracts were audited with [Arc Studio](https://studio.arc.io): 3 high, 6 medium and 6 low findings. Every high and medium finding is fixed with a regression test, and so are most low ones. The report and our response are in [AUDIT.md](AUDIT.md).

## AI use

See [AI_USAGE.md](AI_USAGE.md).
