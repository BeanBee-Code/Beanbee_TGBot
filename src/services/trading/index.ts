import { Context } from 'telegraf';
import { ethers } from 'ethers';
import { PancakeSwapTrader, TokenInfo, formatNumber } from '../pancakeswap';
import { UserService } from '../user';
import { PancakeSwapExecutor } from '../pancakeswap/executor';
import { getBNBBalance, formatBNBBalance, formatUSDValue } from '../wallet/balance';
import { getTranslation } from '@/i18n';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { createLogger } from '@/utils/logger';
import { pairDiscoveryService } from '../pancakeswap/pairDiscovery';
import { getSingleTokenAnalytics } from '../moralis';
import { getScannerConfig } from '@/config/scanner';
import { isKnownDeadToken, storeDeadToken } from '../wallet/scanner';
import { TokenSearchService } from '../tokenSearch';
import { decryptPrivateKey } from '../wallet/tradingWallet';
import { priceDeviationChecker } from '../priceDeviation/priceDeviationChecker';
import { signatureService } from './signatureService';
// Import ABI directly (it's already an array, not an object with .abi property)
import SecureBeanBeeRouterABI from '../../config/abi/SecureBeanBeeRouter.json';

const logger = createLogger('trading');

export class TradingService {
	private trader: PancakeSwapTrader;
	private executor: PancakeSwapExecutor;
	private tokenSearch: TokenSearchService;
	// Secure router contract address (supports both V2 and V3)
	private readonly SECURE_ROUTER_ADDRESS = '0x8372Ec5Da575D4c637dfaA33a22DF96406D7d1F4'; // Updated secure router
	// PancakeSwap Smart Router - MUST use this address for all Smart Router SDK calldata
	// The SDK generates calldata specifically for this contract, NOT for individual V2/V3 routers
	private readonly PANCAKESWAP_SMART_ROUTER_ADDRESS = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';

	constructor() {
		this.trader = new PancakeSwapTrader();
		this.executor = new PancakeSwapExecutor();
		this.tokenSearch = new TokenSearchService(process.env.MORALIS_API_KEY);
	}

	// Helper method to invalidate DeFi position cache
	private async invalidateDeFiCache(userId: number, walletAddress: string) {
		try {
			await DeFiPosition.updateMany(
				{
					userId: userId,
					walletAddress: walletAddress.toLowerCase()
				},
				{
					$set: { lastRefreshAt: new Date(0) } // Set to epoch to force refresh
				}
			);
			logger.info('Invalidated DeFi cache', {
				userId,
				walletAddress
			});
		} catch (error) {
			logger.error('Error invalidating DeFi cache', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}

	// Enhanced method to handle auto-detected token addresses with smart validation based on user intent
	async handleAutoDetectedToken(ctx: Context, tokenAddress: string) {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			const errorMessage = await getTranslation(ctx, 'trading.tradingWalletNotFound');
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply(errorMessage, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'buy_sell' }]
					]
				}
			});
			return;
		}

		const processingMsg = await ctx.reply(await getTranslation(ctx, 'trading.analyzingToken'));

		try {
			// NEW LOGIC: Check balance FIRST to determine user's intent (buy vs. sell)
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);
			const hasBalance = parseFloat(userBalance) > 0;
			const tokenDetails = await this.tokenSearch.getTokenByAddress(tokenAddress);

			// Basic check: Token must be valid
			if (!tokenDetails) {
				await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
				const errorMessage = await getTranslation(ctx, 'trading.invalidTokenAddress');
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply(errorMessage, {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'buy_sell' }]
						]
					}
				});
				return;
			}

			// Conditional validation based on intent
			if (hasBalance) {
				// SELL SCENARIO: User owns the token. Bypass strict validation.
				logger.info(`User holds ${tokenDetails.symbol}. Bypassing strict validation for SELL operation.`);
				// We can proceed directly to the sell menu.
			} else {
				// BUY SCENARIO: User does not own the token. Perform all strict validations.
				logger.info(`User does not hold ${tokenDetails.symbol}. Performing strict validation for BUY operation.`);

				// Step 1: Check our local database for known dead tokens
				if (await isKnownDeadToken(tokenAddress)) {
					await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
					const errorMessage = await getTranslation(ctx, 'trading.knownDeadToken');
					const backButtonText = await getTranslation(ctx, 'common.back');
					await ctx.reply(errorMessage, {
						parse_mode: 'Markdown',
						reply_markup: {
							inline_keyboard: [
								[{ text: backButtonText, callback_data: 'buy_sell' }]
							]
						}
					});
					return;
				}

				// Step 2: Verify trading pairs exist on PancakeSwap
				const discoveryResult = await pairDiscoveryService.discoverTokenPair(tokenAddress);
				if (!discoveryResult || !discoveryResult.bestPair) {
					await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
					const errorMessage = await getTranslation(ctx, 'trading.noTradingPair');
					const backButtonText = await getTranslation(ctx, 'common.back');
					await ctx.reply(errorMessage, {
						parse_mode: 'Markdown',
						reply_markup: {
							inline_keyboard: [
								[{ text: backButtonText, callback_data: 'buy_sell' }]
							]
						}
					});
					return;
				}

				// Step 3: Verify liquidity using DexScreener data
				const config = getScannerConfig();
				const estimatedLiquidity = tokenDetails.marketCap ?
					(tokenDetails.marketCap / 2) :
					(tokenDetails.volume24h || 0);

				if (estimatedLiquidity < config.minLiquidityUsd) {
					await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
					await ctx.reply(
						await getTranslation(ctx, 'trading.lowLiquidity', {
							liquidity: formatUSDValue(estimatedLiquidity)
						}),
						{ parse_mode: 'Markdown' }
					);

					// Store this newly discovered dead token for future quick rejection
					await storeDeadToken(
						tokenAddress,
						tokenDetails.symbol,
						tokenDetails.name,
						'no_liquidity'
					);
					return;
				}
			}

			// All necessary validation has passed for the given scenario (buy or sell)
			await ctx.deleteMessage(processingMsg.message_id).catch(() => { });

			// Initialize trading session
			if (!session) {
				await ctx.reply(await getTranslation(ctx, 'trading.sessionNotFound'));
				return;
			}

			if (!session.trading) {
				session.trading = {};
			}

			session.trading.tokenAddress = tokenAddress;
			const tokenInfo = {
				address: tokenDetails.address,
				name: tokenDetails.name,
				symbol: tokenDetails.symbol,
				decimals: tokenDetails.decimals,
				balance: userBalance
			};
			session.trading.tokenInfo = tokenInfo;
			session.trading.userBalance = userBalance;

			// Show buy or sell menu based on balance
			if (hasBalance) {
				await this.showSellMenu(ctx, tokenInfo, userBalance, tradingWalletAddress);
			} else {
				await this.showBuyMenu(ctx, tokenInfo, tradingWalletAddress, userBalance);
			}

		} catch (error) {
			await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
			logger.error('Error handling auto-detected token', {
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			const errorMessage = await getTranslation(ctx, 'trading.errorHandlingToken');
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply(errorMessage, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'buy_sell' }]
					]
				}
			});
		}
	}

	// New method to show trading interface similar to the example
	async showTokenTradingInterface(ctx: Context, tokenInfo: TokenInfo, userBalance: string, hasBalance: boolean) {
		const userId = ctx.from!.id;
		const balanceNum = parseFloat(userBalance);
		const displayBalance = formatNumber(balanceNum);

		// Import services
		const { UserService } = await import('../user');
		const { getBNBBalance, formatBNBBalance } = await import('../wallet/balance');

		// Get trading wallet BNB balance
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		let bnbBalance = '0';
		if (tradingWalletAddress) {
			bnbBalance = await getBNBBalance(tradingWalletAddress);
		}

		// Create trading interface similar to the example
		const message = `🪙 **${tokenInfo.symbol}** Trading

📊 **Token Info:**
- Name: ${tokenInfo.name}
- Symbol: ${tokenInfo.symbol}
- Contract: \`${tokenInfo.address}\`

💰 **Your Balance:** ${displayBalance} ${tokenInfo.symbol}
💵 **Trading Wallet BNB:** ${formatBNBBalance(bnbBalance)} BNB

${hasBalance ? '🟢 You own this token' : '⚪ You don\'t own this token'}`;

		// Create keyboard with buy/sell options
		const keyboard = {
			inline_keyboard: [
				// Main action buttons
				[
					{ text: '💰 Buy', callback_data: `token_buy_${tokenInfo.address}` },
					...(hasBalance ? [{ text: '💸 Sell', callback_data: `token_sell_${tokenInfo.address}` }] : [])
				],
				// Quick buy amounts (in BNB)
				[
					{ text: '0.1 BNB', callback_data: `quick_buy_0.1_${tokenInfo.address}` },
					{ text: '0.5 BNB', callback_data: `quick_buy_0.5_${tokenInfo.address}` },
					{ text: '1 BNB', callback_data: `quick_buy_1_${tokenInfo.address}` }
				],
				// Quick sell percentages (if user has balance)
				...(hasBalance ? [[
					{ text: '25%', callback_data: `quick_sell_25_${tokenInfo.address}` },
					{ text: '50%', callback_data: `quick_sell_50_${tokenInfo.address}` },
					{ text: '100%', callback_data: `quick_sell_100_${tokenInfo.address}` }
				]] : []),
				// Utility buttons
				[
					{ text: '📊 DexScreener', url: `https://dexscreener.com/bsc/${tokenInfo.address}` },
					{ text: '🔄 Refresh', callback_data: `refresh_token_${tokenInfo.address}` }
				],
				[{ text: '🔙 Back to Menu', callback_data: 'start_edit' }]
			]
		};

		await ctx.reply(message, {
			reply_markup: keyboard,
			parse_mode: 'Markdown'
		});
	}

	// Show buy menu
	async showBuyMenu(ctx: Context, tokenInfo: TokenInfo, tradingWalletAddress: string, userBalance?: string) {
		const bnbBalance = await getBNBBalance(tradingWalletAddress);
		const hasBalance = userBalance && parseFloat(userBalance) > 0;

		const ownershipMessage = hasBalance
			? await getTranslation(ctx, 'trading.ownToken')
			: await getTranslation(ctx, 'trading.dontOwnToken');

		const message = await getTranslation(ctx, 'trading.tradingInterface', { symbol: tokenInfo.symbol }) + `

${await getTranslation(ctx, 'trading.tokenInfo')}
- ${await getTranslation(ctx, 'trading.name')}: ${tokenInfo.name}
- ${await getTranslation(ctx, 'trading.symbol')}: ${tokenInfo.symbol}
- ${await getTranslation(ctx, 'trading.contract')}: \`${tokenInfo.address}\`

${await getTranslation(ctx, 'trading.yourBalance')} ${hasBalance ? formatNumber(parseFloat(userBalance)) : '0'} ${tokenInfo.symbol}
${await getTranslation(ctx, 'trading.tradingWalletBNB')} ${formatBNBBalance(bnbBalance)} BNB

${ownershipMessage}`;

		const keyboard = {
			inline_keyboard: [
				// Only show switch to sell if user has balance
				...(hasBalance ? [[{ text: await getTranslation(ctx, 'trading.switchToSell'), callback_data: `switch_to_sell_${tokenInfo.address}` }]] : []),
				[
					{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '0.01' }), callback_data: `buy_amount_0.01_${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '0.1' }), callback_data: `buy_amount_0.1_${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '1' }), callback_data: `buy_amount_1_${tokenInfo.address}` }
				],
				[
					{ text: await getTranslation(ctx, 'trading.customAmount'), callback_data: `buy_custom_${tokenInfo.address}` }
				],
				[
					{ text: await getTranslation(ctx, 'trading.dexScreener'), url: `https://dexscreener.com/bsc/${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.refresh'), callback_data: `refresh_token_${tokenInfo.address}` }
				],
				[{ text: await getTranslation(ctx, 'trading.backToMenu'), callback_data: 'start_edit' }]
			]
		};

		// Check if we should edit or send new message
		if (ctx.callbackQuery?.message) {
			await ctx.editMessageText(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});
		} else {
			await ctx.reply(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});
		}
	}

	// Show sell menu
	async showSellMenu(ctx: Context, tokenInfo: TokenInfo, userBalance: string, tradingWalletAddress: string) {
		const bnbBalance = await getBNBBalance(tradingWalletAddress);
		const displayBalance = formatNumber(parseFloat(userBalance));
		const hasBalance = parseFloat(userBalance) > 0;

		const ownershipMessage = hasBalance
			? await getTranslation(ctx, 'trading.ownToken')
			: await getTranslation(ctx, 'trading.dontOwnToken');

		const message = await getTranslation(ctx, 'trading.tradingInterface', { symbol: tokenInfo.symbol }) + `

${await getTranslation(ctx, 'trading.tokenInfo')}
- ${await getTranslation(ctx, 'trading.name')}: ${tokenInfo.name}
- ${await getTranslation(ctx, 'trading.symbol')}: ${tokenInfo.symbol}
- ${await getTranslation(ctx, 'trading.contract')}: \`${tokenInfo.address}\`

${await getTranslation(ctx, 'trading.yourBalance')} ${displayBalance} ${tokenInfo.symbol}
${await getTranslation(ctx, 'trading.tradingWalletBNB')} ${formatBNBBalance(bnbBalance)} BNB

${ownershipMessage}`;

		const keyboard = {
			inline_keyboard: [
				[
					{ text: await getTranslation(ctx, 'trading.switchToBuy'), callback_data: `switch_to_buy_${tokenInfo.address}` }
				],
				[
					{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '25' }), callback_data: `sell_percent_25_${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '50' }), callback_data: `sell_percent_50_${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '75' }), callback_data: `sell_percent_75_${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '100' }), callback_data: `sell_percent_100_${tokenInfo.address}` }
				],
				[
					{ text: await getTranslation(ctx, 'trading.customAmount'), callback_data: `sell_custom_${tokenInfo.address}` }
				],
				[
					{ text: await getTranslation(ctx, 'trading.dexScreener'), url: `https://dexscreener.com/bsc/${tokenInfo.address}` },
					{ text: await getTranslation(ctx, 'trading.refresh'), callback_data: `refresh_token_${tokenInfo.address}` }
				],
				[{ text: await getTranslation(ctx, 'trading.backToMenu'), callback_data: 'start_edit' }]
			]
		};

		// Check if we should edit or send new message
		if (ctx.callbackQuery?.message) {
			await ctx.editMessageText(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});
		} else {
			await ctx.reply(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});
		}
	}

	// Add missing handleTokenBuy method
	async handleTokenBuy(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();

		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.reply(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			if (!tokenInfo) {
				await ctx.reply(await getTranslation(ctx, 'trading.tokenNotFound'));
				return;
			}

			// Initialize trading session
			if (!session) {
				await ctx.reply(await getTranslation(ctx, 'trading.sessionNotFound'));
				return;
			}

			if (!session.trading) {
				session.trading = {};
			}

			session.trading.tokenAddress = tokenAddress;
			session.trading.tokenInfo = tokenInfo;
			session.trading.action = 'buy';
			session.trading.waitingForAmountInput = true;

			const keyboard = {
				inline_keyboard: [
					// Quick amounts
					[
						{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '0.1' }), callback_data: `quick_buy_0.1_${tokenAddress}` },
						{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '0.5' }), callback_data: `quick_buy_0.5_${tokenAddress}` },
						{ text: await getTranslation(ctx, 'trading.quickBuyBNB', { amount: '1' }), callback_data: `quick_buy_1_${tokenAddress}` }
					],
					[{ text: await getTranslation(ctx, 'trading.cancel'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			await ctx.reply(
				await getTranslation(ctx, 'trading.buyTitle', { symbol: tokenInfo.symbol }) + '\n\n' +
				await getTranslation(ctx, 'trading.enterBNBAmount'),
				{
					reply_markup: keyboard,
					parse_mode: 'Markdown'
				}
			);
		} catch (error) {
			logger.error('Error in handleTokenBuy', {
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorProcessingRequest'));
		}
	}

	// Add missing handleTokenSell method
	async handleTokenSell(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();

		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.reply(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			if (!tokenInfo || parseFloat(userBalance) === 0) {
				await ctx.reply(await getTranslation(ctx, 'trading.noTokenBalance'));
				return;
			}

			// Initialize trading session
			if (!session) {
				await ctx.reply(await getTranslation(ctx, 'trading.sessionNotFound'));
				return;
			}

			if (!session.trading) {
				session.trading = {};
			}

			session.trading.tokenAddress = tokenAddress;
			session.trading.tokenInfo = { ...tokenInfo, balance: userBalance };
			session.trading.action = 'sell';
			session.trading.waitingForAmountInput = true;
			session.trading.userBalance = userBalance;

			const keyboard = {
				inline_keyboard: [
					// Percentage buttons
					[
						{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '25' }), callback_data: `quick_sell_25_${tokenAddress}` },
						{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '50' }), callback_data: `quick_sell_50_${tokenAddress}` },
						{ text: await getTranslation(ctx, 'trading.quickSellPercent', { percent: '100' }), callback_data: `quick_sell_100_${tokenAddress}` }
					],
					[{ text: await getTranslation(ctx, 'trading.cancel'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			await ctx.reply(
				await getTranslation(ctx, 'trading.sellTitle', { symbol: tokenInfo.symbol }) + '\n\n' +
				await getTranslation(ctx, 'trading.enterSellAmount', {
					balance: formatNumber(parseFloat(userBalance)),
					symbol: tokenInfo.symbol
				}),
				{
					reply_markup: keyboard,
					parse_mode: 'Markdown'
				}
			);
		} catch (error) {
			logger.error('Error in handleTokenSell', {
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorProcessingSell'));
		}
	}

	async handleTokenInput(ctx: Context, tokenAddress: string) {
		if (!this.trader.isValidTokenAddress(tokenAddress)) {
			const errorMessage = await getTranslation(ctx, 'trading.invalidAddressFormat');
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply(errorMessage, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'buy_sell' }]
					]
				}
			});
			return;
		}

		// Clear waiting state
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (session?.trading) {
			session.trading.waitingForTokenInput = false;
		}

		// Use the auto-detection method
		await this.handleAutoDetectedToken(ctx, tokenAddress);
	}

	// Handle quick buy with specific BNB amounts
	async handleQuickBuy(ctx: Context, bnbAmount: string, tokenAddress: string) {
		const userId = ctx.from!.id;
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.answerCbQuery(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		await ctx.answerCbQuery();

		// Check if user has quick trade enabled
		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId: userId });
		const showConfirmation = user?.showTradeConfirmations ?? true;

		if (!showConfirmation) {
			// Quick trade mode - execute immediately
			await this.executeBuy(ctx, tokenAddress, bnbAmount);
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			if (!tokenInfo) {
				await ctx.reply(await getTranslation(ctx, 'trading.tokenNotFound'));
				return;
			}

			// Get quote using Smart Router (V2 + V3)
			const quote = await this.executor.getSwapQuote({
				tokenInAddress: 'BNB',
				tokenOutAddress: tokenAddress,
				amountIn: bnbAmount,
				slippage: 5
			});

			if (!quote) {
				await ctx.reply(await getTranslation(ctx, 'trading.unableToGetQuote'));
				return;
			}

			const message = await getTranslation(ctx, 'trading.buyTitle', { symbol: tokenInfo.symbol }) + `

${await getTranslation(ctx, 'trading.youPay')} ${bnbAmount} BNB
${await getTranslation(ctx, 'trading.youReceive')} ~${formatNumber(quote.amountOut)} ${tokenInfo.symbol}
${quote.route ? `Route: ${quote.route}` : ''}

${await getTranslation(ctx, 'trading.slippage')} 5%`;

			const keyboard = {
				inline_keyboard: [
					[{ text: await getTranslation(ctx, 'trading.confirmBuy'), callback_data: `confirm_buy_${tokenAddress}_${bnbAmount}` }],
					[{ text: await getTranslation(ctx, 'trading.cancel'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			await ctx.reply(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});

		} catch (error) {
			logger.error('Error in quick buy', {
				bnbAmount,
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorProcessingRequest'));
		}
	}

	// Handle quick sell with percentage amounts
	async handleQuickSell(ctx: Context, percentage: number, tokenAddress: string) {
		const userId = ctx.from!.id;
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.answerCbQuery(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		await ctx.answerCbQuery();

		// Check if user has quick trade enabled
		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId: userId });
		const showConfirmation = user?.showTradeConfirmations ?? true;

		if (!showConfirmation) {
			// Quick trade mode - execute immediately
			await this.executeSell(ctx, tokenAddress, percentage.toString());
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			if (!tokenInfo || parseFloat(userBalance) === 0) {
				await ctx.reply(await getTranslation(ctx, 'trading.noTokenBalance'));
				return;
			}

			const sellAmount = (parseFloat(userBalance) * percentage / 100).toString();

			// Get quote using Smart Router (V2 + V3)
			const quote = await this.executor.getSwapQuote({
				tokenInAddress: tokenAddress,
				tokenOutAddress: 'BNB',
				amountIn: sellAmount,
				slippage: 5
			});

			if (!quote) {
				await ctx.reply(await getTranslation(ctx, 'trading.unableToGetQuote'));
				return;
			}

			const message = await getTranslation(ctx, 'trading.sellTitle', { symbol: tokenInfo.symbol }) + `

${await getTranslation(ctx, 'trading.youSell')} ${formatNumber(sellAmount)} ${tokenInfo.symbol} (${percentage}%)
${await getTranslation(ctx, 'trading.youReceive')} ~${formatNumber(quote.amountOut)} BNB
${quote.route ? `Route: ${quote.route}` : ''}

${await getTranslation(ctx, 'trading.slippage')} 5%`;

			const keyboard = {
				inline_keyboard: [
					[{ text: await getTranslation(ctx, 'trading.confirmSell'), callback_data: `confirm_sell_${percentage}_${tokenAddress}` }],
					[{ text: await getTranslation(ctx, 'trading.cancel'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			await ctx.reply(message, {
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			});

		} catch (error) {
			logger.error('Error in quick sell', {
				percentage,
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorProcessingSell'));
		}
	}

	async handleAmountInput(ctx: Context, amount: string) {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		if (!session?.trading) {
			await ctx.reply(await getTranslation(ctx, 'trading.noActiveSession'));
			return;
		}

		const amountNum = parseFloat(amount);
		if (isNaN(amountNum) || amountNum <= 0) {
			await ctx.reply(await getTranslation(ctx, 'trading.invalidAmount'));
			return;
		}

		session.trading.amount = amount;
		session.trading.waitingForAmountInput = false;

		// Show confirmation based on action
		await this.showTradeConfirmation(ctx);
	}

	async showTradeConfirmation(ctx: Context) {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		if (!session?.trading?.tokenInfo || !session.trading.amount) {
			await ctx.reply(await getTranslation(ctx, 'trading.missingTradingInfo'));
			return;
		}

		const { tokenInfo, action, amount } = session.trading;
		const isBuy = action === 'buy';

		// Check if user has quick trade enabled
		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId: userId });
		const showConfirmation = user?.showTradeConfirmations ?? true;

		if (!showConfirmation) {
			// Quick trade mode - execute immediately
			if (isBuy) {
				await this.executeBuy(ctx, tokenInfo.address, amount);
			} else {
				// For sell, convert amount to percentage if needed
				// Since custom sell expects a percentage, we need to calculate it
				const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
				if (tradingWalletAddress) {
					const userBalance = await this.trader.getTokenBalance(tokenInfo.address, tradingWalletAddress);
					const percentage = (parseFloat(amount) / parseFloat(userBalance) * 100).toString();
					await this.executeSell(ctx, tokenInfo.address, percentage);
				}
			}
			return;
		}

		// Check price deviation for risk warning
		let deviationWarning = '';
		try {
			const deviationResult = await priceDeviationChecker.checkPriceDeviation(tokenInfo.address);
			if (deviationResult.hasDeviation) {
				deviationWarning = priceDeviationChecker.formatDeviationWarning(deviationResult);
				logger.warn('Price deviation detected', {
					tokenAddress: tokenInfo.address,
					deviationPercentage: deviationResult.deviationPercentage,
					riskLevel: deviationResult.riskLevel
				});
			}
		} catch (error) {
			logger.error('Error checking price deviation', { 
				error: error instanceof Error ? error.message : String(error) 
			});
		}

		const message = await getTranslation(ctx, isBuy ? 'trading.buyTitle' : 'trading.sellTitle', { symbol: tokenInfo.symbol }) + `

${await getTranslation(ctx, 'trading.amount')} ${amount} ${isBuy ? 'BNB' : tokenInfo.symbol}
${await getTranslation(ctx, 'trading.token')} ${tokenInfo.name}
${await getTranslation(ctx, 'trading.contract')}: \`${tokenInfo.address}\`
${deviationWarning}
${await getTranslation(ctx, 'trading.readyToExecute')}`;

		const keyboard = {
			inline_keyboard: [
				[{ text: await getTranslation(ctx, 'trading.confirmTrade'), callback_data: isBuy ? `confirm_buy_${tokenInfo.address}_${amount}` : `confirm_sell_${tokenInfo.address}_${amount}` }],
				[{ text: await getTranslation(ctx, 'trading.cancel'), callback_data: 'buy_sell' }]
			]
		};

		await ctx.reply(message, {
			reply_markup: keyboard,
			parse_mode: 'Markdown'
		});
	}

	async handleTradeConfirmation(ctx: Context) {
		await ctx.reply(
			await getTranslation(ctx, 'trading.tradeExecutionSoon'),
			{ parse_mode: 'Markdown' }
		);
	}

	async handleQuickAmount(ctx: Context, amount: string) {
		await this.handleAmountInput(ctx, amount);
	}

	async handlePercentageAmount(ctx: Context, percentage: number) {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		if (!session?.trading?.tokenInfo?.balance) {
			await ctx.reply(await getTranslation(ctx, 'trading.couldNotDetermineBalance'));
			return;
		}

		const balance = parseFloat(session.trading.tokenInfo.balance);
		const amount = (balance * percentage / 100).toString();

		await this.handleAmountInput(ctx, amount);
	}

	// Execute buy order using universal router contract (supports V2 and V3)
	async executeBuy(ctx: Context, tokenAddress: string, bnbAmount: string) {
		const userId = ctx.from!.id;
		let messageToUpdate: any;

		try {
			const processingMessage = await getTranslation(ctx, 'trading.processingBuyOrder');
			// Store message for later editing
			if (ctx.callbackQuery?.message) {
				messageToUpdate = await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
			} else {
				messageToUpdate = await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
			}

			// Check price deviation before executing buy
			try {
				const deviationResult = await priceDeviationChecker.checkPriceDeviation(tokenAddress);
				if (deviationResult.hasDeviation) {
					logger.info('Price deviation detected during buy', {
						tokenAddress,
						deviationPercentage: deviationResult.deviationPercentage,
						riskLevel: deviationResult.riskLevel,
						pythPrice: deviationResult.pythPrice,
						dexPrice: deviationResult.dexPrice
					});
				}
			} catch (error) {
				logger.error('Error checking price deviation during buy', { 
					error: error instanceof Error ? error.message : String(error),
					tokenAddress
				});
				// Continue with buy even if deviation check fails
			}

			// --- Universal Router Integration ---

			// 1. Get user's trading wallet signer
			const walletData = await UserService.getTradingWalletData(userId);
			if (!walletData?.encryptedPrivateKey || !walletData.iv) {
				throw new Error('Trading wallet not configured or private key is missing.');
			}

			const privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, walletData.iv);

			// Connect to BSC Mainnet
			const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
			const signer = new ethers.Wallet(privateKey, provider);

			// 2. Use PancakeSwap SDK to get the best trade and calldata
			const { SwapRouter } = await import('@pancakeswap/smart-router');
			const { Percent } = await import('@pancakeswap/sdk');

			// --- Enhanced error capturing and logging ---
			let trade, swapParams;
			try {
				trade = await this.executor.getBestTrade({
					tokenInAddress: 'BNB',
					tokenOutAddress: tokenAddress,
					amountIn: bnbAmount,
					slippage: 5 // Using a reasonable default slippage
				});

				logger.info('PancakeSwap SDK getBestTrade result', {
					userId,
					trade: trade ? 'Trade found' : 'No trade found',
					tokenAddress,
					bnbAmount
				});

				if (!trade) {
					throw new Error('Could not find a valid trade route. The token might have insufficient liquidity on PancakeSwap V2/V3.');
				}

				const slippageTolerance = new Percent(500, 10_000); // 5% slippage
				swapParams = SwapRouter.swapCallParameters(trade, {
					recipient: signer.address as `0x${string}`,
					slippageTolerance,
				});

				logger.info('PancakeSwap SDK swapCallParameters result', {
					userId,
					hasCalldata: !!swapParams?.calldata,
					calldataLength: swapParams?.calldata?.length || 0
				});

			} catch (sdkError: any) {
				logger.error('Error during PancakeSwap SDK processing', {
					userId,
					tokenAddress,
					bnbAmount,
					error: sdkError.message,
					stack: sdkError.stack
				});
				// Throw a more user-friendly error
				throw new Error(`Failed to get a trade quote from PancakeSwap. Reason: ${sdkError.message}`);
			}

			// --- Critical validation ---
			if (!swapParams || !swapParams.calldata || swapParams.calldata.length < 10) {
				logger.error('Invalid calldata generated', {
					userId,
					tokenAddress,
					bnbAmount,
					swapParams: !!swapParams,
					calldata: swapParams?.calldata?.substring(0, 10) || 'none',
					calldataLength: swapParams?.calldata?.length || 0
				});
				throw new Error('Generated empty or invalid calldata. This token may not be tradable.');
			}
			// --- Validation complete ---

			// --- Critical fix: Always use the PancakeSwap Smart Router address ---
			// The Smart Router SDK generates calldata specifically for the Smart Router contract,
			// NOT for individual V2 or V3 routers. The Smart Router knows how to parse this calldata
			// and internally route through V2, V3, or mixed paths.

			logger.info('Preparing universal router transaction', {
				userId,
				routerAddress: this.PANCAKESWAP_SMART_ROUTER_ADDRESS,
				protocol: trade.routes?.[0]?.protocol || 'unknown',
				routes: trade.routes?.length || 0
			});

			// 3. Generate EIP-712 signature for the swap
			const { signature, deadline } = await signatureService.generateSwapSignature(
				signer.address,
				this.PANCAKESWAP_SMART_ROUTER_ADDRESS,
				swapParams.calldata as string,
				20 // 20 minutes deadline
			);

			logger.info('Generated swap signature', {
				userId,
				userAddress: signer.address,
				deadline
			});

			// 4. Create secure router contract instance
			const secureRouter = new ethers.Contract(
				this.SECURE_ROUTER_ADDRESS,
				SecureBeanBeeRouterABI,
				signer
			);

			// 5. Execute swap through secure router with signature parameters
			// The secure router will validate the signature and forward the call to the whitelisted PancakeSwap Smart Router
			const tx = await secureRouter.executeSwap(
				this.PANCAKESWAP_SMART_ROUTER_ADDRESS,    // Parameter 1: router (whitelisted Smart Router)
				swapParams.calldata as `0x${string}`,    // Parameter 2: calldata
				deadline,                                 // Parameter 3: deadline
				signature,                                // Parameter 4: signature
				{
					value: ethers.parseEther(bnbAmount), // BNB to send
					gasLimit: 800000, // Increased gas limit for complex V3 trades
				}
			);

			logger.info(`Transaction sent via secure router: ${tx.hash}`);
			const receipt = await tx.wait();

			if (receipt && receipt.status === 1) {
				const tokenInfo = await this.trader.getTokenInfo(tokenAddress);

				// Invalidate DeFi cache after successful trade
				const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
				if (tradingWalletAddress) {
					await this.invalidateDeFiCache(userId, tradingWalletAddress);
				}

				const successMessage = `✅ Buy order executed!\n\n` +
					`Token: ${tokenInfo?.symbol || 'Unknown'}\n` +
					`Amount: ${bnbAmount} BNB\n` +
					`Expected Output: ~${trade.outputAmount.toExact()} ${tokenInfo?.symbol || 'tokens'}\n` +
					`Tx: [View on BscScan](https://bscscan.com/tx/${receipt.hash})`;

				const keyboard = {
					inline_keyboard: [
						[{ text: await getTranslation(ctx, 'trading.refreshTokenInfo'), callback_data: `refresh_token_${tokenAddress}` }],
						[{ text: await getTranslation(ctx, 'trading.backToMenu'), callback_data: 'start_edit' }]
					]
				};

				await ctx.telegram.editMessageText(
					ctx.chat!.id,
					messageToUpdate.message_id,
					undefined,
					successMessage,
					{
						parse_mode: 'Markdown',
						reply_markup: keyboard
					}
				);

			} else {
				throw new Error('Transaction failed on-chain (reverted)');
			}

		} catch (error: any) {
			logger.error('Custom contract buy execution error', {
				userId,
				tokenAddress,
				bnbAmount,
				error: error.message,
				stack: error.stack
			});

			// Provide more user-friendly error messages
			let userFriendlyError = error.message || 'Transaction failed';

			// Check for specific error patterns and provide clearer messages
			if (error.message?.includes('Failed to get a trade quote')) {
				userFriendlyError = 'Unable to find a trading route. The token might have insufficient liquidity.';
			} else if (error.message?.includes('invalid calldata')) {
				userFriendlyError = 'Unable to generate valid transaction data. This token may not be tradable on PancakeSwap.';
			} else if (error.message?.includes('insufficient funds')) {
				userFriendlyError = 'Insufficient BNB balance to complete the transaction.';
			} else if (error.message?.includes('gas')) {
				userFriendlyError = 'Not enough BNB to cover gas fees.';
			} else if (error.message?.includes('reverted')) {
				userFriendlyError = 'Transaction was reverted. Price may have moved too much.';
			}

			const errorMessage = `❌ Buy order failed\n\n${userFriendlyError}\n\n💡 You can try:\n• Adjusting the amount\n• Checking token liquidity on DexScreener\n• Trading manually on PancakeSwap`;

			const swapUrl = `https://pancakeswap.finance/swap?outputCurrency=${tokenAddress}&inputCurrency=BNB`;
			const keyboard = {
				inline_keyboard: [
					[{ text: '🥞 Open PancakeSwap', url: swapUrl }],
					[{ text: await getTranslation(ctx, 'trading.back'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			// Edit the message if it exists, otherwise send a new one
			if (messageToUpdate) {
				await ctx.telegram.editMessageText(
					ctx.chat!.id,
					messageToUpdate.message_id,
					undefined,
					errorMessage,
					{
						reply_markup: keyboard,
						parse_mode: 'Markdown'
					}
				);
			} else {
				await ctx.reply(errorMessage, {
					reply_markup: keyboard,
					parse_mode: 'Markdown'
				});
			}
		}
	}

	// Original executeBuy method (renamed for backup/reference)
	async executeBuyOriginal(ctx: Context, tokenAddress: string, bnbAmount: string) {
		const userId = ctx.from!.id;

		try {
			// Show processing message
			const processingMessage = await getTranslation(ctx, 'trading.processingBuyOrder');

			// Check if we can edit the message (from callback) or need to send a new one (from text input)
			if (ctx.callbackQuery) {
				await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
			} else {
				await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
			}

			// Execute the swap
			const result = await this.executor.executeSwap(userId, {
				tokenInAddress: 'BNB',
				tokenOutAddress: tokenAddress,
				amountIn: bnbAmount,
				slippage: 20
			});

			if (result.success && result.txHash) {
				// Get token info for display
				const tokenInfo = await this.trader.getTokenInfo(tokenAddress);

				// Invalidate DeFi cache after successful trade
				const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
				if (tradingWalletAddress) {
					await this.invalidateDeFiCache(userId, tradingWalletAddress);
				}

				// Always show success confirmation regardless of quick trade setting
				const successMessage = await getTranslation(ctx, 'trading.buyOrderExecuted', {
					symbol: tokenInfo?.symbol || 'Unknown',
					amount: bnbAmount,
					tokensReceived: result.tokensReceived || '0',
					txHash: result.txHash
				});

				const keyboard = {
					inline_keyboard: [
						[{ text: await getTranslation(ctx, 'trading.refreshTokenInfo'), callback_data: `refresh_token_${tokenAddress}` }],
						[{ text: await getTranslation(ctx, 'trading.backToMenu'), callback_data: 'start_edit' }]
					]
				};

				if (ctx.callbackQuery) {
					await ctx.editMessageText(successMessage, {
						parse_mode: 'Markdown',
						reply_markup: keyboard
					});
				} else {
					await ctx.reply(successMessage, {
						parse_mode: 'Markdown',
						reply_markup: keyboard
					});
				}
			} else {
				// Handle specific error types with user-friendly messages
				let userFriendlyError = 'Transaction failed';
				const originalError = result.error || 'Unknown error';

				if (originalError.includes('exceeds the balance')) {
					userFriendlyError = 'Insufficient BNB balance for transaction fees';
				} else if (originalError.includes('slippage')) {
					userFriendlyError = 'Price moved too much during transaction';
				} else if (originalError.includes('gas')) {
					userFriendlyError = 'Not enough BNB to cover gas fees';
				} else if (originalError.includes('insufficient')) {
					userFriendlyError = 'Insufficient balance';
				}

				const swapUrl = `https://pancakeswap.finance/swap?outputCurrency=${tokenAddress}&inputCurrency=BNB`;
				const errorMessage = `❌ Buy order failed\n\n${userFriendlyError}\n\n💡 Try trading manually on PancakeSwap`;

				const keyboard = {
					inline_keyboard: [
						[{ text: '🥞 Open PancakeSwap', url: swapUrl }],
						[{ text: await getTranslation(ctx, 'trading.back'), callback_data: `refresh_token_${tokenAddress}` }]
					]
				};

				if (ctx.callbackQuery) {
					await ctx.editMessageText(errorMessage, {
						reply_markup: keyboard
					});
				} else {
					await ctx.reply(errorMessage, {
						reply_markup: keyboard
					});
				}
			}
		} catch (error: any) {
			logger.error('Buy execution error', {
				tokenAddress,
				bnbAmount,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});

			// Handle specific error types with user-friendly messages
			let userFriendlyError = 'Something went wrong';
			const originalError = error.message || 'Unknown error';

			if (originalError.includes('parse entities') || originalError.includes('Bad Request')) {
				userFriendlyError = 'Transaction processing error';
			} else if (originalError.includes('exceeds the balance')) {
				userFriendlyError = 'Insufficient BNB balance for transaction fees';
			} else if (originalError.includes('gas')) {
				userFriendlyError = 'Not enough BNB to cover gas fees';
			} else if (originalError.includes('insufficient')) {
				userFriendlyError = 'Insufficient balance';
			}

			const swapUrl = `https://pancakeswap.finance/swap?outputCurrency=${tokenAddress}&inputCurrency=BNB`;
			const errorMessage = `❌ Buy order failed\n\n${userFriendlyError}\n\n💡 Try trading manually on PancakeSwap`;

			const keyboard = {
				inline_keyboard: [
					[{ text: '🥞 Open PancakeSwap', url: swapUrl }],
					[{ text: '🔙 Back', callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			if (ctx.callbackQuery) {
				await ctx.editMessageText(errorMessage, {
					reply_markup: keyboard
				});
			} else {
				await ctx.reply(errorMessage, {
					reply_markup: keyboard
				});
			}
		}
	}

	// Execute sell order using universal router (supports V2 and V3)
	async executeSell(ctx: Context, tokenAddress: string, percentage: string) {
		const userId = ctx.from!.id;
		let messageToUpdate: any;

		try {
			// Get trading wallet address and token balance
			const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
			if (!tradingWalletAddress) {
				await ctx.reply(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
				return;
			}

			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			if (!tokenInfo) {
				throw new Error('Token not found');
			}

			// Check price deviation before executing sell
			try {
				const deviationResult = await priceDeviationChecker.checkPriceDeviation(tokenAddress);
				if (deviationResult.hasDeviation) {
					logger.info('Price deviation detected during sell', {
						tokenAddress,
						deviationPercentage: deviationResult.deviationPercentage,
						riskLevel: deviationResult.riskLevel,
						pythPrice: deviationResult.pythPrice,
						dexPrice: deviationResult.dexPrice
					});
				}
			} catch (error) {
				logger.error('Error checking price deviation during sell', { 
					error: error instanceof Error ? error.message : String(error),
					tokenAddress
				});
				// Continue with sell even if deviation check fails
			}

			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			// Calculate sell amount based on percentage
			let sellAmount: string;
			let rawSellAmount: bigint;
			const tokenDecimals = tokenInfo.decimals || 18;

			// Convert user balance to raw units for precise calculation
			const rawBalance = ethers.parseUnits(userBalance, tokenDecimals);

			if (percentage === '100') {
				// For 100% sell, use the exact balance
				rawSellAmount = rawBalance;
				sellAmount = userBalance; // Use the original balance string
			} else {
				// Calculate percentage of balance
				rawSellAmount = (rawBalance * BigInt(Math.floor(parseFloat(percentage)))) / 100n;
				sellAmount = ethers.formatUnits(rawSellAmount, tokenDecimals);
			}

			// Show processing message
			const processingMessage = await getTranslation(ctx, 'trading.processingSellOrder');

			if (ctx.callbackQuery) {
				messageToUpdate = await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
			} else {
				messageToUpdate = await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
			}

			// --- Universal Router Integration for Sell ---

			// 1. Get user's trading wallet signer
			const walletData = await UserService.getTradingWalletData(userId);
			if (!walletData?.encryptedPrivateKey || !walletData.iv) {
				throw new Error('Trading wallet not configured or private key is missing.');
			}

			const privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, walletData.iv);
			const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
			const signer = new ethers.Wallet(privateKey, provider);

			// 2. Use PancakeSwap SDK to get the best trade and calldata
			const { SwapRouter } = await import('@pancakeswap/smart-router');
			const { Percent } = await import('@pancakeswap/sdk');

			// Get the best trade using the executor's getBestTrade method
			const trade = await this.executor.getBestTrade({
				tokenInAddress: tokenAddress,
				tokenOutAddress: 'BNB',
				amountIn: sellAmount,
				slippage: 5
			});

			if (!trade) {
				throw new Error('Could not find a valid trade route');
			}

			// Generate calldata for the swap
			// Increased slippage tolerance from 0.5% to 5% for better transaction success
			const slippageTolerance = new Percent(500, 10_000); // 5% slippage
			const swapParams = SwapRouter.swapCallParameters(trade, {
				recipient: signer.address as `0x${string}`, // Important: BNB goes to the user's wallet
				slippageTolerance,
			});

			// --- Critical fix: Always use the PancakeSwap Smart Router address ---
			// Same as in executeBuy - the SDK's calldata is meant for the Smart Router

			logger.info('Preparing sell transaction via universal router', {
				userId,
				routerAddress: this.PANCAKESWAP_SMART_ROUTER_ADDRESS,
				protocol: trade.routes?.[0]?.protocol || 'unknown',
				percentage,
				sellAmount
			});

			// 3. Generate EIP-712 signature for the token swap
			const { signature, deadline } = await signatureService.generateTokenSwapSignature(
				signer.address,
				tokenAddress,
				this.PANCAKESWAP_SMART_ROUTER_ADDRESS,
				rawSellAmount.toString(),
				swapParams.calldata as string,
				20 // 20 minutes deadline
			);

			logger.info('Generated token swap signature', {
				userId,
				userAddress: signer.address,
				tokenAddress,
				amount: rawSellAmount.toString(),
				deadline
			});

			// 4. Approve token spending for the secure router if needed
			const tokenContract = new ethers.Contract(
				tokenAddress,
				['function approve(address spender, uint256 amount) returns (bool)'],
				signer
			);

			// Approve the secure router to spend tokens (use rawSellAmount which is already in wei)
			const approveTx = await tokenContract.approve(this.SECURE_ROUTER_ADDRESS, rawSellAmount);
			await approveTx.wait();
			logger.info('Token approval completed for secure router');

			// 5. Create secure router contract instance
			const secureRouter = new ethers.Contract(
				this.SECURE_ROUTER_ADDRESS,
				SecureBeanBeeRouterABI,
				signer
			);

			// 6. Execute swap through secure router with signature parameters
			// Note: The new SecureBeanBeeRouter requires signature verification
			const tx = await secureRouter.executeTokenSwap(
				tokenAddress,                             // Parameter 1: token
				this.PANCAKESWAP_SMART_ROUTER_ADDRESS,   // Parameter 2: router (whitelisted Smart Router)
				rawSellAmount,                            // Parameter 3: amount (in wei)
				swapParams.calldata as `0x${string}`,    // Parameter 4: calldata
				deadline,                                 // Parameter 5: deadline
				signature,                                // Parameter 6: signature
				{
					gasLimit: 800000, // Increased gas limit for complex V3 trades
				}
			);

			logger.info(`Sell transaction sent via secure router: ${tx.hash}`);
			const receipt = await tx.wait();

			if (receipt && receipt.status === 1) {
				// Invalidate DeFi cache after successful trade
				if (tradingWalletAddress) {
					await this.invalidateDeFiCache(userId, tradingWalletAddress);
				}

				// Always show success confirmation regardless of quick trade setting
				const successMessage = `✅ Sell order executed!\n\n` +
					`Token: ${tokenInfo?.symbol || 'Unknown'}\n` +
					`Amount: ${formatNumber(sellAmount)} ${tokenInfo?.symbol} (${percentage}%)\n` +
					`Expected Output: ~${trade.outputAmount.toExact()} BNB\n` +
					`Tx: [View on BscScan](https://bscscan.com/tx/${receipt.hash})`;

				const keyboard = {
					inline_keyboard: [
						[{ text: await getTranslation(ctx, 'trading.refreshTokenInfo'), callback_data: `refresh_token_${tokenAddress}` }],
						[{ text: await getTranslation(ctx, 'trading.backToMenu'), callback_data: 'start_edit' }]
					]
				};

				await ctx.telegram.editMessageText(
					ctx.chat!.id,
					messageToUpdate.message_id,
					undefined,
					successMessage,
					{
						parse_mode: 'Markdown',
						reply_markup: keyboard
					}
				);
			} else {
				throw new Error('Transaction failed on-chain (reverted)');
			}
		} catch (error: any) {
			logger.error('Sell execution error via secure router', {
				tokenAddress,
				percentage,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});

			const errorMessage = `❌ Sell order failed via secure router.\n\nReason: ${error.reason || error.message}`;

			const keyboard = {
				inline_keyboard: [
					[{ text: await getTranslation(ctx, 'trading.back'), callback_data: `refresh_token_${tokenAddress}` }]
				]
			};

			// Edit the message if it exists, otherwise send a new one
			if (messageToUpdate) {
				await ctx.telegram.editMessageText(
					ctx.chat!.id,
					messageToUpdate.message_id,
					undefined,
					errorMessage,
					{ reply_markup: keyboard }
				);
			} else {
				await ctx.reply(errorMessage, { reply_markup: keyboard });
			}
		}
	}

	// Handle switch to buy menu
	async handleSwitchToBuy(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();
		const userId = ctx.from!.id;
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.reply(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			if (tokenInfo) {
				await this.showBuyMenu(ctx, tokenInfo, tradingWalletAddress, userBalance);
			}
		} catch (error) {
			logger.error('Error switching to buy menu', {
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorLoadingToken'));
		}
	}

	// Handle switch to sell menu
	async handleSwitchToSell(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();
		const userId = ctx.from!.id;
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

		if (!tradingWalletAddress) {
			await ctx.reply(await getTranslation(ctx, 'trading.tradingWalletNotFound'));
			return;
		}

		try {
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			// Check if user actually has balance
			if (parseFloat(userBalance) === 0) {
				await ctx.answerCbQuery(await getTranslation(ctx, 'trading.dontOwnToken'));
				return;
			}

			if (tokenInfo) {
				await this.showSellMenu(ctx, tokenInfo, userBalance, tradingWalletAddress);
			}
		} catch (error) {
			logger.error('Error switching to sell menu', {
				tokenAddress,
				userId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			await ctx.reply(await getTranslation(ctx, 'trading.errorLoadingToken'));
		}
	}

	// Handle buy with specific amount
	async handleBuyAmount(ctx: Context, bnbAmount: string, tokenAddress: string) {
		await ctx.answerCbQuery();
		await this.handleQuickBuy(ctx, bnbAmount, tokenAddress);
	}

	// Handle sell with specific percentage
	async handleSellPercentage(ctx: Context, percentage: string, tokenAddress: string) {
		await ctx.answerCbQuery();
		await this.handleQuickSell(ctx, parseInt(percentage), tokenAddress);
	}

	// Handle custom buy amount input
	async handleCustomBuy(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		if (!session) {
			await ctx.reply(await getTranslation(ctx, 'trading.sessionNotFound'));
			return;
		}

		if (!session.trading) {
			session.trading = {};
		}

		session.trading.waitingForAmountInput = true;
		session.trading.action = 'buy';
		session.trading.tokenAddress = tokenAddress;

		await ctx.reply(
			await getTranslation(ctx, 'trading.enterCustomBNB'),
			{ parse_mode: 'Markdown' }
		);
	}

	// Handle custom sell amount input
	async handleCustomSell(ctx: Context, tokenAddress: string) {
		await ctx.answerCbQuery();
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);

		if (!session) {
			await ctx.reply(await getTranslation(ctx, 'trading.sessionNotFound'));
			return;
		}

		if (!session.trading) {
			session.trading = {};
		}

		const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
		session.trading.waitingForAmountInput = true;
		session.trading.action = 'sell';
		session.trading.tokenAddress = tokenAddress;

		await ctx.reply(
			await getTranslation(ctx, 'trading.enterCustomSell', { symbol: tokenInfo?.symbol || 'tokens' }),
			{ parse_mode: 'Markdown' }
		);
	}

	/**
	 * Execute automated buy order for auto-trading
	 */
	async executeAutoBuy(userId: number, tokenAddress: string, bnbAmount: string): Promise<{ success: boolean; error?: string; balance?: string; required?: string; attempt?: number; txHash?: string; tokensReceived?: string }> {
		try {
			logger.info('Executing auto-buy order', { userId, tokenAddress, bnbAmount });

			// Get user's trading wallet
			const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
			if (!tradingWalletAddress) {
				logger.error('No trading wallet found for auto-buy', { userId });
				return { success: false, error: 'No trading wallet found. Please create a trading wallet first.' };
			}

			// Check trading wallet balance
			const balance = await getBNBBalance(tradingWalletAddress);
			const balanceNum = parseFloat(balance);
			const requiredAmount = parseFloat(bnbAmount);

			if (balanceNum < requiredAmount) {
				logger.error('Insufficient balance for auto-buy', {
					userId,
					balance: balanceNum,
					required: requiredAmount
				});
				return {
					success: false,
					error: 'Insufficient trading wallet balance',
					balance: balance,
					required: bnbAmount
				};
			}

			// Get token info
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			if (!tokenInfo) {
				logger.error('Could not get token info for auto-buy', { userId, tokenAddress });
				return { success: false, error: 'Could not get token information' };
			}

			// Execute the buy order with retry logic (max 2 attempts)
			const maxRetries = 2;
			let lastError = '';

			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				logger.info(`Auto-buy attempt ${attempt}/${maxRetries}`, { userId, tokenAddress, bnbAmount });

				const result = await this.executor.executeSwap(userId, {
					tokenInAddress: 'BNB',
					tokenOutAddress: tokenAddress,
					amountIn: bnbAmount,
					slippage: 20
				});

				if (result.success && result.txHash) {
					// Invalidate DeFi cache to refresh balances
					await this.invalidateDeFiCache(userId, tradingWalletAddress);
					logger.info('Auto-buy order executed successfully', {
						userId,
						tokenAddress,
						bnbAmount,
						txHash: result.txHash,
						attempt
					});
					return { success: true, attempt, txHash: result.txHash, tokensReceived: result.tokensReceived };
				} else {
					lastError = result.error || 'Swap execution failed';
					logger.error(`Auto-buy attempt ${attempt} failed`, {
						userId,
						tokenAddress,
						bnbAmount,
						error: lastError,
						txHash: result.txHash
					});

					// If this was the last attempt, don't retry
					if (attempt === maxRetries) {
						break;
					}

					// Wait 5 seconds before retrying (to avoid rate limiting and allow blockchain state to settle)
					logger.info(`Waiting 5 seconds before retry attempt ${attempt + 1}`, { userId, tokenAddress });
					await new Promise(resolve => setTimeout(resolve, 5000));
				}
			}

			logger.error('Auto-buy order failed after all retry attempts', {
				userId, tokenAddress, bnbAmount, maxRetries, lastError
			});
			return { success: false, error: `Transaction failed after ${maxRetries} attempts: ${lastError}` };

		} catch (error) {
			logger.error('Error in executeAutoBuy', {
				error: error instanceof Error ? error.message : String(error),
				userId,
				tokenAddress,
				bnbAmount
			});
			return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' };
		}
	}

	/**
	 * Execute automated sell order for auto-trading
	 */
	async executeAutoSell(userId: number, tokenAddress: string, percentage: number): Promise<{ success: boolean; txHash?: string; tokensReceived?: string }> {
		try {
			logger.info('Executing auto-sell order', { userId, tokenAddress, percentage });

			// Get user's trading wallet
			const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
			if (!tradingWalletAddress) {
				logger.error('No trading wallet found for auto-sell', { userId });
				return { success: false };
			}

			// Get token info
			const tokenInfo = await this.trader.getTokenInfo(tokenAddress);
			if (!tokenInfo) {
				logger.error('Could not get token info for auto-sell', { userId, tokenAddress });
				return { success: false };
			}

			// Get user's token balance to calculate sell amount
			const userBalance = await this.trader.getTokenBalance(tokenAddress, tradingWalletAddress);

			// For 100% sell, get exact balance to avoid precision issues
			let sellAmount: string;
			if (percentage === 100) {
				// Get the raw balance to avoid formatting precision loss
				const { getTradingWallet } = await import('../wallet/tradingWallet');
				const walletData = await UserService.getTradingWalletData(userId);
				if (!walletData) {
					logger.error('No trading wallet data found for auto-sell', { userId });
					return { success: false };
				}

				const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
				const wallet = getTradingWallet(walletData.encryptedPrivateKey, walletData.iv, provider);
				const tokenContract = new ethers.Contract(tokenAddress, [
					'function balanceOf(address) view returns (uint256)',
					'function decimals() view returns (uint8)'
				], provider);
				const [rawBalance, decimals] = await Promise.all([
					tokenContract.balanceOf(wallet.address),
					tokenContract.decimals()
				]);
				sellAmount = ethers.formatUnits(rawBalance, decimals);
			} else {
				sellAmount = (parseFloat(userBalance) * percentage / 100).toString();
			}

			// Execute the sell order with retry logic (max 2 attempts)
			const maxRetries = 2;
			let lastError = '';

			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				logger.info(`Auto-sell attempt ${attempt}/${maxRetries}`, { userId, tokenAddress, percentage, sellAmount });

				const result = await this.executor.executeSwap(userId, {
					tokenInAddress: tokenAddress,
					tokenOutAddress: 'BNB',
					amountIn: sellAmount,
					slippage: 20
				});

				if (result.success && result.txHash) {
					// Invalidate DeFi cache to refresh balances
					await this.invalidateDeFiCache(userId, tradingWalletAddress);
					logger.info('Auto-sell order executed successfully', {
						userId,
						tokenAddress,
						percentage,
						sellAmount,
						txHash: result.txHash,
						attempt
					});
					return { success: true, txHash: result.txHash, tokensReceived: result.tokensReceived };
				} else {
					lastError = result.error || 'Swap execution failed';
					logger.error(`Auto-sell attempt ${attempt} failed`, {
						userId,
						tokenAddress,
						percentage,
						sellAmount,
						error: lastError,
						txHash: result.txHash
					});

					// If this was the last attempt, don't retry
					if (attempt === maxRetries) {
						break;
					}

					// Wait 5 seconds before retrying
					logger.info(`Waiting 5 seconds before retry attempt ${attempt + 1}`, { userId, tokenAddress });
					await new Promise(resolve => setTimeout(resolve, 5000));
				}
			}

			logger.error('Auto-sell order failed after all retry attempts', {
				userId, tokenAddress, percentage, sellAmount, maxRetries, lastError
			});
			return { success: false };

		} catch (error) {
			logger.error('Error in executeAutoSell', {
				error: error instanceof Error ? error.message : String(error),
				userId,
				tokenAddress,
				percentage
			});
			return { success: false };
		}
	}
}