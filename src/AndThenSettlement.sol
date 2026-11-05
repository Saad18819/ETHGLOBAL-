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
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IMessageTransmitterV2} from "./interfaces/ICCTP.sol";
import {UniswapV4Swapper} from "./UniswapV4Swapper.sol";
import {Action, Intent, Receipt} from "./libraries/Intent.sol";

/// Lives on Arc. USDC arrives over CCTP, the instruction arrives over CCIP, in either order.
/// Once both are here the instruction runs and a receipt goes back to the source chain.
contract AndThenSettlement is CCIPReceiver, UniswapV4Swapper, Ownable {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

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
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;

    /// CCIP chain selector => our router on that chain.
    mapping(uint64 => address) public sourceRouters;
    /// CCTP domain => CCIP chain selector of the same chain.
    mapping(uint32 => uint64) public domainSelectors;
    /// Output token => USDC pool used to reach it.
    mapping(address => PoolKey) public pools;
    /// ERC-4626 vaults with a USDC asset that Earn may deposit into.
    mapping(address => bool) public vaults;
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
    event PositionMinted(bytes32 indexed id, uint256 indexed tokenId, uint128 liquidity);
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
    error UnknownVault(address vault);
    error BelowMinimum(uint256 got, uint256 minimum);
    error BadRange(int24 lower, int24 upper);

    constructor(
        address ccipRouter,
        IPoolManager _poolManager,
        IERC20 _usdc,
        IMessageTransmitterV2 _transmitter,
        IPositionManager _positionManager,
        IAllowanceTransfer _permit2,
        address owner
    ) CCIPReceiver(ccipRouter) UniswapV4Swapper(_poolManager) Ownable(owner) {
        usdc = _usdc;
        transmitter = _transmitter;
        positionManager = _positionManager;
        permit2 = _permit2;
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

        if (intent.action == Action.Earn) return (_earn(intent, funded), 0);
        if (intent.action == Action.Provide) return _provide(intent, funded);

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

    /// Deposits everything into a Morpho (ERC-4626) vault; the recipient gets the shares.
    function _earn(Intent calldata intent, uint256 funded) internal returns (uint256 shares) {
        if (!vaults[intent.token]) revert UnknownVault(intent.token);
        usdc.forceApprove(intent.token, funded);
        shares = IERC4626(intent.token).deposit(funded, intent.recipient);
        if (shares < intent.amount) revert BelowMinimum(shares, intent.amount);
    }

    /// Swaps half into the pool's other token and mints a position to the recipient.
    /// Returns the liquidity minted and the USDC left over; leftover of the other token goes to the recipient.
    function _provide(Intent calldata intent, uint256 funded) internal returns (uint256, uint256) {
        PoolKey memory key = _pool(intent.token);
        IERC20 other = IERC20(intent.token);

        uint256 otherBefore = other.balanceOf(address(this));
        uint256 half = funded / 2;
        uint256 otherAmount = _swapExactIn(key, address(usdc), half, 0);
        uint256 usdcAmount = funded - half;

        (int24 lower, int24 upper) = _range(intent.data, key.tickSpacing);
        bool usdcIsZero = Currency.unwrap(key.currency0) == address(usdc);
        (uint256 amount0, uint256 amount1) = usdcIsZero ? (usdcAmount, otherAmount) : (otherAmount, usdcAmount);

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        // Leave room for the rounding up PositionManager does when it prices the liquidity.
        liquidity -= liquidity / 10_000 + 1;
        if (liquidity < intent.amount) revert BelowMinimum(liquidity, intent.amount);

        _approvePositions(address(usdc), usdcAmount);
        _approvePositions(address(other), otherAmount);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, lower, upper, uint256(liquidity), uint128(amount0), uint128(amount1), intent.recipient, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        uint256 tokenId = positionManager.nextTokenId();
        uint256 usdcBefore = usdc.balanceOf(address(this));
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR)), params),
            block.timestamp
        );
        emit PositionMinted(intent.id, tokenId, liquidity);

        uint256 otherLeft = other.balanceOf(address(this)) - otherBefore;
        if (otherLeft > 0) other.safeTransfer(intent.recipient, otherLeft);
        return (liquidity, usdcAmount - (usdcBefore - usdc.balanceOf(address(this))));
    }

    function _range(bytes calldata data, int24 spacing) internal pure returns (int24 lower, int24 upper) {
        if (data.length == 0) return (TickMath.minUsableTick(spacing), TickMath.maxUsableTick(spacing));
        (lower, upper) = abi.decode(data, (int24, int24));
        if (lower >= upper || lower % spacing != 0 || upper % spacing != 0) revert BadRange(lower, upper);
    }

    function _approvePositions(address token, uint256 amount) internal {
        IERC20(token).forceApprove(address(permit2), amount);
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
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

    function setVault(address vault, bool allowed) external onlyOwner {
        if (allowed && IERC4626(vault).asset() != address(usdc)) revert UnknownVault(vault);
        vaults[vault] = allowed;
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
