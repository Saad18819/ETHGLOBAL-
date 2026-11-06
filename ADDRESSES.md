# Addresses

Every address below was checked on-chain (contract code present, and calls answer as expected)
on 2026-11-06 unless marked otherwise.

## Arc Testnet (chain id 5042002)

### Our contracts (built in Arc Studio)

| Contract | Address | Notes |
|---|---|---|
| HookReceiver | `0x86f5d77bDb889Ec3B4550049fCbF79265Ede5012` | Phase 1 test receiver, owner `0xb96E…186a` |
| HookReceiver v1 (old) | `0x9a47b43a3e3965b01e7fe4f01dd74cc985c7add6` | Owner is Studio's deployer. Do not use. |
| Settlement | _todo_ | Phase 4 |

Studio project: https://studio.arc.io/app/cb20c8eb-57e8-49eb-abda-1c60be57f23f

### Tokens

| Token | Address |
|---|---|
| USDC (native, ERC-20 interface, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |

### Circle CCTP (non-USDC)

| Contract | Address |
|---|---|
| CrossChainTokenService (same on Sepolia) | `0x63753E722bd2C2A5DF6EE19C5106662208B81077` |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| EURC token id | `0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd` |
| CCTP domain | `26` (Ethereum Sepolia = `0`) |

### Chainlink CCIP

| Item | Value |
|---|---|
| Router (1.2.0) | `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` |
| Arc chain selector | `3034092155422581607` |
| Lane Arc → Sepolia | live, fee ≈ 2.6 USDC native, delivered in 17s (Phase 2) |

### Uniswap v4

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` (verified on-chain) |
| UniversalRouter | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| PositionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Uniswap's docs list Universal Router 2.1.2 `0x8702…2650` and PositionDescriptor `0x516b…8707` for Arc,
but they have **no code on Arc Testnet** (probably mainnet only).

**USDC/EURC pool** (the only one on testnet):

| Field | Value |
|---|---|
| Key | currency0 USDC, currency1 EURC, fee `500` (0.05%), tickSpacing `10`, hooks `0x0` |
| Pool id | `0xf775c49a5149d5d85f0667782c0b5ccde7fbaeeac0cdbe0ea3b47eea8d7829ea` |
| Price | ≈ 0.8646 EURC per USDC |
| Depth | shallow: 1 USDC quotes fine, 10 USDC reverts |

Fee tiers 100, 3000 and 10000 are not initialized.

**Phase 3 manual swap ✅:** 1 USDC → 0.851112 EURC through the UniversalRouter,
tx `0x059bccf3a52d7eae09fb4125c216cd24702b7a786b1be62b7326e0e8029c8dc9`.
The Arc router takes the **new** v4 params format (`ExactInputSingleParams` with `minHopPriceX36`).

## Ethereum Sepolia (chain id 11155111)

| Contract | Address |
|---|---|
| EURC | `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| CCIP Router (1.2.0) | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` |
| CCIP chain selector | `16015286601757825753` |
| HelloReceiver (Phase 2 test) | `0xfcde599fcb267d1f7f1095db886316e104a6caa8` |
| Uniswap v4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Uniswap v4 StateView | `0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C` |
| Uniswap v4 Quoter | `0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244` (from web/lib/uniswap.ts) |

**WETH/EURC liquidity (stretch goal):**
- Uniswap v4 WETH/EURC: **no pools.**
- Uniswap v4 **native ETH/EURC: pools exist** in all four fee tiers with liquidity
  (testnet prices are arbitrary: 0.001 ETH ≈ 25 EURC). Route WETH → unwrap → ETH/EURC.
- Uniswap v3 WETH/EURC pools exist at 0.05% (`0x3D4E087D7faD8d2A72a6e6695Cd0C39De768679d`) and
  0.3% (`0x1b025D4b5478072e7Fe7DCFf654e6009B162B423`); liquidity not checked.
