# andthen

Nobody bridges for fun. There is always an "and then": pay someone, get paid, earn, put it in a pool. Bridges stop at "funds arrived". andthen finishes the job on Arc.

The whole app is one sentence:

> Move 10 USDC from Base to Arc, and then pay alex.eth 9 EURC.

Every part of it is a dropdown. "and then" is fixed. The panel on the side lists what can come next and fills the sentence when you pick one.

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
| `web/` | Next.js app: the sentence, pay links, and the CCTP relayer route |

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
