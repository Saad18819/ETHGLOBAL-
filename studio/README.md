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

Runtime size is 18,144 bytes, under the 24,576 limit.

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

> Create a contract file AndThenSettlement.sol from the code I paste below and use it exactly as is.
> Compile it with Solidity 0.8.28, viaIR enabled, optimizer enabled with 200 runs, EVM version cancun.
> The contract to deploy is `AndThenSettlement`. Deploy it on Arc Testnet with these constructor arguments, in order:
> ccipRouter = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8,
> _poolManager = 0x8366a39CC670B4001A1121B8F6A443A643e40951,
> _usdc = 0x3600000000000000000000000000000000000000,
> _transmitter = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275,
> _tokenMessenger = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA,
> _positionManager = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B,
> _permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3,
> initialOwner = 0xb96E328690d79671328fEE9236264f4e406c186a.
> Then give me the deployed address.

## After deploying

The owner (not Studio's deployer) has to run the setup calls from `DeployArc`:

```bash
cd scripts/settlement-setup
# put SETTLEMENT=0x... in .env
npm start
```

This calls `setVault(Morpho USDC vault, true)` and `setPool(EURC, USDC/EURC 0.05% pool)`.
