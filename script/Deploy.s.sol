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
    uint64 constant AMOY_SELECTOR = 16281711391670634445;
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant SEPOLIA_DOMAIN = 0;
    uint32 constant AMOY_DOMAIN = 7;

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

    address constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant SEPOLIA_CCIP_ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;
    address constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;

    address constant AMOY_USDC = 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582;
    address constant AMOY_CCIP_ROUTER = 0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2;

    struct Source {
        uint64 selector;
        uint32 domain;
        address usdc;
        address ccipRouter;
        // Uniswap v4 is not deployed on Amoy, so swapAndSend is unavailable there.
        address poolManager;
    }

    /// SOURCE is one of base, sepolia, amoy.
    function source(string memory name) internal pure returns (Source memory) {
        bytes32 key = keccak256(bytes(name));
        if (key == keccak256("base")) {
            return Source(BASE_SELECTOR, BASE_DOMAIN, BASE_USDC, BASE_CCIP_ROUTER, BASE_POOL_MANAGER);
        }
        if (key == keccak256("sepolia")) {
            return Source(SEPOLIA_SELECTOR, SEPOLIA_DOMAIN, SEPOLIA_USDC, SEPOLIA_CCIP_ROUTER, SEPOLIA_POOL_MANAGER);
        }
        if (key == keccak256("amoy")) {
            return Source(AMOY_SELECTOR, AMOY_DOMAIN, AMOY_USDC, AMOY_CCIP_ROUTER, address(0));
        }
        revert("SOURCE must be base, sepolia or amoy");
    }
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
            Testnet.TOKEN_MESSENGER,
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

/// SOURCE=base SETTLEMENT=0x... forge script script/Deploy.s.sol:DeploySource --rpc-url base_sepolia --broadcast
contract DeploySource is Script {
    function run() external returns (AndThenRouter router, InvoiceBook invoices) {
        Testnet.Source memory src = Testnet.source(vm.envString("SOURCE"));
        address owner = vm.envAddress("DEPLOYER");
        address settlement = vm.envAddress("SETTLEMENT");
        vm.startBroadcast();
        router = new AndThenRouter(
            IERC20(src.usdc),
            ITokenMessengerV2(Testnet.TOKEN_MESSENGER),
            IRouterClient(src.ccipRouter),
            IPoolManager(src.poolManager),
            Testnet.ARC_SELECTOR,
            settlement,
            owner
        );
        // Lanes to Arc accept block-depth finality; the settlement allows depth >= 1.
        router.setConfig(1_200_000, bytes4(uint32(5)));
        invoices = new InvoiceBook(src.ccipRouter, Testnet.ARC_SELECTOR, settlement);
        vm.stopBroadcast();
        console.log("router", address(router));
        console.log("invoices", address(invoices));
    }
}

/// SOURCE=base ROUTER=0x... SETTLEMENT=0x... forge script script/Deploy.s.sol:ConnectArc --rpc-url arc_testnet --broadcast
contract ConnectArc is Script {
    function run() external {
        Testnet.Source memory src = Testnet.source(vm.envString("SOURCE"));
        AndThenSettlement settlement = AndThenSettlement(vm.envAddress("SETTLEMENT"));
        vm.startBroadcast();
        // TokenMessengerV2 has the same address on every CCTP testnet chain.
        settlement.setSource(src.selector, src.domain, vm.envAddress("ROUTER"), Testnet.TOKEN_MESSENGER, src.usdc);
        vm.stopBroadcast();
    }
}
