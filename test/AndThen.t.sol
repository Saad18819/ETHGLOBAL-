// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {AndThenSettlement} from "../src/AndThenSettlement.sol";
import {AndThenRouter} from "../src/AndThenRouter.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IMessageTransmitterV2, ITokenMessengerV2} from "../src/interfaces/ICCTP.sol";
import {Action, Intent, Receipt as SettlementReceipt} from "../src/libraries/Intent.sol";
import {MockToken, MockMessageTransmitter, MockTokenMessenger, MockCCIPRouter, MockVault} from "./mocks/Mocks.sol";

contract AndThenTest is Test {
    uint64 constant BASE = 10344971235874465080;
    uint64 constant ARC = 3034092155422581607;
    uint32 constant BASE_DOMAIN = 6;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    /// The mock router's fee, 0.1e6 wei of native value, costs one unit of 6-decimal USDC.
    uint256 constant RECEIPT_COST = 1;

    address payer = makeAddr("payer");
    address merchant = makeAddr("merchant");
    address payee = makeAddr("payee");
    address attacker = makeAddr("attacker");

    // Arc side
    MockToken usdc;
    MockToken eurc;
    PoolManager arcPools;
    MockCCIPRouter arcCcip;
    MockMessageTransmitter transmitter;
    PositionManager positions;
    MockVault vault;
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
        messenger = new MockTokenMessenger();
        IAllowanceTransfer permit2 = IAllowanceTransfer(deployCode("Permit2.sol:Permit2"));
        positions = new PositionManager(arcPools, permit2, 100_000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        settlement = new AndThenSettlement(
            address(arcCcip),
            arcPools,
            usdc,
            IMessageTransmitterV2(address(transmitter)),
            address(messenger),
            IPositionManager(address(positions)),
            permit2,
            address(this)
        );
        // On Arc native value and USDC are one balance; the mocks keep them apart, so fund the native side.
        vm.deal(address(settlement), 1 ether);
        eurcPool = _seedPool(arcPools, usdc, eurc);
        settlement.setPool(address(eurc), eurcPool);
        vault = new MockVault(IERC20(address(usdc)));
        settlement.setVault(address(vault), true);

        baseUsdc = new MockToken("USDC", 6);
        weth = new MockToken("WETH", 6);
        basePools = new PoolManager(address(this));
        baseCcip = new MockCCIPRouter(0.001 ether);
        router = new AndThenRouter(
            baseUsdc,
            ITokenMessengerV2(address(messenger)),
            basePools,
            address(settlement),
            address(this)
        );
        invoices = new InvoiceBook(address(baseCcip), ARC, address(settlement));
        wethPool = _seedPool(basePools, baseUsdc, weth);

        settlement.setSource(BASE, BASE_DOMAIN, address(router), address(messenger), address(baseUsdc));
        vm.deal(payer, 1 ether);
    }

    // Happy paths

    function test_PayUsdc_SettlesWhenFundsArrive() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));

        _fund(intent, 101e6, 0.01e6);

        assertEq(usdc.balanceOf(payee), 100e6);
        // 101 burned, 0.01 CCTP fee, one unit for the receipt, the rest comes back
        assertEq(usdc.balanceOf(payer), 0.99e6 - RECEIPT_COST);
        assertEq(uint256(settlement.getOrder(_key(intent)).status), uint256(AndThenSettlement.Status.Settled));

        SettlementReceipt memory receipt = abi.decode(arcCcip.lastData(), (SettlementReceipt));
        assertEq(arcCcip.lastReceiver(), address(invoices));
        assertEq(arcCcip.lastDestination(), BASE);
        assertEq(receipt.intentId, intent.id);
        assertEq(uint8(receipt.action), uint8(Action.Pay));
        assertEq(receipt.amount, 100e6);
        assertTrue(receipt.success);
    }

    function test_PayUsdc_NoReceiptWithoutInvoice() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 50e6, address(0));

        _fund(intent, 50e6, 0);

        assertEq(usdc.balanceOf(payee), 50e6);
        assertEq(arcCcip.sent(), 0);
    }

    function test_PayEurc_ExactOutWithinLimit() public {
        Intent memory intent = _intent(Action.Pay, address(eurc), 40e6, address(0));
        intent.limit = 41e6;

        _fund(intent, 45e6, 0);

        assertEq(eurc.balanceOf(payee), 40e6);
        // Only up to the limit is spent; the extra funding comes back untouched
        assertGt(usdc.balanceOf(payer), 4e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_Deposit_SwapsEverything() public {
        Intent memory intent = _intent(Action.Deposit, address(eurc), 19e6, address(0));

        _fund(intent, 20e6, 0);

        assertGt(eurc.balanceOf(payee), 19e6);
        assertEq(usdc.balanceOf(payer), 0);
    }

    function test_Earn_DepositsIntoVaultForRecipient() public {
        Intent memory intent = _intent(Action.Earn, address(vault), 30e6, address(0));

        _fund(intent, 30e6, 0);

        assertEq(vault.balanceOf(payee), 30e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_Provide_MintsFullRangePositionToRecipient() public {
        Intent memory intent = _intent(Action.Provide, address(eurc), 1, address(0));
        intent.limit = 49e6;
        uint256 tokenId = positions.nextTokenId();

        _fund(intent, 100e6, 0);

        assertEq(uint256(settlement.getOrder(_key(intent)).status), uint256(AndThenSettlement.Status.Settled));
        assertEq(IERC721(address(positions)).ownerOf(tokenId), payee);
        assertGt(positions.getPositionLiquidity(tokenId), 0);
        assertLt(usdc.balanceOf(payer), 0.1e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(eurc.balanceOf(address(settlement)), 0);
        // Approvals are reset after minting
        assertEq(usdc.allowance(address(settlement), address(settlement.permit2())), 0);
    }

    function test_Provide_UsesRequestedRange() public {
        Intent memory intent = _intent(Action.Provide, address(eurc), 1, address(0));
        intent.limit = 49e6;
        intent.data = abi.encode(int24(-100), int24(100));
        uint256 tokenId = positions.nextTokenId();

        _fund(intent, 100e6, 0);

        assertGt(positions.getPositionLiquidity(tokenId), 1e10);
    }

    function test_RefundToOverridesPayer() public {
        address refund = makeAddr("refund");
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(0));
        intent.refundTo = refund;

        _fund(intent, 12e6, 0);

        assertEq(usdc.balanceOf(refund), 2e6);
        assertEq(usdc.balanceOf(payer), 0);
    }

    // Failures refund the payer

    function test_Underfunded_RefundsAndReportsFailure() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(invoices));

        _fund(intent, 60e6, 0);

        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(payer), 60e6 - RECEIPT_COST);
        assertEq(uint256(settlement.getOrder(_key(intent)).status), uint256(AndThenSettlement.Status.Failed));
        assertFalse(abi.decode(arcCcip.lastData(), (SettlementReceipt)).success);
    }

    function test_Swaps_RequireAPriceLimit() public {
        Intent memory pay = _intent(Action.Pay, address(eurc), 10e6, address(0));
        Intent memory provide = _intent(Action.Provide, address(eurc), 1, address(0));
        Intent memory deposit = _intent(Action.Deposit, address(eurc), 0, address(0));

        _fund(pay, 20e6, 0);
        _fund(provide, 20e6, 0);
        _fund(deposit, 20e6, 0);

        assertEq(uint256(settlement.getOrder(_key(pay)).status), uint256(AndThenSettlement.Status.Failed));
        assertEq(uint256(settlement.getOrder(_key(provide)).status), uint256(AndThenSettlement.Status.Failed));
        assertEq(uint256(settlement.getOrder(_key(deposit)).status), uint256(AndThenSettlement.Status.Failed));
        assertEq(usdc.balanceOf(payer), 60e6);
    }

    function test_DirectDeposit_EnforcesMinimum() public {
        Intent memory intent = _intent(Action.Deposit, address(usdc), 30e6, address(0));

        _fund(intent, 20e6, 0);

        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(payer), 20e6);
    }

    function test_Earn_RefundsWhenVaultNotAllowed() public {
        MockVault other = new MockVault(IERC20(address(usdc)));
        Intent memory intent = _intent(Action.Earn, address(other), 0, address(0));

        _fund(intent, 30e6, 0);

        assertEq(usdc.balanceOf(payer), 30e6);
    }

    function test_Provide_RefundsOnBadRange() public {
        Intent memory intent = _intent(Action.Provide, address(eurc), 1, address(0));
        intent.limit = 1;
        intent.data = abi.encode(int24(100), int24(-100));

        _fund(intent, 50e6, 0);

        assertEq(usdc.balanceOf(payer), 50e6);
    }

    function test_Deadline_RefundsInsteadOfRunning() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(0));
        intent.deadline = uint64(block.timestamp + 1 hours);

        vm.warp(block.timestamp + 2 hours);
        _fund(intent, 10e6, 0);

        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(payer), 10e6);
    }

    // Audit H1: the CCTP header must come from the TokenMessengers

    function test_RevertWhen_BurnHeaderSenderIsNotTokenMessenger() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        bytes memory message = _burnMessage(abi.encode(intent), 1e6, 0, address(router));
        _setWord(message, 44, bytes32(uint256(uint160(attacker))));
        vm.expectRevert(AndThenSettlement.NotABurn.selector);
        settlement.receiveFunds(message, "");
    }

    function test_RevertWhen_BurnHeaderRecipientIsNotOurMessenger() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        bytes memory message = _burnMessage(abi.encode(intent), 1e6, 0, address(router));
        _setWord(message, 76, bytes32(uint256(uint160(attacker))));
        vm.expectRevert(AndThenSettlement.NotABurn.selector);
        settlement.receiveFunds(message, "");
    }

    function test_RevertWhen_BurnIsRelayableByAnyone() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        bytes memory message = _burnMessage(abi.encode(intent), 1e6, 0, address(router));
        _setWord(message, 108, bytes32(0));
        vm.expectRevert(AndThenSettlement.NotABurn.selector);
        settlement.receiveFunds(message, "");
    }

    function test_RevertWhen_BurnTokenIsNotUsdc() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        bytes memory message = _burnMessage(abi.encode(intent), 1e6, 0, address(router));
        _setWord(message, 152, bytes32(uint256(uint160(address(weth)))));
        vm.expectRevert(AndThenSettlement.NotABurn.selector);
        settlement.receiveFunds(message, "");
    }

    function test_RevertWhen_BurnFromUnknownSender() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 1e6, address(0));
        intent.recipient = attacker;
        vm.expectRevert(AndThenSettlement.UnknownSource.selector);
        settlement.receiveFunds(_burnMessage(abi.encode(intent), 1e6, 0, attacker), "");
    }

    // A second burn carrying the same intent is refunded, never run twice

    function test_LateFundsForAFinishedOrderGoBackToThePayer() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(0));
        _fund(intent, 10e6, 0);

        _fund(intent, 5e6, 0);

        assertEq(usdc.balanceOf(payer), 5e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    // Audit M5: a refund that cannot be pushed becomes claimable

    function test_BlockedRefundBecomesClaimable() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 100e6, address(0));
        usdc.setBlocked(payer, true);

        _fund(intent, 60e6, 0);

        assertEq(settlement.claimable(payer), 60e6);
        usdc.setBlocked(payer, false);
        vm.prank(payer);
        settlement.claim();
        assertEq(usdc.balanceOf(payer), 60e6);
    }

    // Audit M4 and M8: receipts never block settlement, are paid by the order, and can be retried

    function test_ReceiptFailureDoesNotBlockSettlement() public {
        arcCcip.setFeeReverts(true);
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(invoices));

        _fund(intent, 11e6, 0);

        assertEq(usdc.balanceOf(payee), 10e6);
        assertEq(usdc.balanceOf(payer), 1e6);
        assertFalse(settlement.getOrder(_key(intent)).receiptSent);

        arcCcip.setFeeReverts(false);
        settlement.retryReceipt{value: 0.1e6}(_key(intent));
        assertTrue(settlement.getOrder(_key(intent)).receiptSent);
        assertEq(arcCcip.sent(), 1);
    }

    function test_ReceiptWithoutLeftoverIsSkippedNotSubsidised() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(invoices));

        _fund(intent, 10e6, 0);

        assertEq(usdc.balanceOf(payee), 10e6);
        assertEq(arcCcip.sent(), 0);

        vm.expectRevert(abi.encodeWithSelector(AndThenSettlement.FeeTooLow.selector, 0.1e6));
        settlement.retryReceipt(_key(intent));
    }

    function test_RevertWhen_RetryingAReceiptAlreadySent() public {
        Intent memory intent = _intent(Action.Pay, address(usdc), 10e6, address(invoices));
        _fund(intent, 11e6, 0);
        vm.expectRevert(AndThenSettlement.NoReceiptDue.selector);
        settlement.retryReceipt{value: 0.1e6}(_key(intent));
    }

    function test_RevertWhen_PoolHasHooks() public {
        PoolKey memory key = eurcPool;
        key.hooks = IHooks(attacker);
        vm.expectRevert(abi.encodeWithSelector(AndThenSettlement.NoPool.selector, address(eurc)));
        settlement.setPool(address(eurc), key);
    }

    // Router

    function test_Router_BurnCarriesTheWholeIntent() public {
        Intent memory draft = _draft(Action.Pay, address(usdc), 10e6, address(invoices));
        baseUsdc.mint(payer, 10e6);

        vm.startPrank(payer);
        baseUsdc.approve(address(router), 10e6);
        bytes32 id = router.send(draft, 10e6, 0.001e6, 1000);
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

        Intent memory sent = abi.decode(hook, (Intent));
        assertEq(sent.id, id);
        assertEq(sent.payer, payer);
        assertEq(sent.recipient, payee);
        // Nothing goes over CCIP on the way there
        assertEq(baseCcip.sent(), 0);
    }

    function test_Router_SwapsThroughPoolFirst() public {
        Intent memory draft = _draft(Action.Pay, address(usdc), 5e6, address(0));
        weth.mint(payer, 6e6);

        vm.startPrank(payer);
        weth.approve(address(router), 6e6);
        router.swapAndSend(wethPool, address(weth), 6e6, 5.9e6, draft, 0, 2000);
        vm.stopPrank();

        (uint256 amount,,,,, uint32 finality,) = messenger.last();
        assertGt(amount, 5.9e6);
        assertEq(finality, 2000);
    }

    function test_Router_RevertWhen_TokenInIsNotInThePool() public {
        vm.expectRevert(AndThenRouter.NotUsdcPool.selector);
        router.swapAndSend(wethPool, address(eurc), 1, 0, _draft(Action.Pay, address(usdc), 1, address(0)), 0, 1000);
    }

    function test_Router_RevertWhen_PoolIsNotUsdc() public {
        PoolKey memory other = _seedPool(basePools, weth, new MockToken("X", 6));
        vm.expectRevert(AndThenRouter.NotUsdcPool.selector);
        router.swapAndSend(other, address(weth), 1, 0, _draft(Action.Pay, address(usdc), 1, address(0)), 0, 1000);
    }

    function test_Router_RevertWhen_DataTooLong() public {
        Intent memory draft = _draft(Action.Provide, address(eurc), 1, address(0));
        draft.data = new bytes(65);
        baseUsdc.mint(payer, 1e6);
        vm.startPrank(payer);
        baseUsdc.approve(address(router), 1e6);
        vm.expectRevert(AndThenRouter.DataTooLong.selector);
        router.send(draft, 1e6, 0, 1000);
        vm.stopPrank();
    }

    // Full loop: invoice on Base, payment from Base, settlement on Arc, receipt back to Base

    function test_InvoicePaidEndToEnd() public {
        vm.prank(merchant);
        bytes32 invoiceId = invoices.create(payee, address(eurc), 25e6, "order 42");

        Intent memory draft = _draft(Action.Pay, address(eurc), 25e6, address(invoices));
        draft.invoiceId = invoiceId;
        draft.limit = 26e6;
        baseUsdc.mint(payer, 26e6);

        vm.startPrank(payer);
        baseUsdc.approve(address(router), 26e6);
        router.send(draft, 26e6, 0.01e6, 1000);
        vm.stopPrank();

        // CCTP carries the money and the instruction together
        (,,,,,, bytes memory hook) = messenger.last();
        settlement.receiveFunds(_burnMessage(hook, 26e6, 0.003e6, address(router)), "");
        assertEq(eurc.balanceOf(payee), 25e6);

        // The receipt goes back over CCIP and unlocks the invoice
        assertFalse(invoices.isPaid(invoiceId));
        baseCcip.deliver(address(invoices), ARC, address(settlement), arcCcip.lastData());
        assertTrue(invoices.isPaid(invoiceId));
    }

    // Audit H2: only a payment receipt unlocks an invoice

    function test_Invoice_RejectsProvideReceipt() public {
        vm.prank(merchant);
        bytes32 invoiceId = invoices.create(payee, address(eurc), 25e6, "");
        SettlementReceipt memory receipt =
            SettlementReceipt(keccak256("i"), invoiceId, payer, payee, Action.Provide, address(eurc), 1e18, true);

        baseCcip.deliver(address(invoices), ARC, address(settlement), abi.encode(receipt));
        assertFalse(invoices.isPaid(invoiceId));
    }

    function test_Invoice_RejectsWrongToken() public {
        vm.prank(merchant);
        bytes32 invoiceId = invoices.create(payee, address(eurc), 25e6, "");
        SettlementReceipt memory receipt =
            SettlementReceipt(keccak256("i"), invoiceId, payer, payee, Action.Pay, address(usdc), 25e6, true);

        baseCcip.deliver(address(invoices), ARC, address(settlement), abi.encode(receipt));
        assertFalse(invoices.isPaid(invoiceId));
    }

    function test_Invoice_RejectsUnknownSender() public {
        SettlementReceipt memory receipt;
        vm.expectRevert(InvoiceBook.UnknownSource.selector);
        baseCcip.deliver(address(invoices), ARC, attacker, abi.encode(receipt));
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
            limit: 0,
            deadline: 0,
            refundTo: address(0),
            invoiceId: bytes32(0),
            replyTo: replyTo,
            data: ""
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

    function _key(Intent memory intent) internal pure returns (bytes32) {
        return keccak256(abi.encode(intent));
    }

    function _fund(Intent memory intent, uint256 amount, uint256 fee) internal {
        settlement.receiveFunds(_burnMessage(abi.encode(intent), amount, fee, address(router)), "");
    }

    /// CCTP V2 message layout from developers.circle.com/cctp/references/technical-guide
    function _burnMessage(bytes memory hook, uint256 amount, uint256 fee, address sender) internal returns (bytes memory) {
        bytes32 to = bytes32(uint256(uint160(address(settlement))));
        bytes32 tokenMessenger = bytes32(uint256(uint160(address(messenger))));
        bytes memory header = abi.encodePacked(
            uint32(1),
            BASE_DOMAIN,
            uint32(26),
            bytes32(++cctpNonce),
            tokenMessenger,
            tokenMessenger,
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
            hook
        );
        return bytes.concat(header, body);
    }

    function _setWord(bytes memory data, uint256 offset, bytes32 word) internal pure {
        assembly {
            mstore(add(add(data, 32), offset), word)
        }
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
