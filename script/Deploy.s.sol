// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {AndThenSettlement} from "../src/AndThenSettlement.sol";
import {AndThenRouter} from "../src/AndThenRouter.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IMessageTransmitterV2, ITokenMessengerV2} from "../src/interfaces/ICCTP.sol";

/// Addresses from docs.arc.io/arc/references/contract-addresses, developers.circle.com/cctp/references/contract-addresses,
/// docs.chain.link/ccip/directory/testnet and docs.uniswap.org/contracts/v4/deployments.
library Testnet {
    uint64 constant ARC_SELECTOR = 3034092155422581607;
    uint64 constant BASE_SELECTOR = 10344971235874465080;
    uint64 constant SEPOLIA_SELECTOR = 16015286601757825753;
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant SEPOLIA_DOMAIN = 0;

    address constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;

    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant ARC_EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;
    address constant ARC_CCIP_ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    address constant ARC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ARC_POSITION_MANAGER = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    // Morpho vault listed by Circle Earn on Arc testnet (kit.earn.exploreVaults)
    address constant ARC_MORPHO_USDC_VAULT = 0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC;

    address constant BASE_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant BASE_CCIP_ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
    address constant BASE_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
}

/// forge script script/Deploy.s.sol:DeployArc --rpc-url arc_testnet --broadcast
contract DeployArc is Script {
    function run() external returns (AndThenSettlement settlement) {
        address owner = vm.envAddress("DEPLOYER");
        vm.startBroadcast();
        settlement = new AndThenSettlement(
            Testnet.ARC_CCIP_ROUTER,
            IPoolManager(Testnet.ARC_POOL_MANAGER),
            IERC20(Testnet.ARC_USDC),
            IMessageTransmitterV2(Testnet.MESSAGE_TRANSMITTER),
            IPositionManager(Testnet.ARC_POSITION_MANAGER),
            IAllowanceTransfer(Testnet.PERMIT2),
            owner
        );
        settlement.setVault(Testnet.ARC_MORPHO_USDC_VAULT, true);
        // Existing USDC/EURC pool on Arc testnet, 0.05% fee
        settlement.setPool(
            Testnet.ARC_EURC,
            PoolKey({
                currency0: Currency.wrap(Testnet.ARC_USDC),
                currency1: Currency.wrap(Testnet.ARC_EURC),
                fee: 500,
                tickSpacing: 10,
                hooks: IHooks(address(0))
            })
        );
        vm.stopBroadcast();
        console.log("settlement", address(settlement));
    }
}

/// SETTLEMENT=0x... forge script script/Deploy.s.sol:DeployBase --rpc-url base_sepolia --broadcast
contract DeployBase is Script {
    function run() external returns (AndThenRouter router, InvoiceBook invoices) {
        address owner = vm.envAddress("DEPLOYER");
        address settlement = vm.envAddress("SETTLEMENT");
        vm.startBroadcast();
        router = new AndThenRouter(
            IERC20(Testnet.BASE_USDC),
            ITokenMessengerV2(Testnet.TOKEN_MESSENGER),
            IRouterClient(Testnet.BASE_CCIP_ROUTER),
            IPoolManager(Testnet.BASE_POOL_MANAGER),
            Testnet.ARC_SELECTOR,
            settlement,
            owner
        );
        // The Base to Arc lane accepts block-depth finality; the settlement allows depth >= 1.
        router.setConfig(1_200_000, bytes4(uint32(5)), 1000);
        invoices = new InvoiceBook(Testnet.BASE_CCIP_ROUTER, Testnet.ARC_SELECTOR, settlement);
        vm.stopBroadcast();
        console.log("router", address(router));
        console.log("invoices", address(invoices));
    }
}

/// SETTLEMENT=0x... BASE_ROUTER=0x... forge script script/Deploy.s.sol:ConnectArc --rpc-url arc_testnet --broadcast
contract ConnectArc is Script {
    function run() external {
        AndThenSettlement settlement = AndThenSettlement(vm.envAddress("SETTLEMENT"));
        address baseRouter = vm.envAddress("BASE_ROUTER");
        uint256 reserve = vm.envOr("RECEIPT_RESERVE", uint256(0));
        vm.startBroadcast();
        settlement.setSource(Testnet.BASE_SELECTOR, Testnet.BASE_DOMAIN, baseRouter);
        if (reserve > 0) {
            IERC20(Testnet.ARC_USDC).approve(address(settlement), reserve);
            settlement.fundReceipts(reserve);
        }
        vm.stopBroadcast();
    }
}
