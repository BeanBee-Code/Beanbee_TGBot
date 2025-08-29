// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title VerifiedSwapRouter
 * @notice A secure router for executing swaps, protected by off-chain signature verification
 *         to prevent unauthorized use of calculated swap paths.
 * @dev This version removes all fee mechanisms for a simpler, gas-efficient design.
 */
contract VerifiedSwapRouter is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    address public signerAddress;

    // Mapping to store whitelisted router addresses.
    mapping(address => bool) public whitelistedRouters;
    
    // Nonce for each user to prevent replay attacks.
    mapping(address => uint256) public userNonces;

    // --- Structs & Hashes for EIP-712 Signature Verification ---

    bytes32 private constant EXECUTE_SWAP_PERMIT_TYPEHASH =
        keccak256("ExecuteSwapPermit(address user,address router,bytes calldata_,uint256 nonce,uint256 deadline)");

    bytes32 private constant EXECUTE_TOKEN_SWAP_PERMIT_TYPEHASH =
        keccak256("ExecuteTokenSwapPermit(address user,address token,address router,uint256 amount,bytes calldata_,uint256 nonce,uint256 deadline)");

    // --- Events ---

    event RouterAdded(address indexed router);
    event RouterRemoved(address indexed router);
    event SwapExecuted(address indexed user, address indexed router, uint256 valueIn);
    event TokenSwapExecuted(address indexed user, address indexed tokenIn, address indexed router, uint256 amountIn);
    
    // Events for fund withdrawals as per best practices.
    event NativeTokensWithdrawn(address indexed to, uint256 amount);
    event ERC20TokensWithdrawn(address indexed token, address indexed to, uint256 amount);

    // Event for admin changes.
    event SignerAddressUpdated(address indexed newSigner);


    // --- Constructor ---

    constructor(
        address _initialSigner
    ) Ownable(msg.sender) EIP712("VerifiedSwapRouter", "1") {
        signerAddress = _initialSigner;
    }

    receive() external payable {}

    /**
     * @notice Executes a swap with native currency, protected by a signature.
     * @param router The address of the DEX router to call.
     * @param calldata_ The encoded function call for the router.
     * @param deadline The timestamp after which the signature is invalid.
     * @param signature The EIP-712 signature from the authorized signer.
     */
    function executeSwap(
        address router,
        bytes calldata calldata_,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant {
        require(block.timestamp <= deadline, "Signature expired");
        require(whitelistedRouters[router], "Router not whitelisted");

        // Signature Verification
        bytes32 permitHash = _getExecuteSwapPermitHash(msg.sender, router, calldata_, userNonces[msg.sender], deadline);
        address recoveredSigner = ECDSA.recover(permitHash, signature);
        require(recoveredSigner == signerAddress, "Invalid signature");

        // Increment nonce to prevent replay attacks
        userNonces[msg.sender]++;

        // Execute the external call with the full value since there's no fee
        (bool success, ) = router.call{value: msg.value}(calldata_);
        require(success, "Swap execution failed");

        emit SwapExecuted(msg.sender, router, msg.value);
    }

    /**
     * @notice Executes a swap with ERC20 tokens, protected by a signature.
     * @param token The address of the ERC20 token to swap.
     * @param router The address of the DEX router to call.
     * @param amount The amount of the token to swap.
     * @param calldata_ The encoded function call for the router.
     * @param deadline The timestamp after which the signature is invalid.
     * @param signature The EIP-712 signature from the authorized signer.
     */
    function executeTokenSwap(
        address token,
        address router,
        uint256 amount,
        bytes calldata calldata_,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant { // No longer payable
        require(block.timestamp <= deadline, "Signature expired");
        require(whitelistedRouters[router], "Router not whitelisted");
        
        // Signature Verification
        bytes32 permitHash = _getExecuteTokenSwapPermitHash(msg.sender, token, router, amount, calldata_, userNonces[msg.sender], deadline);
        address recoveredSigner = ECDSA.recover(permitHash, signature);
        require(recoveredSigner == signerAddress, "Invalid signature");

        // Increment nonce
        userNonces[msg.sender]++;

        IERC20 erc20Token = IERC20(token);
        erc20Token.safeTransferFrom(msg.sender, address(this), amount);
        erc20Token.approve(router, amount);

        (bool success, ) = router.call(calldata_);
        
        erc20Token.approve(router, 0); // Security best practice

        require(success, "Token swap execution failed");

        // Refund any native currency received from the swap back to the user
        if (address(this).balance > 0) {
            payable(msg.sender).transfer(address(this).balance);
        }

        emit TokenSwapExecuted(msg.sender, token, router, amount);
    }

    // --- Hashing Functions for EIP-712 ---

    function _getExecuteSwapPermitHash(address user, address router, bytes calldata calldata_, uint256 nonce, uint256 deadline) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            EXECUTE_SWAP_PERMIT_TYPEHASH,
            user,
            router,
            keccak256(calldata_),
            nonce,
            deadline
        )));
    }

    function _getExecuteTokenSwapPermitHash(address user, address token, address router, uint256 amount, bytes calldata calldata_, uint256 nonce, uint256 deadline) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            EXECUTE_TOKEN_SWAP_PERMIT_TYPEHASH,
            user,
            token,
            router,
            amount,
            keccak256(calldata_),
            nonce,
            deadline
        )));
    }


    function addRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router address");
        whitelistedRouters[_router] = true;
        emit RouterAdded(_router);
    }

    function removeRouter(address _router) external onlyOwner {
        whitelistedRouters[_router] = false;
        emit RouterRemoved(_router);
    }

    function setSignerAddress(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "Invalid signer address");
        signerAddress = _newSigner;
        emit SignerAddressUpdated(_newSigner);
    }

    /**
     * @notice Withdraw any native currency accidentally stuck in the contract.
     * @dev Added event as per recommendation.
     */
    function withdrawStuckBNB() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner()).transfer(balance);
            emit NativeTokensWithdrawn(owner(), balance);
        }
    }

    /**
     * @notice Withdraw any ERC20 tokens accidentally stuck in the contract.
     * @dev Added event as per recommendation.
     * @param tokenAddress The address of the ERC20 token to withdraw.
     */
    function withdrawStuckTokens(address tokenAddress) external onlyOwner nonReentrant {
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner(), balance);
            emit ERC20TokensWithdrawn(tokenAddress, owner(), balance);
        }
    }
}