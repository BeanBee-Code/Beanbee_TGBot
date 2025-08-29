// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SecureBeanBeeRouter
 * @notice A secure router for executing swaps via a whitelisted set of external routers.
 * This contract fixes critical security vulnerabilities found in the original BeanBeeRouter.
 */
contract SecureBeanBeeRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- State Variables ---

    // Mapping to store whitelisted router addresses. Only these can be called.
    mapping(address => bool) public whitelistedRouters;

    // --- Events ---

    event RouterWhitelisted(address indexed router);
    event RouterRemoved(address indexed router);
    event SwapExecuted(address indexed user, address indexed router, uint256 value);
    event TokenSwapExecuted(address indexed user, address indexed tokenIn, address indexed router, uint256 amountIn);

    // --- Constructor ---

    constructor() Ownable(msg.sender) {}

    // --- External Functions (Core Logic) ---

    receive() external payable {}

    /**
     * @notice Executes a swap with native currency (ETH/BNB).
     * @dev Replaces the original vulnerable `executeSwap`.
     * @param router The address of the DEX router to call. Must be whitelisted.
     * @param calldata_ The encoded function call for the router (e.g., swapExactETHForTokens).
     */
    function executeSwap(address router, bytes calldata calldata_) external payable nonReentrant {
        // SECURITY: Critical check to ensure the router is trusted and whitelisted.
        require(whitelistedRouters[router], "Router not whitelisted");

        // Execute the external call
        (bool success, ) = router.call{value: msg.value}(calldata_);
        require(success, "Swap execution failed");

        emit SwapExecuted(msg.sender, router, msg.value);
    }

    /**
     * @notice Executes a swap with ERC20 tokens.
     * @dev Replaces the original vulnerable `executeTokenSwap`.
     * @param token The address of the ERC20 token to swap.
     * @param router The address of the DEX router to call. Must be whitelisted.
     * @param amount The amount of the token to swap.
     * @param calldata_ The encoded function call for the router (e.g., swapExactTokensForETH).
     */
    function executeTokenSwap(address token, address router, uint256 amount, bytes calldata calldata_) external nonReentrant {
        // SECURITY: Critical check to ensure the router is trusted and whitelisted.
        require(whitelistedRouters[router], "Router not whitelisted");
        
        IERC20 erc20Token = IERC20(token);

        // Step 1: Securely pull tokens from the user.
        erc20Token.safeTransferFrom(msg.sender, address(this), amount);

        // Step 2: Approve the router to spend the tokens.
        erc20Token.approve(router, amount);

        // Step 3: Execute the external call.
        (bool success, ) = router.call(calldata_);
        
        // SECURITY: Immediately revoke the approval to prevent misuse.
        erc20Token.approve(router, 0);

        require(success, "Token swap execution failed");

        // Step 4: If the swap results in any native currency being sent to this contract,
        // refund it to the user to prevent funds from getting stuck.
        if (address(this).balance > 0) {
            payable(msg.sender).transfer(address(this).balance);
        }

        emit TokenSwapExecuted(msg.sender, token, router, amount);
    }

    // --- Admin Functions (Owner Only) ---

    /**
     * @notice Add a new trusted router address to the whitelist.
     * @param _router The address of the router to whitelist.
     */
    function addRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router address");
        whitelistedRouters[_router] = true;
        emit RouterWhitelisted(_router);
    }

    /**
     * @notice Remove a router address from the whitelist.
     * @param _router The address of the router to remove.
     */
    function removeRouter(address _router) external onlyOwner {
        whitelistedRouters[_router] = false;
        emit RouterRemoved(_router);
    }

    /**
     * @notice Withdraw any native currency accidentally stuck in the contract.
     */
    function withdrawStuckBNB() external onlyOwner nonReentrant {
        payable(owner()).transfer(address(this).balance);
    }

    /**
     * @notice Withdraw any ERC20 tokens accidentally stuck in the contract.
     * @param tokenAddress The address of the ERC20 token to withdraw.
     */
    function withdrawStuckTokens(address tokenAddress) external onlyOwner nonReentrant {
        IERC20 token = IERC20(tokenAddress);
        token.safeTransfer(owner(), token.balanceOf(address(this)));
    }
}