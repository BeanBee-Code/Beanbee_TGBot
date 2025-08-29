import { Context, Markup } from 'telegraf';
import { WalletWatchModel } from '@/database/models/WalletWatch';
import { createLogger } from '@/utils/logger';
import { ethers } from 'ethers';
import { getTranslation } from '@/i18n';

const logger = createLogger('services.walletTracking');

export class WalletTrackingService {
	static async showTrackingMenu(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			// Get user's tracked wallets
			const trackedWallets = await WalletWatchModel.find({ 
				telegramId: userId, 
				isActive: true 
			}).sort({ createdAt: -1 });

			let message = '🔍 **Wallet Tracking**\n\n';
			
			if (trackedWallets.length === 0) {
				message += 'You are not tracking any wallets yet.\n\n';
				message += 'Click "Add Wallet" to start tracking a wallet address. You will receive notifications whenever that wallet makes transactions.';
			} else {
				message += `You are tracking ${trackedWallets.length} wallet(s):\n\n`;
				
				for (const wallet of trackedWallets.slice(0, 5)) { // Show up to 5 wallets
					const shortAddress = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
					const alias = wallet.alias ? ` (${wallet.alias})` : '';
					message += `• \`${wallet.walletAddress}\`${alias}\n`;
					message += `  └ Transactions detected: ${wallet.transactionCount}\n`;
				}
				
				if (trackedWallets.length > 5) {
					message += `\n_...and ${trackedWallets.length - 5} more_\n`;
				}
			}

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('➕ Add Wallet', 'add_tracked_wallet'),
						...(trackedWallets.length > 0 ? [Markup.button.callback('📋 Manage', 'manage_tracked_wallets')] : [])
					],
					[Markup.button.callback('🔙 Back to Main Menu', 'start')]
				]
			};

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error) {
			logger.error('Error showing tracking menu', { error, userId });
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply('❌ Error loading wallet tracking menu', {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'start_edit' }]
					]
				}
			});
		}
	}

	static async handleAddWallet(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			// Set session state for waiting for wallet address
			let session = global.userSessions.get(userId);
			if (!session) {
				// Initialize a basic session if none exists
				const { WalletService } = await import('./wallet/connect');
				const walletService = new WalletService(global.userSessions);
				await walletService.initializeConnection(userId);
				session = global.userSessions.get(userId);
			}
			
			if (session) {
				// Clear all other waiting states to avoid conflicts
				delete session.waitingForWalletInput;
				delete session.waitingForTokenAddress;
				delete session.waitingForTokenSearchInput;
				if (session.trading) {
					delete session.trading.waitingForTokenInput;
					delete session.trading.waitingForAmountInput;
				}
				if (session.rugAlerts) {
					delete session.rugAlerts.waitingForTokenInput;
				}
				if (session.transfer) {
					delete session.transfer.waitingForAmountInput;
				}
				if (session.autoTradeSetup) {
					delete session.autoTradeSetup.waitingForInput;
				}
				
				// Set the correct waiting state
				session.waitingForWalletAddress = true;
				global.userSessions.set(userId, session);
			}

			const message = '🔍 **Add Wallet to Track**\n\n' +
				'Please send me the wallet address you want to track.\n\n' +
				'The address should be a valid BSC (BEP-20) wallet address starting with "0x".\n\n' +
				'Example: `0x1234567890123456789012345678901234567890`';

			const keyboard = {
				inline_keyboard: [
					[Markup.button.callback('❌ Cancel', 'track_wallet')]
				]
			};

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error) {
			logger.error('Error handling add wallet', { error, userId });
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply('❌ Error setting up wallet tracking', {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'track_wallet' }]
					]
				}
			});
		}
	}

	static async handleWalletAddressInput(ctx: Context, address: string): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Clear waiting state immediately since we received input
		const session = global.userSessions.get(userId);
		if (session) {
			session.waitingForWalletAddress = false;
			global.userSessions.set(userId, session);
		}

		try {
			// Validate address
			if (!ethers.isAddress(address)) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('❌ Invalid wallet address. Please provide a valid BSC address starting with "0x".', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_wallet' }]
						]
					}
				});
				return;
			}

			// Check if already tracking this address
			const existingWatch = await WalletWatchModel.findOne({
				telegramId: userId,
				walletAddress: address.toLowerCase(),
				isActive: true
			});

			if (existingWatch) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('⚠️ You are already tracking this wallet address.', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_wallet' }]
						]
					}
				});
				return;
			}

			// Check tracking limit (max 10 wallets per user)
			const userWatchCount = await WalletWatchModel.countDocuments({
				telegramId: userId,
				isActive: true
			});

			if (userWatchCount >= 10) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('❌ You can track a maximum of 10 wallets. Please remove some wallets first.', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_wallet' }]
						]
					}
				});
				return;
			}

			// Create new watch entry
			const newWatch = new WalletWatchModel({
				telegramId: userId,
				walletAddress: address.toLowerCase(),
				isActive: true,
				transactionCount: 0
			});

			await newWatch.save();

			const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
			const message = `✅ **Wallet Added Successfully!**\n\n` +
				`Now tracking: \`${address}\`\n\n` +
				`You will receive notifications whenever this wallet makes transactions on BSC.`;

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('➕ Add Another', 'add_tracked_wallet'),
						Markup.button.callback('📋 View All', 'track_wallet')
					],
					[Markup.button.callback('🔙 Back to Main Menu', 'start')]
				]
			};

			await ctx.reply(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});

			// Initialize monitoring for this wallet
			await this.initializeWalletMonitoring(address.toLowerCase());

		} catch (error) {
			logger.error('Error handling wallet address input', { error, userId, address });
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply('❌ Error adding wallet to tracking list', {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'track_wallet' }]
					]
				}
			});
		}
	}

	static async handleManageWallets(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const trackedWallets = await WalletWatchModel.find({ 
				telegramId: userId, 
				isActive: true 
			}).sort({ createdAt: -1 });

			if (trackedWallets.length === 0) {
				await this.showTrackingMenu(ctx);
				return;
			}

			let message = '📋 **Manage Tracked Wallets**\n\n';
			message += 'Select a wallet to manage:\n\n';

			const buttons = [];
			for (const wallet of trackedWallets.slice(0, 8)) { // Show up to 8 wallets
				const shortAddress = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
				const alias = wallet.alias ? ` (${wallet.alias})` : '';
				buttons.push([Markup.button.callback(
					`${shortAddress}${alias} - ${wallet.transactionCount} txns`,
					`manage_wallet_${wallet._id}`
				)]);
			}

			buttons.push([Markup.button.callback('🔙 Back', 'track_wallet')]);

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: { inline_keyboard: buttons }
			});
		} catch (error) {
			logger.error('Error handling manage wallets', { error, userId });
			await ctx.reply('❌ Error loading wallet management menu');
		}
	}

	static async initializeWalletMonitoring(walletAddress: string): Promise<void> {
		try {
			logger.info('Initializing monitoring for wallet', { walletAddress });
			
			// Add wallet to WebSocket monitoring
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			await monitor.addWalletToTracking(walletAddress);
			
			logger.info('Successfully added wallet to monitoring', { walletAddress });
		} catch (error) {
			logger.error('Error initializing wallet monitoring', { error, walletAddress });
		}
	}

	static async getTrackedWallets(): Promise<string[]> {
		try {
			const trackedWallets = await WalletWatchModel.find({ 
				isActive: true 
			}).distinct('walletAddress');
			
			return trackedWallets;
		} catch (error) {
			logger.error('Error getting tracked wallets', { error });
			return [];
		}
	}

	static async notifyWalletTransaction(walletAddress: string, transaction: any): Promise<void> {
		try {
			logger.info('🔔 Looking for watchers for wallet transaction', { 
				walletAddress: walletAddress.toLowerCase(),
				txHash: transaction.hash 
			});

			const watchers = await WalletWatchModel.find({
				walletAddress: walletAddress.toLowerCase(),
				isActive: true
			});

			logger.info('📋 Found watchers for wallet', { 
				walletAddress: walletAddress.toLowerCase(),
				watcherCount: watchers.length,
				watchers: watchers.map(w => ({ telegramId: w.telegramId, alias: w.alias }))
			});

			if (watchers.length === 0) {
				logger.warn('⚠️ No active watchers found for wallet', { walletAddress: walletAddress.toLowerCase() });
				return;
			}

			for (const watcher of watchers) {
				logger.info('📤 Sending notification to user', { 
					telegramId: watcher.telegramId,
					walletAddress: walletAddress.toLowerCase(),
					txHash: transaction.hash
				});

				// Increment transaction count
				watcher.transactionCount++;
				watcher.lastNotified = new Date();
				await watcher.save();

				// Send notification to user
				await this.sendTransactionNotification(watcher.telegramId, walletAddress, transaction);
			}
		} catch (error) {
			logger.error('Error notifying wallet transaction', { error, walletAddress });
		}
	}

	static async removeWalletFromTracking(walletAddress: string): Promise<void> {
		try {
			// Remove from WebSocket monitoring
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			await monitor.removeWalletFromTracking(walletAddress);
			
			// Deactivate in database
			await WalletWatchModel.updateMany(
				{ walletAddress: walletAddress.toLowerCase() },
				{ isActive: false }
			);
			
			logger.info('Successfully removed wallet from tracking', { walletAddress });
		} catch (error) {
			logger.error('Error removing wallet from tracking', { error, walletAddress });
		}
	}

	private static async sendTransactionNotification(telegramId: number, walletAddress: string, transaction: any): Promise<void> {
		try {
			logger.info('📤 Starting notification send process', { 
				telegramId, 
				walletAddress: walletAddress.toLowerCase(),
				txHash: transaction.hash 
			});

			const bot = (globalThis as any).botExport;
			
			if (!bot) {
				logger.error('❌ Bot instance not available on globalThis.botExport');
				return;
			}

			logger.info('✅ Bot instance found, preparing notification message');
			
			const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
			const shortTxHash = `${transaction.hash.slice(0, 8)}...${transaction.hash.slice(-6)}`;
			
			const value = transaction.value ? ethers.formatEther(transaction.value) : '0';
			
			// Now transaction.to should already be the correct recipient
			const isIncoming = transaction.to?.toLowerCase() === walletAddress.toLowerCase();
			const direction = isIncoming ? '📥 Received' : '📤 Sent';
			
			// Enhanced message with decoded transaction info
			let message = `🔔 Wallet Activity Detected!\n\n` +
				`Wallet: ${shortAddress}\n` +
				`Direction: ${direction}\n`;

			// Add enhanced info if available
			if (transaction.decoded) {
				const decoded = transaction.decoded;
				message += `Type: ${decoded.type || 'Unknown'}\n`;
				
				if (decoded.contractName) {
					message += `Platform: ${decoded.contractName}\n`;
				}
				
				if (decoded.tokenIn && decoded.amountIn) {
					message += `Token In: ${decoded.amountIn} ${decoded.tokenIn}\n`;
				}
				
				if (decoded.tokenOut && decoded.amountOut) {
					message += `Token Out: ${decoded.amountOut} ${decoded.tokenOut}\n`;
				}
				
				if (decoded.risk && decoded.risk !== 'LOW') {
					const riskEmoji = decoded.risk === 'VERY_HIGH' ? '🚨' : 
									decoded.risk === 'HIGH' ? '⚠️' : '⚡';
					message += `Risk Level: ${riskEmoji} ${decoded.risk}\n`;
				}
			} else {
				// Fallback to basic BNB transaction info
				message += `Amount: ${parseFloat(value).toFixed(6)} BNB\n`;
			}
			
			message += `From: ${transaction.from}\n` +
				`To: ${transaction.to || 'Contract Creation'}\n` +
				`Tx Hash: ${shortTxHash}\n\n` +
				`View on BSCScan: https://bscscan.com/tx/${transaction.hash}`;

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('📋 View Tracking', 'track_wallet'),
						Markup.button.callback('🔍 Analyze Wallet', `scan_address_${walletAddress}`)
					]
				]
			};

			logger.info('🚀 Attempting to send Telegram message', { 
				telegramId, 
				messageLength: message.length,
				hasKeyboard: !!keyboard 
			});

			const result = await bot.telegram.sendMessage(telegramId, message, {
				reply_markup: keyboard,
				disable_web_page_preview: true
			});

			logger.info('✅ Telegram message sent successfully', { 
				telegramId, 
				messageId: result.message_id,
				txHash: transaction.hash 
			});

		} catch (error) {
			logger.error('❌ Error sending transaction notification', { 
				error: error instanceof Error ? {
					name: error.name,
					message: error.message,
					stack: error.stack
				} : error,
				telegramId, 
				walletAddress,
				txHash: transaction.hash 
			});
		}
	}

	// Token tracking functionality
	static async showTokenTrackingMenu(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			// Get currently tracked tokens from the monitoring service
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			const trackedTokens = monitor.getTrackedTokens();

			let message = '🪙 **Token Tracking**\n\n';
			
			if (trackedTokens.length === 0) {
				message += 'You are not tracking any tokens yet.\n\n';
				message += 'Click "Add Token" to start tracking a token address. You will receive notifications whenever someone buys or sells that token.';
			} else {
				message += `You are tracking ${trackedTokens.length} token(s):\n\n`;
				
				for (const token of trackedTokens.slice(0, 5)) {
					const shortAddress = `${token.slice(0, 6)}...${token.slice(-4)}`;
					message += `• \`${token}\`\n`;
				}
				
				if (trackedTokens.length > 5) {
					message += `\n_...and ${trackedTokens.length - 5} more_\n`;
				}
				
				message += '\n💡 **Tip:** Token tracking shows buy/sell activity across all wallets for the specified token.';
			}

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('➕ Add Token', 'add_tracked_token'),
						...(trackedTokens.length > 0 ? [Markup.button.callback('📋 Manage', 'manage_tracked_tokens')] : [])
					],
					[Markup.button.callback('🔙 Back to Main Menu', 'start')]
				]
			};

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error) {
			logger.error('Error showing token tracking menu', { error, userId });
			await ctx.reply('❌ Error loading token tracking menu');
		}
	}

	static async handleAddToken(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			// Set session state for waiting for token address
			let session = global.userSessions.get(userId);
			if (!session) {
				const { WalletService } = await import('./wallet/connect');
				const walletService = new WalletService(global.userSessions);
				await walletService.initializeConnection(userId);
				session = global.userSessions.get(userId);
			}
			
			if (session) {
				// Clear all other waiting states to avoid conflicts
				delete session.waitingForWalletInput;
				delete session.waitingForWalletAddress;
				delete session.waitingForTokenSearchInput;
				if (session.trading) {
					delete session.trading.waitingForTokenInput;
					delete session.trading.waitingForAmountInput;
				}
				if (session.rugAlerts) {
					delete session.rugAlerts.waitingForTokenInput;
				}
				if (session.transfer) {
					delete session.transfer.waitingForAmountInput;
				}
				if (session.autoTradeSetup) {
					delete session.autoTradeSetup.waitingForInput;
				}
				
				// Set the correct waiting state
				session.waitingForTokenAddress = true;
				global.userSessions.set(userId, session);
			}

			const message = '🪙 **Add Token to Track**\n\n' +
				'Please send me the token contract address you want to track.\n\n' +
				'The address should be a valid BSC (BEP-20) token contract address starting with "0x".\n\n' +
				'Example: `0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82` (CAKE)\n\n' +
				'💡 **Note:** You will receive notifications when anyone buys or sells this token on DEXes like PancakeSwap.';

			const keyboard = {
				inline_keyboard: [
					[Markup.button.callback('❌ Cancel', 'track_token')]
				]
			};

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error) {
			logger.error('Error handling add token', { error, userId });
			await ctx.reply('❌ Error setting up token tracking');
		}
	}

	static async handleTokenAddressInput(ctx: Context, address: string): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Clear waiting state immediately since we received input
		const session = global.userSessions.get(userId);
		if (session) {
			session.waitingForTokenAddress = false;
			global.userSessions.set(userId, session);
		}

		try {
			// Validate address
			if (!ethers.isAddress(address)) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('❌ Invalid token address. Please provide a valid BSC token contract address starting with "0x".', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_token' }]
						]
					}
				});
				return;
			}

			// Get monitoring service
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			
			// Check if already tracking this token
			const trackedTokens = monitor.getTrackedTokens();
			if (trackedTokens.includes(address.toLowerCase())) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('⚠️ You are already tracking this token address.', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_token' }]
						]
					}
				});
				return;
			}

			// Check tracking limit (max 5 tokens per user for performance)
			if (trackedTokens.length >= 5) {
				const backButtonText = await getTranslation(ctx, 'common.back');
				await ctx.reply('❌ You can track a maximum of 5 tokens. Please remove some tokens first.', {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'track_token' }]
						]
					}
				});
				return;
			}

			// Try to get token symbol (simplified for now)
			let tokenSymbol = 'Unknown';
			try {
				// For now, use a simplified symbol until we implement full token info lookup
				tokenSymbol = `TOKEN_${address.slice(2, 8).toUpperCase()}`;
			} catch (error) {
				logger.warn('Could not fetch token info', { address, error });
			}

			// Add token to tracking
			await monitor.addTokenToTracking(address.toLowerCase(), tokenSymbol);

			const message = `✅ **Token Added Successfully!**\n\n` +
				`Now tracking: \`${address}\`\n` +
				`Symbol: ${tokenSymbol}\n\n` +
				`You will receive notifications whenever this token is bought or sold on BSC DEXes.`;

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('➕ Add Another', 'add_tracked_token'),
						Markup.button.callback('📋 View All', 'track_token')
					],
					[Markup.button.callback('🔙 Back to Main Menu', 'start')]
				]
			};

			await ctx.reply(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});

		} catch (error) {
			logger.error('Error handling token address input', { error, userId, address });
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply('❌ Error adding token to tracking list', {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'track_token' }]
					]
				}
			});
		}
	}

	static async handleManageTokens(ctx: Context): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			const trackedTokens = monitor.getTrackedTokens();

			if (trackedTokens.length === 0) {
				await this.showTokenTrackingMenu(ctx);
				return;
			}

			let message = '📋 **Manage Tracked Tokens**\n\n';
			message += 'Select a token to remove from tracking:\n\n';

			const buttons = [];
			for (const token of trackedTokens) {
				const shortAddress = `${token.slice(0, 6)}...${token.slice(-4)}`;
				buttons.push([Markup.button.callback(
					`❌ ${shortAddress}`,
					`remove_token_${token}`
				)]);
			}

			buttons.push([Markup.button.callback('🔙 Back', 'track_token')]);

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: { inline_keyboard: buttons }
			});
		} catch (error) {
			logger.error('Error handling manage tokens', { error, userId });
			await ctx.reply('❌ Error loading token management menu');
		}
	}

	static async handleRemoveToken(ctx: Context, tokenAddress: string): Promise<void> {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const { WalletTrackingMonitor } = await import('./walletTrackingMonitor');
			const monitor = WalletTrackingMonitor.getInstance();
			
			await monitor.removeTokenFromTracking(tokenAddress);

			const message = `✅ **Token Removed**\n\n` +
				`Stopped tracking: \`${tokenAddress}\`\n\n` +
				`You will no longer receive notifications for this token.`;

			const keyboard = {
				inline_keyboard: [
					[
						Markup.button.callback('📋 Manage Others', 'manage_tracked_tokens'),
						Markup.button.callback('🔙 Back', 'track_token')
					]
				]
			};

			await ctx.editMessageText(message, {
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});

		} catch (error) {
			logger.error('Error removing token', { error, userId, tokenAddress });
			await ctx.reply('❌ Error removing token from tracking');
		}
	}
}