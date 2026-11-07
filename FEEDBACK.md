# Uniswap developer feedback

Feedback from building andthen at ETHGlobal. We used Uniswap v4 on Arc testnet (settlement contract swaps and mints positions straight against the PoolManager and PositionManager), v4 on Ethereum Sepolia and Base Sepolia (router swaps any token into USDC before bridging), the Trading API (wallet swaps on the source chain), and the V4Quoter and StateView (prices and depth shown before signing).

Where the integration lives in the code is listed in the README under "Uniswap v4 integration".

## What worked well

- **Swapping straight against the PoolManager was easy to get right.** `unlock` → `unlockCallback` → `swap` → `sync`/`settle`/`take` is short, and `UniswapV4Swapper` is under 90 lines for exact-in and exact-out. Not needing a router inside our settlement contract kept it smaller.
- **Flash accounting made exact-output payments clean.** "Pay exactly 25 EURC, spend at most X USDC" is one `swap` with a positive `amountSpecified`, and the deltas tell us exactly what was spent. The leftover goes back to the payer.
- **`modifyLiquidities` with `MINT_POSITION` + `SETTLE_PAIR`** let the settlement contract mint a position directly to the user in the same transaction that receives the bridged USDC. That is what turned Uniswap into a destination for us, not only a swap step.
- **V4Quoter and StateView** gave us everything the UI needs before the user signs: `quoteExactInputSingle` / `quoteExactOutputSingle` for the EURC amount, `getSlot0` and `getLiquidity` for price and in-range depth.
- **Same PoolManager interface on every chain**, so one swapper contract worked on Arc, Sepolia and Base Sepolia.

## What slowed us down

1. **Docs list Arc addresses that have no code on Arc testnet.** The deployments page lists Universal Router 2.1.2 (`0x8702…2650`) and a PositionDescriptor (`0x516b…8707`) for Arc, but neither exists on Arc testnet. We found the working UniversalRouter (`0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`) by checking on-chain. Separate mainnet and testnet columns per chain would have saved us a lot of time.
2. **The Arc UniversalRouter takes the newer `ExactInputSingleParams` with `minHopPriceX36`.** Examples and SDK snippets we found still encode the older struct, and the call reverts with no hint about the wrong layout. A note on which router versions take which params (or a version getter on the router) would help.
3. **Testnet liquidity is thin and that is hard to see up front.**
   - Arc testnet has one USDC/EURC pool (fee 500, tickSpacing 10). 1 USDC swaps fine, 10 USDC reverts. Fee tiers 100, 3000 and 10000 are not initialized.
   - The Sepolia ETH/USDC v4 pool prices ETH about 11x the market, so demos through it look odd.
   - A "known testnet pools" list per chain, with rough depth, would let builders plan demo amounts instead of finding out from reverts.
4. **Finding which pools exist** meant computing pool ids for every token pair and fee tier and calling `getSlot0` on each. An indexer or API endpoint listing initialized pools per chain (testnets included) would replace a lot of probing code.
5. **Native vs ERC20 USDC on Arc.** On Arc, USDC is the gas token (18 decimals natively) and also an ERC20 at `0x3600…0000` (6 decimals). The v4 pool uses the ERC20 address as `currency0`, not `address(0)`. It works, but a short note for chains with a native stablecoin would prevent a wrong `PoolKey`.
6. **Trading API coverage.** We use the Trading API for wallet swaps on the source chain. It was not clear from the docs which testnets and which new chains (like Arc) it supports, so we had to find out by calling it.

## Small wishes

- A minimal "swap against PoolManager from your own contract" example with exact-output, next to the hook examples. Most examples assume you are writing a hook.
- Revert reasons from the PoolManager path that say which side ran out (price limit vs liquidity) when a swap can not fill.
- Permit2 + PositionManager approval in one documented snippet for contracts (not wallets): we approve Permit2, then `permit2.approve(token, positionManager, amount, expiry)`, and reset both after the mint.
