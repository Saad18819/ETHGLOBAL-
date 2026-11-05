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
  CCTP burn, hook data = intent id   ───────▶  receiveFunds: mint USDC
  CCIP message with the intent       ───────▶  ccipReceive: store intent
                                               both here: run the action
                                                 pay exact USDC
                                                 pay exact EURC via the v4 pool
                                                 swap everything into EURC
                                                 add liquidity to the v4 pool
                                                 lend on Morpho
InvoiceBook                                    emit Settled(id, invoiceId, ...)
  ccipReceive: unlock the invoice    ◀───────  CCIP receipt
```

- **CCTP moves the money, CCIP moves the instructions and the receipt.** CCIP can not carry value to Arc for us, so all value goes through CCTP. The two arrive in either order; the settlement contract matches them by intent id, which travels as CCTP hook data. The CCTP sender is checked against our router.
- **Two onchain state changes over CCIP.** The intent changes state on Arc, and the receipt unlocks the invoice on Base.
- **Uniswap is a destination, not only a source.** The settlement contract swaps through the USDC/EURC v4 pool on Arc to pay an exact EURC amount or convert everything into EURC, and it can put the funds into that pool: half is swapped into EURC and a full-range position is minted to the user through PositionManager. The router can also swap any token with a v4 pool against USDC on Base before bridging.
- **Many chains, two routes.** USDC from Base, Ethereum or Polygon (the chains with a CCIP lane to Arc) runs through our router and settlement contract. USDC from Arbitrum, Optimism, Avalanche, Unichain, Linea, World Chain, Ink, Sonic or Monad, and EURC, WETH and cirBTC, are bridged with Bridge Kit and finished from the wallet on Arc with Circle's kits.
- **Numbers before you sign.** Vault APY and liquidity, the borrow market's rate and LLTV, and USD prices come live from Circle App Kit; the pool price and in-range depth come from the v4 StateView. The app shows rate, cost, loan to value and liquidation price for the option you pick.
- **Lend and loop on Morpho.** USDC can land straight in a Morpho USDC vault on Arc (one of the vaults Circle Earn lists), with the shares going to the user. Any asset can be looped into BTC: it is swapped into cirBTC, Circle Borrow takes it as collateral on Morpho, the borrowed USDC buys more cirBTC through Circle Swap and goes back into the same loan, round after round until the chosen leverage.
- **Bridge Kit for non-USDC assets.** WETH and cirBTC (from Ethereum Sepolia) and EURC (from Base or Ethereum) are bridged natively with Circle Bridge Kit. The "and then" runs from the user's wallet on Arc. Payments go through Arc's `Memo` contract, which only accepts calls from an EOA.
- **Exact amounts.** Pay actions deliver exactly the requested amount. Whatever is left after the CCTP fee, the swap and the receipt fee goes back to the payer on Arc. If the action can not run, everything is refunded and a failed receipt goes back.

## Chain facts that shaped the design

- CCIP lanes to Arc testnet exist for Base Sepolia, Ethereum Sepolia and Polygon Amoy, not Arbitrum or Optimism. They are CCIP 2.0, so messages use `ExtraArgsV3`.
- Base to Arc accepts block-depth finality. The router asks for 5 blocks and the settlement contract allows it through `getCCVsAndFinalityConfig`, so the intent does not wait for full finality.
- Arc to Base fees can not be paid with the USDC ERC20 (`TokenNotSupported`), but native value works. On Arc native value is USDC with 18 decimals, so receipts are paid in native USDC.
- Arc's `Memo` contract reverts when called by a contract. The settlement contract emits its own `Settled` event with the invoice id instead.

## Repository

| Path | What |
| - | - |
| `src/AndThenSettlement.sol` | Arc. Pairs CCTP funds with CCIP intents, runs the action, sends the receipt |
| `src/AndThenRouter.sol` | Source chain. Optional v4 swap, CCTP burn with hook, CCIP intent |
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
SOURCE=base SETTLEMENT=0x... ROUTER=0x... RECEIPT_RESERVE=2000000 forge script script/Deploy.s.sol:ConnectArc --rpc-url arc_testnet --broadcast --private-key $PRIVATE_KEY
```

Web app, with the deployed addresses in `web/.env.local` (see `web/.env.example`):

```bash
cd web
npm install
npm run dev
```

## AI use

See [AI_USAGE.md](AI_USAGE.md).
