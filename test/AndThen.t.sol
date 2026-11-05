// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {AndThenSettlement} from "../src/AndThenSettlement.sol";
import {AndThenRouter} from "../src/AndThenRouter.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IMessageTransmitterV2, ITokenMessengerV2} from "../src/interfaces/ICCTP.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Action, Intent, Receipt as SettlementReceipt} from "../src/libraries/Intent.sol";
import {MockToken, MockMessageTransmitter, MockTokenMessenger, MockCCIPRouter} from "./mocks/Mocks.sol";

contract AndThenTest is Test {
    uint64 constant BASE = 10344971235874465080;
    uint64 constant ARC = 3034092155422581607;
    uint32 constant BASE_DOMAIN = 6;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    address payer = makeAddr("payer");
    address merchant = makeAddr("merchant");
    address payee = makeAddr("payee");

    // Arc side
    MockToken usdc;
    MockToken eurc;
    PoolManager arcPools;
    MockCCIPRouter arcCcip;
    MockMessageTransmitter transmitter;
    AndThenSettlement settlement;
    PoolKey eurcPool;

    // Base side. Both chains share one EVM here, so Base gets its own USDC.
    MockToken baseUsdc;
    MockToken weth;
    PoolManager basePools;
    MockCCIPRouter baseCcip;
    MockTokenMessenger messenger;
    AndThenRouter router;
    InvoiceBook invoices;
    PoolKey wethPool;

    uint256 cctpNonce;

    function setUp() public {
        usdc = new MockToken("USDC", 6);
        eurc = new MockToken("EURC", 6);
        arcPools = new PoolManager(address(this));
        arcCcip = new MockCCIPRouter(0.1e6);
        transmitter = new MockMessageTransmitter(usdc);
        settlement = new AndThenSettlement(
            address(arcCcip), arcPools, usdc, IMessageTransmitterV2(address(transmitter)), address(this)
        );
        eurcPool = _seedPool(arcPools, usdc, eurc);
        settlement.setPool(address(eurc), eurcPool);

        baseUsdc = new MockToken("USDC", 6);
        weth = new MockToken("WETH", 6);
        basePools = new PoolManager(address(this));
        baseCcip = new MockCCIPRouter(0.001 ether);
        messenger = new MockTokenMessenger();
        router = new AndThenRouter(
            baseUsdc,
            ITokenMessengerV2(address(messenger)),
            IRouterClient(address(baseCcip)),
            basePools,
            ARC,
            address(settlement),
            address(this)
        );
        invoices = new InvoiceBook(address(baseCcip), ARC, address(settlement));
        wethPool = _seedPool(basePools, baseUsdc, weth);

        settlement.setSource(BASE, BASE_DOMAIN, address(router));
        vm.deal(payer, 1 ether);
    }

    // Settlement

    function test_PayUsdc_IntentThenFunds() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));

        _deliverIntent(intent);
        assertEq(usdc.balanceOf(payee), 0);

        settlement.receiveFunds(_burnMessage(intent.id, 101e6, 0.01e6, address(router)), "");

        assertEq(usdc.balanceOf(payee), 100e6);
        // 101 burned, 0.01 CCTP fee, 0.1 receipt fee, the rest comes back
        assertEq(usdc.balanceOf(payer), 0.89e6);
        assertEq(uint256(settlement.getOrder(intent.id).status), uint256(AndThenSettlement.Status.Settled));

        SettlementReceipt memory receipt = abi.decode(arcCcip.lastData(), (SettlementReceipt));
        assertEq(arcCcip.lastReceiver(), address(invoices));
        assertEq(arcCcip.lastDestination(), BASE);
        assertEq(receipt.intentId, intent.id);
        assertEq(receipt.amount, 100e6);
        assertTrue(receipt.success);
    }

    function test_PayUsdc_FundsThenIntent() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 50e6, address(0));

        settlement.receiveFunds(_burnMessage(intent.id, 50e6, 0, address(router)), "");
        assertEq(settlement.getOrder(intent.id).funded, 50e6);

        _deliverIntent(intent);

        assertEq(usdc.balanceOf(payee), 50e6);
        assertEq(arcCcip.sent(), 0);
    }

    function test_PayEurc_ExactOutThroughPool() public {
        Intent memory intent = _intent(Action.Pay, address(eurc), 40e6, address(0));

        _deliverIntent(intent);
        settlement.receiveFunds(_burnMessage(intent.id, 41e6, 0, address(router)), "");

        assertEq(eurc.balanceOf(payee), 40e6);
        uint256 refund = usdc.balanceOf(payer);
        assertGt(refund, 0);
        assertLt(refund, 1e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_Deposit_SwapsEverything() public {
        Intent memory intent = _intent(Action.Deposit, address(eurc), 19e6, address(0));

        _deliverIntent(intent);
        settlement.receiveFunds(_burnMessage(intent.id, 20e6, 0, address(router)), "");

        assertGt(eurc.balanceOf(payee), 19e6);
        assertEq(usdc.balanceOf(payer), 0);
    }

    function test_Underfunded_RefundsAndReportsFailure() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));
        settlement.fundReceipts(_mintTo(address(this), 1e6));

        _deliverIntent(intent);
        settlement.receiveFunds(_burnMessage(intent.id, 60e6, 0, address(router)), "");

        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(payer), 60e6 - 0.1e6);
        assertEq(uint256(settlement.getOrder(intent.id).status), uint256(AndThenSettlement.Status.Failed));
        assertFalse(abi.decode(arcCcip.lastData(), (SettlementReceipt)).success);
    }

    function test_ReceiptFeeFallsBackToReserve() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));
        settlement.fundReceipts(_mintTo(address(this), 1e6));

        _deliverIntent(intent);
        settlement.receiveFunds(_burnMessage(intent.id, 100e6, 0, address(router)), "");

        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(settlement.feeReserve(), 0.9e6);
        assertEq(arcCcip.sent(), 1);
    }

    function test_SkipsReceiptWhenNothingPaysForIt() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));

        _deliverIntent(intent);
        settlement.receiveFunds(_burnMessage(intent.id, 100e6, 0, address(router)), "");

        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(arcCcip.sent(), 0);
    }

    function test_RevertWhen_IntentFromUnknownSender() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        vm.expectRevert(AndThenSettlement.UnknownSource.selector);
        arcCcip.deliver(address(settlement), BASE, makeAddr("someone"), abi.encode(intent));
    }

    function test_RevertWhen_IntentFromUnknownChain() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        vm.expectRevert(AndThenSettlement.UnknownSource.selector);
        arcCcip.deliver(address(settlement), 16015286601757825753, address(router), abi.encode(intent));
    }

    function test_RevertWhen_BurnFromUnknownSender() public {
        vm.expectRevert(AndThenSettlement.UnknownSource.selector);
        settlement.receiveFunds(_burnMessage(keccak256("x"), 1e6, 0, makeAddr("someone")), "");
    }

    function test_RevertWhen_IntentDelivered_Twice() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        _deliverIntent(intent);
        vm.expectRevert(AndThenSettlement.DuplicateIntent.selector);
        _deliverIntent(intent);
    }

    function test_AllowsFasterThanFinalityFromSource() public view {
        (,,, bytes4 allowed) = settlement.getCCVsAndFinalityConfig(BASE, "");
        assertEq(allowed, bytes4(0x00010001));
    }

    // Router

    function test_Router_SendBurnsAndSendsIntent() public {
        Intent memory draft = _draft(Action.Pay, address(usdc), 10e6, address(invoices));
        baseUsdc.mint(payer, 10e6);

        vm.startPrank(payer);
        baseUsdc.approve(address(router), 10e6);
        bytes32 id = router.send{value: 0.01 ether}(draft, 10e6, 0.001e6);
        vm.stopPrank();

        (
            uint256 amount,
            uint32 domain,
            bytes32 mintRecipient,
            bytes32 caller,
            uint256 maxFee,
            uint32 finality,
            bytes memory hook
        ) = messenger.last();
        assertEq(amount, 10e6);
        assertEq(domain, 26);
        assertEq(mintRecipient, bytes32(uint256(uint160(address(settlement)))));
        assertEq(caller, mintRecipient);
        assertEq(maxFee, 0.001e6);
        assertEq(finality, 1000);
        assertEq(abi.decode(hook, (bytes32)), id);

        Intent memory sent = abi.decode(baseCcip.lastData(), (Intent));
        assertEq(sent.id, id);
        assertEq(sent.payer, payer);
        assertEq(baseCcip.lastReceiver(), address(settlement));
        assertEq(baseCcip.lastDestination(), ARC);
        assertEq(baseCcip.lastExtraArgs(), ExtraArgsCodec._getBasicEncodedExtraArgsV3(600_000, bytes4(0)));
        assertEq(payer.balance, 1 ether - 0.001 ether);
    }

    function test_Router_SwapsThroughPoolFirst() public {
        Intent memory draft = _draft(Action.Pay, address(usdc), 5e6, address(0));
        weth.mint(payer, 6e6);

        vm.startPrank(payer);
        weth.approve(address(router), 6e6);
        router.swapAndSend{value: 0.001 ether}(wethPool, address(weth), 6e6, 5.9e6, draft, 0);
        vm.stopPrank();

        (uint256 amount,,,,,,) = messenger.last();
        assertGt(amount, 5.9e6);
        assertEq(weth.balanceOf(payer), 0);
    }

    function test_Router_RevertWhen_PoolIsNotUsdc() public {
        PoolKey memory other = _seedPool(basePools, weth, new MockToken("X", 6));
        vm.expectRevert(AndThenRouter.NotUsdcPool.selector);
        router.swapAndSend(other, address(weth), 1, 0, _draft(Action.Pay, address(usdc), 1, address(0)), 0);
    }

    function test_Router_RevertWhen_FeeTooLow() public {
        baseUsdc.mint(payer, 1e6);
        vm.startPrank(payer);
        baseUsdc.approve(address(router), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AndThenRouter.FeeTooLow.selector, 0.001 ether));
        router.send(_draft(Action.Pay, address(usdc), 1e6, address(0)), 1e6, 0);
        vm.stopPrank();
    }

    // Full loop: invoice on Base, payment from Base, settlement on Arc, receipt back to Base

    function test_InvoicePaidEndToEnd() public {
        vm.prank(merchant);
        bytes32 invoiceId = invoices.create(payee, address(eurc), 25e6, "order 42");
        settlement.fundReceipts(_mintTo(address(this), 1e6));

        Intent memory draft = _draft(Action.Pay, address(eurc), 25e6, address(invoices));
        draft.invoiceId = invoiceId;
        baseUsdc.mint(payer, 26e6);

        vm.startPrank(payer);
        baseUsdc.approve(address(router), 26e6);
        bytes32 id = router.send{value: 0.001 ether}(draft, 26e6, 0.01e6);
        vm.stopPrank();

        // CCIP carries the instruction, CCTP carries the money
        arcCcip.deliver(address(settlement), BASE, address(router), baseCcip.lastData());
        settlement.receiveFunds(_burnMessage(id, 26e6, 0.003e6, address(router)), "");
        assertEq(eurc.balanceOf(payee), 25e6);

        // The receipt goes back over CCIP and unlocks the invoice
        assertFalse(invoices.isPaid(invoiceId));
        baseCcip.deliver(address(invoices), ARC, address(settlement), arcCcip.lastData());
        assertTrue(invoices.isPaid(invoiceId));
        assertEq(invoices.get(invoiceId).intentId, id);
    }

    function test_Invoice_RejectsWrongToken() public {
        vm.prank(merchant);
        bytes32 invoiceId = invoices.create(payee, address(eurc), 25e6, "");
        SettlementReceipt memory receipt =
            SettlementReceipt(keccak256("i"), invoiceId, payer, payee, address(usdc), 25e6, true);

        baseCcip.deliver(address(invoices), ARC, address(settlement), abi.encode(receipt));
        assertFalse(invoices.isPaid(invoiceId));
    }

    function test_Invoice_RejectsUnknownSender() public {
        SettlementReceipt memory receipt;
        vm.expectRevert(InvoiceBook.UnknownSource.selector);
        baseCcip.deliver(address(invoices), ARC, makeAddr("someone"), abi.encode(receipt));
    }

    // Helpers

    function _draft(Action action, address token, uint256 amount, address replyTo)
        internal
        view
        returns (Intent memory)
    {
        return Intent({
            id: bytes32(0),
            payer: address(0),
            action: action,
            recipient: payee,
            token: token,
            amount: amount,
            invoiceId: bytes32(0),
            replyTo: replyTo
        });
    }

    function _intent(Action action, address token, uint256 amount, address replyTo)
        internal
        returns (Intent memory intent)
    {
        intent = _draft(action, token, amount, replyTo);
        intent.id = keccak256(abi.encode(++cctpNonce));
        intent.payer = payer;
    }

    function _deliverIntent(Intent memory intent) internal {
        arcCcip.deliver(address(settlement), BASE, address(router), abi.encode(intent));
    }

    /// CCTP V2 message layout from developers.circle.com/cctp/references/technical-guide
    function _burnMessage(bytes32 id, uint256 amount, uint256 fee, address sender) internal returns (bytes memory) {
        bytes32 to = bytes32(uint256(uint160(address(settlement))));
        bytes memory header = abi.encodePacked(
            uint32(1),
            BASE_DOMAIN,
            uint32(26),
            bytes32(++cctpNonce),
            bytes32(uint256(uint160(address(messenger)))),
            bytes32(uint256(uint160(address(messenger)))),
            to,
            uint32(1000),
            uint32(1000)
        );
        bytes memory body = abi.encodePacked(
            uint32(1),
            bytes32(uint256(uint160(address(baseUsdc)))),
            to,
            amount,
            bytes32(uint256(uint160(sender))),
            fee,
            fee,
            block.number + 1000,
            abi.encode(id)
        );
        return bytes.concat(header, body);
    }

    function _mintTo(address to, uint256 amount) internal returns (uint256) {
        usdc.mint(to, amount);
        IERC20(address(usdc)).approve(address(settlement), amount);
        return amount;
    }

    function _seedPool(PoolManager manager, MockToken a, MockToken b) internal returns (PoolKey memory key) {
        (MockToken t0, MockToken t1) = address(a) < address(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(address(t0)),
            currency1: Currency.wrap(address(t1)),
            fee: 100,
            tickSpacing: 1,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_PRICE_1_1);

        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        t0.mint(address(this), 1e15);
        t1.mint(address(this), 1e15);
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e14, salt: 0}), ""
        );
    }
}
