// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {FinalityCodec} from "@chainlink/contracts-ccip/contracts/libraries/FinalityCodec.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {IMessageTransmitterV2} from "./interfaces/ICCTP.sol";
import {UniswapV4Swapper} from "./UniswapV4Swapper.sol";
import {Action, Intent, Receipt} from "./libraries/Intent.sol";

/// Lives on Arc. USDC arrives over CCTP, the instruction arrives over CCIP, in either order.
/// Once both are here the instruction runs and a receipt goes back to the source chain.
contract AndThenSettlement is CCIPReceiver, UniswapV4Swapper, Ownable {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Settled,
        Failed
    }

    struct Order {
        Intent intent;
        uint64 sourceChain;
        uint256 funded;
        Status status;
    }

    /// On Arc the native balance is USDC with 18 decimals, the ERC20 view of it has 6.
    uint256 public constant NATIVE_SCALE = 1e12;

    IERC20 public immutable usdc;
    IMessageTransmitterV2 public immutable transmitter;

    /// CCIP chain selector => our router on that chain.
    mapping(uint64 => address) public sourceRouters;
    /// CCTP domain => CCIP chain selector of the same chain.
    mapping(uint32 => uint64) public domainSelectors;
    /// Output token => USDC pool used to reach it.
    mapping(address => PoolKey) public pools;
    mapping(bytes32 => Order) internal orders;

    address public feeToken;
    uint256 public feeReserve;
    uint32 public receiptGasLimit = 200_000;
    bytes4 public allowedFinality = FinalityCodec._encodeBlockDepthAndSafeFlag(1);

    event IntentReceived(bytes32 indexed id, uint64 indexed sourceChain, address indexed payer);
    event Funded(bytes32 indexed id, uint256 amount);
    event Settled(
        bytes32 indexed id,
        bytes32 indexed invoiceId,
        address payer,
        address indexed recipient,
        address token,
        uint256 amount
    );
    event SettlementFailed(bytes32 indexed id, bytes reason);
    event ReceiptSent(bytes32 indexed id, bytes32 messageId, uint256 fee);
    event ReceiptSkipped(bytes32 indexed id, bytes reason);

    error UnknownSource();
    error DuplicateIntent();
    error WrongRecipient();
    error NothingMinted();
    error NoPool(address token);
    error OnlySelf();
    error Underfunded(uint256 funded, uint256 needed);

    constructor(
        address ccipRouter,
        IPoolManager _poolManager,
        IERC20 _usdc,
        IMessageTransmitterV2 _transmitter,
        address owner
    ) CCIPReceiver(ccipRouter) UniswapV4Swapper(_poolManager) Ownable(owner) {
        usdc = _usdc;
        transmitter = _transmitter;
    }

    // Inbound

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sender = abi.decode(message.sender, (address));
        if (sender == address(0) || sourceRouters[message.sourceChainSelector] != sender) revert UnknownSource();

        Intent memory intent = abi.decode(message.data, (Intent));
        Order storage order = orders[intent.id];
        if (order.intent.id != bytes32(0)) revert DuplicateIntent();

        order.intent = intent;
        order.sourceChain = message.sourceChainSelector;
        emit IntentReceived(intent.id, message.sourceChainSelector, intent.payer);

        _trySettle(intent.id);
    }

    /// Relays a CCTP burn from one of our routers and mints the USDC here. Anyone can call it.
    function receiveFunds(bytes calldata message, bytes calldata attestation) external {
        // Header and burn message offsets: developers.circle.com/cctp/references/technical-guide#message-format
        uint32 sourceDomain = uint32(bytes4(message[4:8]));
        bytes calldata body = message[148:];
        address burnSender = address(uint160(uint256(bytes32(body[100:132]))));
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        bytes32 id = bytes32(body[228:260]);

        uint64 selector = domainSelectors[sourceDomain];
        if (selector == 0 || sourceRouters[selector] != burnSender) revert UnknownSource();
        if (mintRecipient != address(this)) revert WrongRecipient();

        uint256 before = usdc.balanceOf(address(this));
        transmitter.receiveMessage(message, attestation);
        uint256 minted = usdc.balanceOf(address(this)) - before;
        if (minted == 0) revert NothingMinted();

        orders[id].funded += minted;
        emit Funded(id, minted);

        _trySettle(id);
    }

    // Settlement

    function _trySettle(bytes32 id) internal {
        Order storage order = orders[id];
        if (order.intent.id == bytes32(0) || order.funded == 0 || order.status != Status.Open) return;

        Intent memory intent = order.intent;
        uint256 funded = order.funded;

        try this.execute(intent, funded) returns (uint256 delivered, uint256 surplus) {
            order.status = Status.Settled;
            emit Settled(id, intent.invoiceId, intent.payer, intent.recipient, intent.token, delivered);
            surplus -= _sendReceipt(order, delivered, true, surplus);
            if (surplus > 0) usdc.safeTransfer(intent.payer, surplus);
        } catch (bytes memory reason) {
            order.status = Status.Failed;
            emit SettlementFailed(id, reason);
            uint256 refund = funded - _sendReceipt(order, 0, false, funded);
            usdc.safeTransfer(intent.payer, refund);
        }
    }

    /// Runs the action. External so a failure can be caught and rolled back as a whole.
    function execute(Intent calldata intent, uint256 funded) external returns (uint256 delivered, uint256 surplus) {
        if (msg.sender != address(this)) revert OnlySelf();

        bool direct = intent.token == address(usdc);
        uint256 spent;

        if (intent.action == Action.Pay) {
            delivered = intent.amount;
            if (direct) {
                if (funded < delivered) revert Underfunded(funded, delivered);
                spent = delivered;
            } else {
                spent = _swapExactOut(_pool(intent.token), address(usdc), delivered, funded);
            }
        } else {
            spent = funded;
            delivered = direct ? funded : _swapExactIn(_pool(intent.token), address(usdc), funded, intent.amount);
        }

        IERC20(intent.token).safeTransfer(intent.recipient, delivered);
        surplus = funded - spent;
    }

    /// Sends the receipt if the source asked for one. Returns how much of `available` paid for it.
    function _sendReceipt(Order storage order, uint256 delivered, bool success, uint256 available)
        internal
        returns (uint256 fromOrder)
    {
        Intent memory intent = order.intent;
        if (intent.replyTo == address(0)) return 0;

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(intent.replyTo),
            data: abi.encode(
                Receipt({
                    intentId: intent.id,
                    invoiceId: intent.invoiceId,
                    payer: intent.payer,
                    recipient: intent.recipient,
                    token: intent.token,
                    amount: delivered,
                    success: success
                })
            ),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(receiptGasLimit, FinalityCodec.WAIT_FOR_FINALITY_FLAG)
        });

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(order.sourceChain, message);

        // Paid in USDC (native or ERC20): the order's own leftover pays first, the reserve covers the rest.
        bool native = feeToken == address(0);
        bool inUsdc = native || feeToken == address(usdc);
        uint256 cost = native ? Math.ceilDiv(fee, NATIVE_SCALE) : fee;
        if (inUsdc) {
            fromOrder = cost < available ? cost : available;
            if (cost - fromOrder > feeReserve) {
                emit ReceiptSkipped(intent.id, "fee");
                return 0;
            }
            feeReserve -= cost - fromOrder;
        } else if (IERC20(feeToken).balanceOf(address(this)) < fee) {
            emit ReceiptSkipped(intent.id, "fee");
            return 0;
        }

        if (!native) IERC20(feeToken).forceApprove(address(router), fee);
        try router.ccipSend{value: native ? fee : 0}(order.sourceChain, message) returns (bytes32 messageId) {
            emit ReceiptSent(intent.id, messageId, fee);
        } catch (bytes memory reason) {
            if (inUsdc) feeReserve += cost - fromOrder;
            fromOrder = 0;
            emit ReceiptSkipped(intent.id, reason);
        }
    }

    function _pool(address token) internal view returns (PoolKey memory key) {
        key = pools[token];
        if (key.tickSpacing == 0) revert NoPool(token);
    }

    // Views

    function getOrder(bytes32 id) external view returns (Order memory) {
        return orders[id];
    }

    /// Lets the source chain use faster-than-finality for the instruction.
    function getCCVsAndFinalityConfig(uint64, bytes calldata)
        external
        view
        override
        returns (address[] memory, address[] memory, uint8, bytes4)
    {
        return (new address[](0), new address[](0), 0, allowedFinality);
    }

    // Admin

    function setSource(uint64 selector, uint32 domain, address router) external onlyOwner {
        sourceRouters[selector] = router;
        domainSelectors[domain] = selector;
    }

    function setPool(address token, PoolKey calldata key) external onlyOwner {
        address other = Currency.unwrap(key.currency0) == address(usdc)
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        if (other != token) revert NoPool(token);
        pools[token] = key;
    }

    function setReceiptConfig(address _feeToken, uint32 gasLimit) external onlyOwner {
        feeToken = _feeToken;
        receiptGasLimit = gasLimit;
    }

    function setAllowedFinality(bytes4 finality) external onlyOwner {
        allowedFinality = finality;
    }

    /// Prepays receipt fees in USDC.
    function fundReceipts(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        feeReserve += amount;
    }

    function withdrawReserve(uint256 amount, address to) external onlyOwner {
        feeReserve -= amount;
        usdc.safeTransfer(to, amount);
    }
}
