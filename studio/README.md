# Deploying AndThenSettlement in Arc Studio

`AndThenSettlement.flat.sol` is `src/AndThenSettlement.sol` with every import inlined
(`forge flatten`), so Arc Studio can compile it without installing Chainlink, Uniswap v4,
Permit2 or OpenZeppelin. Re-flatten after any change to the contracts:

```bash
forge flatten src/AndThenSettlement.sol -o studio/AndThenSettlement.flat.sol
```

## Compiler settings (required)

- Solidity `0.8.26` or newer (0.8.28 checked)
- **viaIR: true** (without it: "Stack too deep")
- optimizer on, 200 runs
- EVM version `cancun`

Runtime size is 16,343 bytes, under the 24,576 limit.

## Constructor (Arc Testnet), same as `DeployArc` in `script/Deploy.s.sol`

| # | Parameter | Value |
|---|---|---|
| 1 | ccipRouter | `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` |
| 2 | _poolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| 3 | _usdc | `0x3600000000000000000000000000000000000000` |
| 4 | _transmitter | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| 5 | _tokenMessenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| 6 | _positionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` |
| 7 | _permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| 8 | initialOwner | `0xb96E328690d79671328fEE9236264f4e406c186a` |

## Prompt for Arc Studio's AI

The exact prompt is in [`deploy-prompt.txt`](deploy-prompt.txt). It was sent together with the flattened file:

```bash
arc-studio run --app cb20c8eb-57e8-49eb-abda-1c60be57f23f \
  -f studio/AndThenSettlement.flat.sol:contracts/AndThenSettlement.sol \
  --prompt-file studio/deploy-prompt.txt
```

## After deploying

The owner (not Studio's deployer) runs the setup from `DeployArc` and `ConnectArc` in `script/Deploy.s.sol`:

- `setVault(0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC, true)`: the Morpho USDC vault
- `setPool(EURC, USDC/EURC 0.05% pool, tickSpacing 10, no hooks)`
- `setSource(...)` once per source chain, with that chain's `AndThenRouter`

Then each source chain gets a router and an InvoiceBook pointing at this settlement (`DeploySource`).

## Deployed

The live settlement is the hook-data version: the intent travels in the CCTP hook data, and CCIP only carries receipts.

| | |
|---|---|
| AndThenSettlement | [`0xae165c6b45d17bb1ffe2a6941a07e07a534c5271`](https://explorer.testnet.arc.io/address/0xae165c6b45d17bb1ffe2a6941a07e07a534c5271) (Arc Testnet) |
| Deploy tx | `0x48717e2afd5eaf46e88b45fc8a02f8e69df012b068f7a2d14831a0de8829e53c` |
| Deployed by | Arc Studio, compiled in Studio's sandbox |
| Owner | `0xb96E328690d79671328fEE9236264f4e406c186a` |
| Compiler | 0.8.28, viaIR, optimizer 200, cancun |
| Studio project | https://studio.arc.io/app/cb20c8eb-57e8-49eb-abda-1c60be57f23f |

Checked on-chain: runtime is 16,343 bytes, and owner and every constructor value match.

Setup on Arc: `setVault` `0x7490671def52e653b876a35441eb2c9965bdc220ee5b26aba16fb9c691f89f9e`, `setPool` `0x6cb842e297a291c7b3a61b0366e48925eae75998e7af4c5650604b353aa55b57`, `setSource` Base Sepolia `0x150fab16583af92953b40a28c0a3b924ede3231330b049f1737745fac3d8e6fb`, `setSource` Ethereum Sepolia `0x18c94f228d6ee2d829c38ff506ad42074d84df47ba6ec74ace97688313d87c11`.

The first version, where CCIP carried the intent next to the CCTP transfer, was also deployed by Studio, at `0xddc5b10c8e8001d5bd385025ad9dfc6a56d38bb3`. It settled a payment from Sepolia in 92 s. The hook-data version does it in 36 s.
