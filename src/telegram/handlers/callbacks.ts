import { Telegraf, Context, Markup } from 'telegraf';
import { WalletService } from '../../services/wallet/connect';
import { TradingService } from '../../services/trading';
import { ScannerService } from '../../services/wallet/scanner';
import { RugAlertsService } from '../../services/rugAlerts';
import { TransferService } from '../../services/wallet/transfer';
import { UserService } from '../../services/user';
import { mainMenu, mainMenuEdit } from '../menus/main';
import { settingsMenu, notificationHourMenu, nameSettingsMenu, walletPreferenceMenu, timezoneMenu, chainSelectionMenu } from '../menus/settings';
import { handleWalletScanMenu, handleScanConnectedWallet, handleScanTradingWallet, handleScanBothWallets } from '../menus/walletScan';
import { handleBuySellMenu } from '../menus/trading';
import { handleWalletAnalytics, handleWalletHistory, handleWalletPnL } from '../menus/analytics';
import { handleRugAlertsMenu, handleAnalyzeCakeToken } from '../menus/rugAlerts';
import { setUserLanguage, getTranslation, getUserLanguage } from '@/i18n';
import { handleYieldTips, handleYieldRefresh, handleYieldRawDataCallback } from './yieldTips';
import { createLogger } from '@/utils/logger';
import { ChatHistoryModel } from '@/database/models/ChatHistory';
import { KeeperService } from '../../services/keeper';
import { FixedNumber } from 'ethers';
import { UserModel } from '@/database/models/User';
import { ReferralService } from '@/services/referralService';

const logger = createLogger('telegram.callbacks');


/**
 * Clear all waiting states for a user to reset them to neutral state
 * This ensures that when users return to main menu, no input handlers are active
 */
function clearUserWaitingState(userId: number): void {
	const session = global.userSessions.get(userId);
	if (session) {
		// Clear all possible waiting state flags
		delete session.waitingForWalletInput;
		delete session.waitingForWalletAddress;
		delete session.waitingForTokenAddress;
		delete session.waitingForTokenSearchInput;
		delete session.waitingForReferralCode;
		delete session.waitingForName;
		delete session.waitingForNameChange;

		// Clear nested waiting states
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
		
		logger.info(`Cleared waiting state for user ${userId}`);
	}
}

export function setupCallbacks(
	bot: Telegraf,
	walletService: WalletService,
	tradingService: TradingService,
	scannerService: ScannerService,
	rugAlertsService: RugAlertsService
) {
	const transferService = new TransferService();
	// Helper function to handle callback errors
	const handleCallback = (action: string, handler: (ctx: Context) => Promise<void>) => {
		bot.action(action, async (ctx) => {
			try {
				const userId = ctx.from!.id;

				// Clear waiting states when returning to main menu
				const backToMenuActions = ['start', 'start_edit', 'main_menu'];
				if (backToMenuActions.includes(action)) {
					clearUserWaitingState(userId);
				}

				// Only initialize wallet service if action requires it
				let session = global.userSessions.get(userId);
				
				if (requiresWallet(action)) {
					// First, try to get address from memory session (for WalletConnect users)
					let walletAddress = session?.address;

					// If not in memory, check database (for web-connected users)
					if (!walletAddress) {
						walletAddress = await UserService.getMainWalletAddress(userId);
					}

					// Final check - if no address found in either memory or database
					if (!walletAddress) {
						const msg = await getTranslation(ctx, 'common.pleaseConnectWalletFirst');
						await ctx.answerCbQuery(msg).catch(() => { });
						return;
					}

					// Ensure session object exists with wallet address for downstream code
					if (!session) {
						session = { address: walletAddress };
						global.userSessions.set(userId, session);
					} else if (!session.address) {
						session.address = walletAddress;
					}
				}

				// Special handling for callbacks that manage their own responses
				const selfManagedCallbacks = ['claim_honey', 'honey_history', 'honey_info'];
				if (!selfManagedCallbacks.includes(action)) {
					await ctx.answerCbQuery().catch(() => { });
				}
				await handler(ctx);
			} catch (error) {
				logger.error(`Error in ${action} callback`, { 
					error,
					userId: ctx.from?.id,
					action
				});
				try {
					const errorMsg = await getTranslation(ctx, 'common.operationFailed');
				await ctx.answerCbQuery(errorMsg).catch(() => { });
				} catch (e) {
					logger.error('Failed to send error message', { 
						error: e,
						userId: ctx.from?.id,
						action
					});
				}
			}
		});
	};

	// Menu actions
	handleCallback('settings', settingsMenu);
	handleCallback('start', mainMenu);
	handleCallback('start_edit', mainMenuEdit);
	handleCallback('main_menu', mainMenuEdit);
	handleCallback('onboarding_complete', async (ctx) => {
		await ctx.deleteMessage().catch(() => {});
		await walletService.initializeConnection(ctx.from!.id);
		await mainMenu(ctx);
	});

	// Referral system callbacks
	handleCallback('referral_menu', async (ctx) => {
		const { handleReferralMenu } = await import('../menus/referral');
		await handleReferralMenu(ctx);
	});

	handleCallback('manage_referral_earnings', async (ctx) => {
		const { handleManageReferralEarnings } = await import('../menus/referral');
		await handleManageReferralEarnings(ctx);
	});

	handleCallback('convert_ref_honey_setup', async (ctx) => {
		const { handleConvertSetup } = await import('../menus/referral');
		await handleConvertSetup(ctx);
	});

	handleCallback('withdraw_ref_bnb_setup', async (ctx) => {
		const { handleWithdrawSetup } = await import('../menus/referral');
		await handleWithdrawSetup(ctx);
	});

	handleCallback('redeem_code', async (ctx) => {
		const { handleRedeemCode } = await import('../menus/referral');
		await handleRedeemCode(ctx);
	});

	// Handle percentage-based referral actions
	bot.action(/^(convert|withdraw)_ref_bnb_percent_(\d+)$/, async (ctx) => {
		await ctx.answerCbQuery();
		const userId = ctx.from?.id;
		if (!userId) return;

		const action = ctx.match[1];
		const percentage = parseInt(ctx.match[2]);

		const user = await UserModel.findOne({ telegramId: userId });
		if (!user) return;

		const unclaimedBNB = FixedNumber.fromString(user.unclaimedReferralBNB || '0');
		const amountToProcess = unclaimedBNB.mulUnsafe(FixedNumber.fromValue(percentage)).divUnsafe(FixedNumber.fromValue(100));
		
		if (action === 'convert') {
			const result = await ReferralService.convertReferralBNBToHoney(user, amountToProcess.toString());
			await ctx.reply(result.message);
			if (result.success && result.honeyAdded) {
				await ctx.reply(`✨ You received ${result.honeyAdded.toLocaleString()} 🍯 Honey!`);
			}
		} else if (action === 'withdraw') {
			await ctx.reply('🔄 Processing withdrawal...');
			const result = await ReferralService.withdrawReferralBNB(user, amountToProcess.toString());
			await ctx.reply(result.message + (result.txHash ? `\n\n🔗 Transaction: \`${result.txHash}\`` : ''), { parse_mode: 'Markdown' });
		}
		
		// Refresh menu
		const { handleReferralMenu } = await import('../menus/referral');
		await handleReferralMenu(ctx);
	});

	// Handle custom amount input setup
	bot.action(/^(convert|withdraw)_ref_bnb_custom$/, async (ctx) => {
		await ctx.answerCbQuery();
		const userId = ctx.from?.id;
		if (!userId) return;

		const action = ctx.match[1];
		const lang = await getUserLanguage(userId);
		const session = global.userSessions.get(userId) || {};
		if (!session.referralManagement) session.referralManagement = {};

		if (action === 'convert') {
			session.referralManagement.isWaitingForConvertAmount = true;
			await ctx.reply(lang === 'zh' ? '请输入您想转换为Honey的BNB数量：' : 'Please enter the BNB amount you want to convert to Honey:');
		} else if (action === 'withdraw') {
			session.referralManagement.isWaitingForWithdrawAmount = true;
			await ctx.reply(lang === 'zh' ? '请输入您想提现的BNB数量：' : 'Please enter the BNB amount you want to withdraw:');
		}
		global.userSessions.set(userId, session);
	});
	
	// Skip name setting (stay anonymous)
	handleCallback('skip_name', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		const { UserService } = await import('../../services/user');
		
		// Mark user as having chosen to remain anonymous
		await UserService.markUserAsAnonymous(userId);
		
		if (session) {
			session.waitingForName = false;
			session.skipNamePrompt = true;
			global.userSessions.set(userId, session);
		}
		
		await ctx.deleteMessage().catch(() => {});
		
		// Import and call continueOnboarding function
		const { continueOnboardingFromCallback } = await import('./messages');
		await continueOnboardingFromCallback(ctx, userId);
	});
	
	// Onboarding language selection
	bot.action(/^onboarding_language:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const language = match[1] as 'en' | 'zh';
				const telegramId = ctx.from?.id;
				
				if (telegramId) {
					// Save language preference
					await setUserLanguage(telegramId, language);
					
					// Set session flag to track we're waiting for name
					const session = global.userSessions.get(telegramId);
					if (session) {
						session.waitingForName = true;
						session.onboardingLanguage = language;
						global.userSessions.set(telegramId, session);
					}
					
					// Delete language selection message
					await ctx.deleteMessage().catch(() => {});
					
					// Show name prompt in selected language
					const namePromptText = language === 'zh' ?
						'👋 在我们开始之前，我该怎么称呼您？\n\n请在下方输入您的名字：' :
						'👋 Before we get started, what would you like me to call you?\n\nPlease type your name below:';
					
					const anonymousButtonText = language === 'zh' ? '🕵️ 保持匿名' : '🕵️ Stay Anonymous';
					
					await ctx.reply(namePromptText, {
						parse_mode: 'Markdown',
						reply_markup: {
							inline_keyboard: [
								[{ text: anonymousButtonText, callback_data: 'skip_name' }]
							]
						}
					});
				}
			}
		} catch (error) {
			logger.error('Error in onboarding language selection', { 
				error,
				userId: ctx.from?.id,
				action: 'onboarding_language'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSelectingLanguage');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Name settings menu
	handleCallback('name_settings', nameSettingsMenu);
	
	// Wallet preference menu
	handleCallback('wallet_preference', walletPreferenceMenu);
	
	// Confirm clear chat history
	handleCallback('confirm_clear_history', async (ctx) => {
		const telegramId = ctx.from?.id;
		if (!telegramId) return;
		
		try {
			// Soft delete chat history for this user by setting isActive to false
			const result = await ChatHistoryModel.updateMany(
				{ telegramId: telegramId, isActive: true }, 
				{ $set: { isActive: false } }
			);
			
			const userLanguage = await getUserLanguage(telegramId);
			const isEnglish = userLanguage === 'en';
			
			const successMessage = isEnglish ? 
				`✅ Chat history cleared successfully!\n\n${result.modifiedCount} messages were archived.` :
				`✅ 聊天记录已成功清除！\n\n已归档 ${result.modifiedCount} 条消息。`;
			
			const clearedMsg = await getTranslation(ctx, 'common.chatHistoryCleared');
			await ctx.answerCbQuery(clearedMsg, { show_alert: true });
			await ctx.editMessageText(successMessage, {
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ 
							text: isEnglish ? '🔙 Back to Settings' : '🔙 返回设置', 
							callback_data: 'settings' 
						}]
					]
				}
			});
		} catch (error) {
			logger.error('Error clearing chat history', { error, userId: telegramId });
			const errorMsg = await getTranslation(ctx, 'common.errorClearingHistory');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Change name action
	handleCallback('change_name', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		const lang = await getUserLanguage(userId);
		
		if (session) {
			session.waitingForNameChange = true;
			global.userSessions.set(userId, session);
		}
		
		const messageText = lang === 'zh' ? 
			'✏️ **更改名称**\n\n请在下方输入您的新名称：' :
			'✏️ **Change Name**\n\nPlease type your new name below:';
		const backButtonText = lang === 'zh' ? '🔙 返回名称设置' : '🔙 Back to Name Settings';
		
		await ctx.editMessageText(
			messageText,
			{
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'name_settings' }]
					]
				}
			}
		);
	});
	
	// Go anonymous action
	handleCallback('go_anonymous', async (ctx) => {
		const userId = ctx.from!.id;
		const { UserService } = await import('../../services/user');
		const lang = await getUserLanguage(userId);
		
		// Mark user as having chosen to remain anonymous
		await UserService.markUserAsAnonymous(userId);
		
		const successMessage = lang === 'zh' ? '✅ 您现在是匿名的！' : '✅ You are now anonymous!';
		await ctx.answerCbQuery(successMessage, { show_alert: true });
		await nameSettingsMenu(ctx);
	});
	
	// Language selection
	bot.action(/^set_language:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const language = match[1] as 'en' | 'zh';
				const telegramId = ctx.from?.id;
				
				if (telegramId) {
					await setUserLanguage(telegramId, language);
					const updatedMessage = await getTranslation(ctx, 'language.updated');
					await ctx.answerCbQuery(updatedMessage, { show_alert: true });
					await settingsMenu(ctx);
				}
			}
		} catch (error) {
			logger.error('Error setting language', { 
				error,
				userId: ctx.from?.id,
				action: 'set_language'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSelectingLanguage');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Notification actions
	handleCallback('select_notification_hour', notificationHourMenu);
	
	// Toggle daily notification
	handleCallback('toggle_daily_notification', async (ctx) => {
		const telegramId = ctx.from?.id;
		if (!telegramId) return;

		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId });
		if (!user) return;

		user.dailyNotificationEnabled = !user.dailyNotificationEnabled;
		await user.save();

		const message = user.dailyNotificationEnabled
			? await getTranslation(ctx, 'notifications.toggleEnabled')
			: await getTranslation(ctx, 'notifications.toggleDisabled');
		
		await ctx.answerCbQuery(message, { show_alert: true });
		await settingsMenu(ctx);
	});

	// Set notification hour
	bot.action(/^set_notification_hour:(\d+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const hour = parseInt(match[1]);
				const telegramId = ctx.from?.id;
				
				if (telegramId) {
					const { UserModel } = await import('@/database/models/User');
					await UserModel.updateOne({ telegramId }, { dailyNotificationHour: hour });
					
					const message = (await getTranslation(ctx, 'notifications.hourUpdated')).replace('{hour}', hour.toString());
					await ctx.answerCbQuery(message, { show_alert: true });
					await settingsMenu(ctx);
				}
			}
		} catch (error) {
			console.error('Error setting notification hour:', error);
			const errorMsg = await getTranslation(ctx, 'common.errorUpdatingNotificationHour');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Select timezone menu
	handleCallback('select_timezone', timezoneMenu);
	
	// Chain selection menu
	handleCallback('chain_selection', chainSelectionMenu);
	
	// Set chain
	bot.action(/^set_chain:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const chain = match[1] as 'bnb' | 'opbnb';
				const telegramId = ctx.from?.id;
				
				if (telegramId) {
					const { UserModel } = await import('@/database/models/User');
					await UserModel.updateOne({ telegramId }, { selectedChain: chain });
					
					const lang = await getUserLanguage(telegramId);
					const chainName = chain === 'opbnb' ? 'opBNB' : 'BNB Chain';
					const message = lang === 'zh' 
						? `✅ AI 链已切换到 ${chainName}`
						: `✅ AI chain switched to ${chainName}`;
					
					await ctx.answerCbQuery(message, { show_alert: true });
					await settingsMenu(ctx);
				}
			}
		} catch (error) {
			logger.error('Failed to set chain', error);
			await ctx.answerCbQuery('Failed to set chain', { show_alert: true });
		}
	});

	// Set timezone
	bot.action(/^set_timezone:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const timezone = match[1];
				const telegramId = ctx.from?.id;
				
				if (telegramId) {
					const { UserModel } = await import('@/database/models/User');
					await UserModel.updateOne({ telegramId }, { timezone });
					
					// Get current time in new timezone
					const formatter = new Intl.DateTimeFormat('en-US', {
						timeZone: timezone,
						hour: '2-digit',
						minute: '2-digit',
						hour12: false
					});
					const currentTime = formatter.format(new Date());
					
					const msg = (await getTranslation(ctx, 'notifications.timezoneUpdated'))
						.replace('{timezone}', timezone)
						.replace('{time}', currentTime);
					await ctx.answerCbQuery(msg, { show_alert: true });
					await settingsMenu(ctx);
				}
			}
		} catch (error) {
			console.error('Error setting timezone:', error);
			const errorMsg = await getTranslation(ctx, 'common.errorUpdatingTimezone');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Toggle trade confirmations
	handleCallback('toggle_trade_confirmations', async (ctx) => {
		const telegramId = ctx.from?.id;
		if (!telegramId) return;

		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId });
		if (!user) return;

		user.showTradeConfirmations = !user.showTradeConfirmations;
		await user.save();

		const message = user.showTradeConfirmations
			? '✅ Trade confirmations enabled'
			: '⚡ Quick trade enabled (no confirmations)';
		
		await ctx.answerCbQuery(message, { show_alert: true });
		await settingsMenu(ctx);
	});

	// Toggle debug mode
	handleCallback('toggle_debug_mode', async (ctx) => {
		const telegramId = ctx.from?.id;
		if (!telegramId) return;

		const { UserModel } = await import('@/database/models/User');
		const user = await UserModel.findOne({ telegramId });
		if (!user) return;

		user.debugMode = !user.debugMode;
		await user.save();

		const lang = await getUserLanguage(telegramId);
		const message = user.debugMode
			? (lang === 'zh' ? '🐛 调试模式已开启' : '🐛 Debug mode enabled')
			: (lang === 'zh' ? '🐛 调试模式已关闭' : '🐛 Debug mode disabled');
		
		await ctx.answerCbQuery(message, { show_alert: true });
		await settingsMenu(ctx);
	});
	
	// Wallet preference selection
	bot.action(/^set_wallet_pref:(.+)$/, async (ctx) => {
		try {
			const telegramId = ctx.from?.id;
			if (!telegramId) return;
			
			const match = ctx.match;
			if (match && match[1]) {
				const preference = match[1] as 'main' | 'trading' | 'both';
				const session = global.userSessions.get(telegramId);
				
				if (session) {
					session.selectedWallet = preference;
					global.userSessions.set(telegramId, session);
				}
				
				const lang = await getUserLanguage(telegramId);
				const prefDisplay = preference === 'main' ? (lang === 'zh' ? '主钱包' : 'Main Wallet') : 
				                   preference === 'trading' ? (lang === 'zh' ? '交易钱包' : 'Trading Wallet') : 
				                   (lang === 'zh' ? '两个钱包' : 'Both Wallets');
				
				const successMessage = lang === 'zh' ? 
					`✅ 钱包偏好已设置为${prefDisplay}` :
					`✅ Wallet preference set to ${prefDisplay}`;
				await ctx.answerCbQuery(successMessage, { show_alert: true });
				await settingsMenu(ctx);
			}
		} catch (error) {
			logger.error('Error setting wallet preference:', error);
			const errorMsg = await getTranslation(ctx, 'common.errorUpdatingWalletPreference');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Wallet actions
	handleCallback('connect_wallet', async (ctx) => {
		const title = await getTranslation(ctx, 'wallet.connectOptionsTitle');
		const binanceButton = await getTranslation(ctx, 'wallet.connectBinance');
		const trustWalletButton = await getTranslation(ctx, 'wallet.connectTrustWallet');
		const otherButton = await getTranslation(ctx, 'wallet.connectOtherWallet');
		const backButton = await getTranslation(ctx, 'common.back');
		
		const userId = ctx.from?.id;
		if (!userId) return;

		// Import the generateConnectionLink function
		const { generateConnectionLink } = await import('../../api/server');
		const secureUrl = generateConnectionLink(userId);

		const keyboard = {
			inline_keyboard: [
				// Binance Wallet button - direct web link (no QR code)
				[{ text: binanceButton, url: secureUrl }],
				// Trust Wallet button - WalletConnect with QR code
				[{ text: trustWalletButton, callback_data: 'connect_trustwallet' }],
				// Other wallets button - WalletConnect with QR code  
				[{ text: otherButton, callback_data: 'connect_walletconnect' }],
				[{ text: backButton, callback_data: 'start_edit' }]
			]
		};

		if (ctx.callbackQuery) {
			await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'Markdown' });
		} else {
			await ctx.reply(title, { reply_markup: keyboard, parse_mode: 'Markdown' });
		}
	});
	
	// New handlers for specific wallet types
	handleCallback('connect_trustwallet', (ctx) => walletService.handleTrustWalletConnect(ctx));
	handleCallback('connect_walletconnect', (ctx) => walletService.handleConnect(ctx));
	handleCallback('disconnect_wallet', (ctx) => walletService.handleDisconnect(ctx));
	handleCallback('wallet_info', (ctx) => walletService.handleWalletInfo(ctx));
	
	// Account menu handlers
	handleCallback('account_menu', async (ctx) => {
		const { handleAccountMenu } = await import('./account');
		await handleAccountMenu(ctx);
	});
	handleCallback('claim_honey', async (ctx) => {
		const { handleClaimHoney } = await import('./account');
		await handleClaimHoney(ctx);
	});
	// Leaderboard menu actions
	handleCallback('leaderboard_menu', async (ctx) => {
		const { handleLeaderboardMenu } = await import('../menus/leaderboard');
		await handleLeaderboardMenu(ctx);
	});
	handleCallback('leaderboard_overall', async (ctx) => {
		const { handleSpecificLeaderboard } = await import('../menus/leaderboard');
		const { LeaderboardType } = await import('../../database/models/Leaderboard');
		await handleSpecificLeaderboard(ctx, LeaderboardType.OVERALL);
	});
	handleCallback('leaderboard_honey', async (ctx) => {
		const { handleSpecificLeaderboard } = await import('../menus/leaderboard');
		const { LeaderboardType } = await import('../../database/models/Leaderboard');
		await handleSpecificLeaderboard(ctx, LeaderboardType.HONEY_BURNED);
	});
	handleCallback('leaderboard_streak', async (ctx) => {
		const { handleSpecificLeaderboard } = await import('../menus/leaderboard');
		const { LeaderboardType } = await import('../../database/models/Leaderboard');
		await handleSpecificLeaderboard(ctx, LeaderboardType.LOGIN_STREAK);
	});
	handleCallback('leaderboard_referrals', async (ctx) => {
		const { handleSpecificLeaderboard } = await import('../menus/leaderboard');
		const { LeaderboardType } = await import('../../database/models/Leaderboard');
		await handleSpecificLeaderboard(ctx, LeaderboardType.REFERRALS);
	});
	handleCallback('leaderboard_my_ranks', async (ctx) => {
		const { handleMyRanks } = await import('../menus/leaderboard');
		await handleMyRanks(ctx);
	});
	handleCallback('honey_history', async (ctx) => {
		const { handleHoneyHistory } = await import('./account');
		await handleHoneyHistory(ctx);
	});
	handleCallback('nectr_exchange', async (ctx) => {
		const { handleNectrExchange } = await import('./account');
		await handleNectrExchange(ctx);
	});
	handleCallback('honey_info', async (ctx) => {
		const { handleHoneyInfo } = await import('./account');
		await handleHoneyInfo(ctx);
	});

	// Honey recharge callbacks
	handleCallback('honey_recharge', async (ctx) => {
		const { honeyRechargeMenu } = await import('../menus/honeyRecharge');
		await honeyRechargeMenu(ctx);
	});

	handleCallback('honey_help', async (ctx) => {
		const { showHoneyHelp } = await import('../menus/honeyRecharge');
		await showHoneyHelp(ctx);
	});

	handleCallback('honey_history', async (ctx) => {
		const { showHoneyHistory } = await import('../menus/honeyRecharge');
		await showHoneyHistory(ctx);
	});

	handleCallback('fund_trading_wallet_from_recharge', async (ctx) => {
		const userId = ctx.from!.id;
		// Check if user has connected main wallet
		let walletAddress = global.userSessions.get(userId)?.address;
		if (!walletAddress) {
			walletAddress = await UserService.getMainWalletAddress(userId);
		}
		
		if (!walletAddress) {
			// Show friendly message with connect wallet option
			const isZh = await getUserLanguage(userId) === 'zh';
			const message = isZh 
				? '💳 您需要先连接主钱包才能为交易钱包充值。\n\n请先连接您的主钱包，然后就可以将 BNB 转入交易钱包来购买蜂蜜了！'
				: '💳 You need to connect your main wallet first to fund your trading wallet.\n\nPlease connect your main wallet, then you can transfer BNB to your trading wallet to purchase Honey!';
			
			const keyboard = Markup.inlineKeyboard([
				[Markup.button.callback(isZh ? '🔗 连接钱包' : '🔗 Connect Wallet', 'connect_wallet')],
				[Markup.button.callback(isZh ? '🔙 返回' : '🔙 Back', 'honey_recharge')]
			]);
			
			await ctx.editMessageText(message, {
				reply_markup: keyboard.reply_markup
			});
			return;
		}
		
		// If wallet is connected, proceed to transfer menu
		await transferService.showTransferToTradingMenu(ctx, 'honey_recharge');
	});

	// Handle honey purchase patterns
	bot.action(/^honey_buy_(\d+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const packageIndex = parseInt(match[1]);
				const { handleHoneyPurchase } = await import('../menus/honeyRecharge');
				await handleHoneyPurchase(ctx, packageIndex);
			}
		} catch (error) {
			logger.error('Error in honey_buy callback', { error, userId: ctx.from?.id });
			await ctx.answerCbQuery('❌ Error processing purchase');
		}
	});

	bot.action(/^honey_confirm_(\d+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const packageIndex = parseInt(match[1]);
				const { executeHoneyPurchase } = await import('../menus/honeyRecharge');
				await executeHoneyPurchase(ctx, packageIndex);
			}
		} catch (error) {
			logger.error('Error in honey_confirm callback', { error, userId: ctx.from?.id });
			await ctx.answerCbQuery('❌ Error confirming purchase');
		}
	});
	
	// Handle show WC link callback
	bot.action(/^show_wc_link:(\d+)$/, async (ctx) => {
		try {
			await walletService.handleShowWcLink(ctx);
		} catch (error) {
			logger.error('Error showing WC link', { 
				error,
				userId: ctx.from?.id,
				action: 'show_wc_link'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorDisplayingLink');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Handle copy WC link callback
	bot.action(/^copy_wc_link:(\d+)$/, async (ctx) => {
		try {
			await walletService.handleCopyWcLink(ctx);
		} catch (error) {
			logger.error('Error copying WC link', { 
				error,
				userId: ctx.from?.id,
				action: 'copy_wc_link'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorDisplayingLink');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	

	// Transfer actions
	handleCallback('transfer_menu', (ctx) => transferService.showTransferMenu(ctx));
	
	// Transfer direction selection
	handleCallback('transfer_to_trading', (ctx) => transferService.showTransferToTradingMenu(ctx));
	handleCallback('transfer_from_trading', (ctx) => transferService.showTransferFromTradingMenu(ctx));
	
	// Main to Trading transfers
	handleCallback('transfer_0.01', (ctx) => transferService.handleTransferToTrading(ctx, '0.01'));
	handleCallback('transfer_0.05', (ctx) => transferService.handleTransferToTrading(ctx, '0.05'));
	handleCallback('transfer_0.1', (ctx) => transferService.handleTransferToTrading(ctx, '0.1'));
	handleCallback('transfer_0.5', (ctx) => transferService.handleTransferToTrading(ctx, '0.5'));
	handleCallback('transfer_percent_25', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (!session?.address) {
			const msg = await getTranslation(ctx, 'common.mainWalletNotConnected');
			await ctx.answerCbQuery(msg);
			return;
		}
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const balance = await getBNBBalance(session.address);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.25).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferToTrading(ctx, transferAmount);
	});
	handleCallback('transfer_percent_50', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (!session?.address) {
			const msg = await getTranslation(ctx, 'common.mainWalletNotConnected');
			await ctx.answerCbQuery(msg);
			return;
		}
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const balance = await getBNBBalance(session.address);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.50).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferToTrading(ctx, transferAmount);
	});
	handleCallback('transfer_percent_75', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (!session?.address) {
			const msg = await getTranslation(ctx, 'common.mainWalletNotConnected');
			await ctx.answerCbQuery(msg);
			return;
		}
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const balance = await getBNBBalance(session.address);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.75).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferToTrading(ctx, transferAmount);
	});
	handleCallback('transfer_percent_100', async (ctx) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (!session?.address) {
			const msg = await getTranslation(ctx, 'common.mainWalletNotConnected');
			await ctx.answerCbQuery(msg);
			return;
		}
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const balance = await getBNBBalance(session.address);
		const balanceNum = parseFloat(balance);
		const transferAmount = balanceNum.toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferToTrading(ctx, transferAmount);
	});
	handleCallback('transfer_custom_to_trading', (ctx) => transferService.handleCustomTransferToTrading(ctx));
	
	// Trading to Main transfers
	handleCallback('transfer_from_0.01', (ctx) => transferService.handleTransferFromTrading(ctx, '0.01'));
	handleCallback('transfer_from_0.05', (ctx) => transferService.handleTransferFromTrading(ctx, '0.05'));
	handleCallback('transfer_from_0.1', (ctx) => transferService.handleTransferFromTrading(ctx, '0.1'));
	handleCallback('transfer_from_0.5', (ctx) => transferService.handleTransferFromTrading(ctx, '0.5'));
	handleCallback('transfer_from_percent_25', async (ctx) => {
		const userId = ctx.from!.id;
		const { UserService } = await import('../../services/user');
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		if (!tradingWalletAddress) {
			const msg = await getTranslation(ctx, 'common.tradingWalletNotFound');
			await ctx.answerCbQuery(msg);
			return;
		}
		const balance = await getBNBBalance(tradingWalletAddress);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.25).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferFromTrading(ctx, transferAmount);
	});
	handleCallback('transfer_from_percent_50', async (ctx) => {
		const userId = ctx.from!.id;
		const { UserService } = await import('../../services/user');
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		if (!tradingWalletAddress) {
			const msg = await getTranslation(ctx, 'common.tradingWalletNotFound');
			await ctx.answerCbQuery(msg);
			return;
		}
		const balance = await getBNBBalance(tradingWalletAddress);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.50).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferFromTrading(ctx, transferAmount);
	});
	handleCallback('transfer_from_percent_75', async (ctx) => {
		const userId = ctx.from!.id;
		const { UserService } = await import('../../services/user');
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		if (!tradingWalletAddress) {
			const msg = await getTranslation(ctx, 'common.tradingWalletNotFound');
			await ctx.answerCbQuery(msg);
			return;
		}
		const balance = await getBNBBalance(tradingWalletAddress);
		const balanceNum = parseFloat(balance);
		const transferAmount = (balanceNum * 0.75).toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferFromTrading(ctx, transferAmount);
	});
	handleCallback('transfer_from_percent_100', async (ctx) => {
		const userId = ctx.from!.id;
		const { UserService } = await import('../../services/user');
		const { getBNBBalance } = await import('../../services/wallet/balance');
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		if (!tradingWalletAddress) {
			const msg = await getTranslation(ctx, 'common.tradingWalletNotFound');
			await ctx.answerCbQuery(msg);
			return;
		}
		const balance = await getBNBBalance(tradingWalletAddress);
		const balanceNum = parseFloat(balance);
		const transferAmount = balanceNum.toFixed(4);
		if (parseFloat(transferAmount) < 0.001) {
			const msg = await getTranslation(ctx, 'common.amountTooSmall');
			await ctx.answerCbQuery(msg);
			return;
		}
		return transferService.handleTransferFromTrading(ctx, transferAmount);
	});
	handleCallback('transfer_custom_from_trading', (ctx) => transferService.handleCustomTransferFromTrading(ctx));

	// Analytics actions
	handleCallback('wallet_analytics', handleWalletAnalytics);
	handleCallback('wallet_history', handleWalletHistory);
	handleCallback('wallet_pnl', handleWalletPnL);

	// Scanning actions
	handleCallback('wallet_scan', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		
		const { checkHoneyAndProceed } = await import('../helpers/honeyCheck');
		const { HoneyFeature } = await import('../../database/models/HoneyTransaction');
		
		await checkHoneyAndProceed(ctx, HoneyFeature.WALLET_SCAN, async () => {
			await handleWalletScanMenu(ctx, scannerService);
		});
	});
	handleCallback('scan_connected_wallet', (ctx) => handleScanConnectedWallet(ctx, scannerService));
	handleCallback('scan_trading_wallet', (ctx) => handleScanTradingWallet(ctx, scannerService));
	handleCallback('scan_both_wallets', (ctx) => handleScanBothWallets(ctx, scannerService));

	// Rug Alerts actions
	handleCallback('rug_alerts', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		
		const { checkHoneyAndProceed } = await import('../helpers/honeyCheck');
		const { HoneyFeature } = await import('../../database/models/HoneyTransaction');
		
		await checkHoneyAndProceed(ctx, HoneyFeature.RUG_ALERT, async () => {
			await handleRugAlertsMenu(ctx, rugAlertsService);
		});
	});
	handleCallback('analyze_cake_token', (ctx) => handleAnalyzeCakeToken(ctx, rugAlertsService));
	
	// Rug Alert details/summary toggle
	bot.action(/^rug_details:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				await rugAlertsService.sendDetailedAnalysis(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error showing rug alert details', { error });
			await ctx.answerCbQuery('❌ Error showing details');
		}
	});
	
	bot.action(/^rug_summary:(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const userId = ctx.from!.id;
				const session = global.userSessions.get(userId);
				
				if (session?.rugAlerts?.lastAnalysis && session.rugAlerts.lastAnalysis.metadata.address === tokenAddress) {
					const analysis = session.rugAlerts.lastAnalysis;
					const summary = rugAlertsService.generateNaturalSummary(analysis);
					
					const keyboard = {
						inline_keyboard: [
							[{ text: '📋 View Detailed Report', callback_data: `rug_details:${tokenAddress}` }],
							[{ text: '🔙 Back', callback_data: 'start_edit' }]
						]
					};
					
					await ctx.editMessageText(summary, {
						reply_markup: keyboard,
						parse_mode: 'Markdown'
					});
				} else {
					await ctx.answerCbQuery('Analysis data not found. Please run the analysis again.');
				}
			}
		} catch (error) {
			logger.error('Error showing rug alert summary', { error });
			await ctx.answerCbQuery('❌ Error showing summary');
		}
	});

	// Trading actions
	handleCallback('buy_sell', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		await handleBuySellMenu(ctx, tradingService);
	});
	handleCallback('confirm_trade', (ctx) => tradingService.handleTradeConfirmation(ctx));

	// Quick amount callbacks
	handleCallback('amount_0.1', (ctx) => tradingService.handleQuickAmount(ctx, '0.1'));
	handleCallback('amount_0.5', (ctx) => tradingService.handleQuickAmount(ctx, '0.5'));
	handleCallback('amount_1', (ctx) => tradingService.handleQuickAmount(ctx, '1'));
	handleCallback('amount_5', (ctx) => tradingService.handleQuickAmount(ctx, '5'));

	// Percentage callbacks
	handleCallback('percent_25', (ctx) => tradingService.handlePercentageAmount(ctx, 25));
	handleCallback('percent_50', (ctx) => tradingService.handlePercentageAmount(ctx, 50));
	handleCallback('percent_75', (ctx) => tradingService.handlePercentageAmount(ctx, 75));
	handleCallback('percent_100', (ctx) => tradingService.handlePercentageAmount(ctx, 100));

	// Yield tips actions
	handleCallback('yield_tips', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		
		const { checkHoneyAndProceed } = await import('../helpers/honeyCheck');
		const { HoneyFeature } = await import('../../database/models/HoneyTransaction');
		
		await checkHoneyAndProceed(ctx, HoneyFeature.YIELD_TIPS, async () => {
			await handleYieldTips(ctx, false);
		});
	});
	handleCallback('yield_refresh', (ctx) => handleYieldTips(ctx, true));
	handleCallback('yield_refresh_raw', async (ctx) => {
		await ctx.answerCbQuery('Refreshing raw data...');
		await handleYieldRawDataCallback(ctx);
	});
	handleCallback('yield_raw_data', handleYieldRawDataCallback);
	handleCallback('yield_ai_analysis', (ctx) => handleYieldTips(ctx, true));
	
	// Sentiment analysis actions
	handleCallback('market_sentiment', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		
		const { checkHoneyAndProceed } = await import('../helpers/honeyCheck');
		const { HoneyFeature } = await import('../../database/models/HoneyTransaction');
		
		await checkHoneyAndProceed(ctx, HoneyFeature.MARKET_SENTIMENT, async () => {
			const { handleSentimentMenu } = await import('../menus/sentiment');
			await handleSentimentMenu(ctx);
		});
	});
	handleCallback('sentiment_menu', async (ctx) => {
		const { handleSentimentMenu } = await import('../menus/sentiment');
		await handleSentimentMenu(ctx);
	});
	handleCallback('sentiment_quick', async (ctx) => {
		const { handleSentimentAnalysis } = await import('../menus/sentiment');
		await handleSentimentAnalysis(ctx, '24h', false);
	});
	handleCallback('sentiment_detailed', async (ctx) => {
		const { handleSentimentAnalysis } = await import('../menus/sentiment');
		await handleSentimentAnalysis(ctx, '24h', true);
	});
	handleCallback('sentiment_1h', async (ctx) => {
		const { handleSentimentAnalysis } = await import('../menus/sentiment');
		await handleSentimentAnalysis(ctx, '1h', false);
	});
	handleCallback('sentiment_24h', async (ctx) => {
		const { handleSentimentAnalysis } = await import('../menus/sentiment');
		await handleSentimentAnalysis(ctx, '24h', false);
	});
	handleCallback('sentiment_7d', async (ctx) => {
		const { handleSentimentAnalysis } = await import('../menus/sentiment');
		await handleSentimentAnalysis(ctx, '7d', false);
	});
	
	// Today's Picks actions
	handleCallback('todays_pick', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		const { handleTodaysPicks } = await import('./todaysPicks');
		await handleTodaysPicks(ctx);
	});
	
	// Token search actions
	handleCallback('token_search', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		const { handleTokenSearchMenu } = await import('../menus/tokenSearch');
		await handleTokenSearchMenu(ctx);
	});

	// Wallet tracking actions
	handleCallback('track_wallet', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		const { WalletTrackingService } = await import('../../services/walletTracking');
		await WalletTrackingService.showTrackingMenu(ctx);
	});
	handleCallback('add_tracked_wallet', async (ctx) => {
		const { WalletTrackingService } = await import('../../services/walletTracking');
		await WalletTrackingService.handleAddWallet(ctx);
	});
	handleCallback('manage_tracked_wallets', async (ctx) => {
		const { WalletTrackingService } = await import('../../services/walletTracking');
		await WalletTrackingService.handleManageWallets(ctx);
	});

	// Token tracking actions
	handleCallback('track_token', async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await KeeperService.updateActivityStreak(userId);
		const { TokenTrackingService } = await import('../../services/tokenTracking');
		await TokenTrackingService.showTokenTrackingMenu(ctx);
	});

	// opBNB Dashboard actions
	handleCallback('opbnb_dashboard', async (ctx) => {
		const { opbnbDashboard } = await import('../menus/opbnb');
		await opbnbDashboard(ctx);
	});

	// New opBNB Check Holdings menu and handlers
	handleCallback('opbnb_check_holdings', async (ctx) => {
		const { opbnbCheckHoldings } = await import('../menus/opbnb');
		await opbnbCheckHoldings(ctx);
	});

	handleCallback('opbnb_holdings_main_wallet', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		const { UserService } = await import('../../services/user');
		const session = global.userSessions.get(userId);
		const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
		
		if (mainWallet) {
			const { showOpbnbHoldings } = await import('../menus/opbnb');
			await showOpbnbHoldings(ctx, mainWallet, 'Main');
		}
	});


	// New opBNB Transaction History menu and handlers
	handleCallback('opbnb_transaction_history_menu', async (ctx) => {
		const { opbnbTransactionHistoryMenu } = await import('../menus/opbnb');
		await opbnbTransactionHistoryMenu(ctx);
	});

	handleCallback('opbnb_transactions_main_wallet', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		const { UserService } = await import('../../services/user');
		const session = global.userSessions.get(userId);
		const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
		
		if (mainWallet) {
			const { showOpbnbTransactions } = await import('../menus/opbnb');
			await showOpbnbTransactions(ctx, mainWallet, 'Main');
		}
	});


	// Legacy handlers for backward compatibility
	handleCallback('opbnb_detailed_view', async (ctx) => {
		const { opbnbDetailedView } = await import('../menus/opbnb');
		await opbnbDetailedView(ctx);
	});
	handleCallback('opbnb_native_balance', async (ctx) => {
		const { opbnbNativeBalance } = await import('../menus/opbnb');
		await opbnbNativeBalance(ctx);
	});
	handleCallback('opbnb_token_balances', async (ctx) => {
		const { opbnbTokenBalances } = await import('../menus/opbnb');
		await opbnbTokenBalances(ctx);
	});
	handleCallback('opbnb_transaction_history', async (ctx) => {
		const { opbnbTransactionHistory } = await import('../menus/opbnb');
		await opbnbTransactionHistory(ctx);
	});

	// opBNB Token Analysis handlers
	handleCallback('opbnb_token_analysis', async (ctx) => {
		const { opbnbTokenAnalysis } = await import('../menus/opbnb');
		await opbnbTokenAnalysis(ctx);
	});
	
	// opBNB Whale Tracker handler
	handleCallback('opbnb_whale_tracker', async (ctx) => {
		const { opbnbWhaleTracker } = await import('../menus/opbnb');
		await opbnbWhaleTracker(ctx);
	});
	
	// opBNB Hot Tokens handler
	handleCallback('opbnb_hot_tokens', async (ctx) => {
		const { opbnbHotTokens } = await import('../menus/opbnb');
		await opbnbHotTokens(ctx);
	});
	
	// opBNB Token Health Check handler
	handleCallback('opbnb_token_health', async (ctx) => {
		const { opbnbTokenHealth } = await import('../menus/opbnb');
		await opbnbTokenHealth(ctx);
	});
	
	// opBNB Whale Tracker refresh handler
	bot.action(/^opbnb_whale_refresh_(.+)$/, async (ctx) => {
		const match = ctx.match;
		if (match && match[1]) {
			const tokenAddress = match[1];
			const { showWhaleTracking } = await import('../menus/opbnb');
			await showWhaleTracking(ctx, tokenAddress);
		}
	});
	
	// opBNB Token Health refresh handler
	bot.action(/^opbnb_health_refresh_(.+)$/, async (ctx) => {
		const match = ctx.match;
		if (match && match[1]) {
			const tokenAddress = match[1];
			const { showTokenHealthCheck } = await import('../menus/opbnb');
			await showTokenHealthCheck(ctx, tokenAddress);
		}
	});

	// Cross-navigation handlers (from holdings to transactions and vice versa)
	handleCallback('opbnb_transactions_from_holdings', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbTransactions } = await import('../menus/opbnb');
			await showOpbnbTransactions(ctx, walletAddress, 'Custom');
		} else {
			// Fallback to transaction history menu
			const { opbnbTransactionHistoryMenu } = await import('../menus/opbnb');
			await opbnbTransactionHistoryMenu(ctx);
		}
	});

	handleCallback('opbnb_holdings_from_transactions', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbHoldings } = await import('../menus/opbnb');
			await showOpbnbHoldings(ctx, walletAddress, 'Custom');
		} else {
			// Fallback to check holdings menu
			const { opbnbCheckHoldings } = await import('../menus/opbnb');
			await opbnbCheckHoldings(ctx);
		}
	});

	// Refresh handlers for custom addresses
	handleCallback('opbnb_holdings_refresh', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbHoldings } = await import('../menus/opbnb');
			await showOpbnbHoldings(ctx, walletAddress, 'Custom');
		} else {
			// Fallback to check holdings menu
			const { opbnbCheckHoldings } = await import('../menus/opbnb');
			await opbnbCheckHoldings(ctx);
		}
	});

	handleCallback('opbnb_transactions_refresh', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbTransactions } = await import('../menus/opbnb');
			await showOpbnbTransactions(ctx, walletAddress, 'Custom');
		} else {
			// Fallback to transaction history menu
			const { opbnbTransactionHistoryMenu } = await import('../menus/opbnb');
			await opbnbTransactionHistoryMenu(ctx);
		}
	});

	// opBNB copy functionality handlers
	bot.action(/^copy_opbnb_wallet_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const walletAddress = match[1];
				const userId = ctx.from?.id;
				
				if (userId) {
					const { getUserLanguage } = await import('../../i18n');
					const lang = await getUserLanguage(userId);
					
					// Send the wallet address in a copyable format
					const message = lang === 'zh'
						? `📋 *钱包地址已复制*\n\n\`${walletAddress}\`\n\n_点击上方地址可复制到剪贴板_`
						: `📋 *Wallet Address*\n\n\`${walletAddress}\`\n\n_Tap the address above to copy to clipboard_`;
					
					await ctx.reply(message, { parse_mode: 'Markdown' });
				}
			}
		} catch (error) {
			console.error('Error copying wallet address:', error);
		}
	});


	handleCallback('opbnb_back_to_transactions', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbTransactions } = await import('../menus/opbnb');
			await showOpbnbTransactions(ctx, walletAddress, 'Custom');
		} else {
			// Fallback to transaction history menu
			const { opbnbTransactionHistoryMenu } = await import('../menus/opbnb');
			await opbnbTransactionHistoryMenu(ctx);
		}
	});
	
	// opBNB wallet selection handlers
	handleCallback('opbnb_use_main_wallet', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		const { UserService } = await import('../../services/user');
		const session = global.userSessions.get(userId);
		const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
		
		if (mainWallet) {
			// Store the address in session for detailed views
			if (!session) {
				global.userSessions.set(userId, { opbnbLastScanned: mainWallet });
			} else {
				session.opbnbLastScanned = mainWallet;
				session.waitingForOpbnbAddress = false;
			}
			
			const { scanOpbnbWallet } = await import('../menus/opbnb');
			await scanOpbnbWallet(ctx, mainWallet, 'Main');
		}
	});
	
	handleCallback('opbnb_use_trading_wallet', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		const { UserService } = await import('../../services/user');
		const tradingWallet = await UserService.getTradingWalletAddress(userId);
		
		if (tradingWallet) {
			// Store the address in session for detailed views
			const session = global.userSessions.get(userId) || {};
			session.opbnbLastScanned = tradingWallet;
			session.waitingForOpbnbAddress = false;
			global.userSessions.set(userId, session);
			
			const { scanOpbnbWallet } = await import('../menus/opbnb');
			await scanOpbnbWallet(ctx, tradingWallet, 'Trading');
		}
	});
	
	handleCallback('opbnb_use_both_wallets', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		const { UserService } = await import('../../services/user');
		const session = global.userSessions.get(userId);
		const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
		const tradingWallet = await UserService.getTradingWalletAddress(userId);
		
		if (mainWallet && tradingWallet) {
			const { scanOpbnbWallet } = await import('../menus/opbnb');
			
			// Clear waiting state
			if (session) {
				session.waitingForOpbnbAddress = false;
			}
			
			// Scan both wallets
			await scanOpbnbWallet(ctx, mainWallet, 'Main');
			await scanOpbnbWallet(ctx, tradingWallet, 'Trading');
		}
	});
	
	// Dynamic handlers for direct transaction/holdings viewing
	bot.action(/^opbnb_show_transactions_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const walletAddress = match[1];
				const { showOpbnbTransactions } = await import('../menus/opbnb');
				await showOpbnbTransactions(ctx, walletAddress, 'Custom');
			}
		} catch (error) {
			console.error('Error in opbnb_show_transactions callback:', error);
		}
	});

	bot.action(/^opbnb_show_holdings_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const walletAddress = match[1];
				const { showOpbnbHoldings } = await import('../menus/opbnb');
				await showOpbnbHoldings(ctx, walletAddress, 'Custom');
			}
		} catch (error) {
			console.error('Error in opbnb_show_holdings callback:', error);
		}
	});
	
	// opBNB refresh handler
	bot.action(/^opbnb_refresh_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const walletAddress = match[1];
				const userId = ctx.from?.id;
				if (userId) {
					// Store the address in session for detailed views
					const session = global.userSessions.get(userId) || {};
					session.opbnbLastScanned = walletAddress;
					global.userSessions.set(userId, session);
				}
				
				const { scanOpbnbWallet } = await import('../menus/opbnb');
				await scanOpbnbWallet(ctx, walletAddress, 'Custom');
			}
		} catch (error) {
			logger.error('Error refreshing opBNB data', { error });
			await ctx.answerCbQuery('❌ Error refreshing data');
		}
	});
	handleCallback('add_tracked_token', async (ctx) => {
		const { TokenTrackingService } = await import('../../services/tokenTracking');
		await TokenTrackingService.handleAddToken(ctx);
	});
	handleCallback('manage_tracked_tokens', async (ctx) => {
		const { TokenTrackingService } = await import('../../services/tokenTracking');
		await TokenTrackingService.handleManageTokens(ctx);
	});
	handleCallback('refresh_token_prices', async (ctx) => {
		const { TokenTrackingService } = await import('../../services/tokenTracking');
		await TokenTrackingService.refreshTokenPrices(ctx);
	});

	handleCallback('help', async (ctx) => {
		const helpMessage = await getTranslation(ctx, 'common.helpMessage');
		await ctx.reply(helpMessage);
	});

	handleCallback('close', async (ctx) => {
		await ctx.deleteMessage().catch(() => { });
	});

	// Token-specific trading actions with proper type checking
	bot.action(/^token_buy_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				await tradingService.handleTokenBuy(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in token_buy callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'token_buy_action',
				action: 'token_buy'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^token_sell_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				await tradingService.handleTokenSell(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in token_sell callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'token_sell_action',
				action: 'token_sell'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Quick buy handlers
	bot.action(/^quick_buy_(.+)_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, amount, tokenAddress] = match;
				await tradingService.handleQuickBuy(ctx, amount, tokenAddress);
			}
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error('Error in quick buy callback', { 
				error,
				userId: ctx.from?.id,
				amount: 'quick_buy_amount',
				tokenAddress: 'quick_buy_token',
				action: 'quick_buy'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Quick sell handlers
	bot.action(/^quick_sell_(.+)_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, percentage, tokenAddress] = match;
				await tradingService.handleQuickSell(ctx, parseInt(percentage), tokenAddress);
			}
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error('Error in quick sell callback', { 
				error,
				userId: ctx.from?.id,
				percentage: 'quick_sell_percentage',
				tokenAddress: 'quick_sell_token',
				action: 'quick_sell'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Token removal handler for tracking
	bot.action(/^remove_token_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { TokenTrackingService } = await import('../../services/tokenTracking');
				await TokenTrackingService.handleRemoveToken(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in remove token callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'remove_token_action',
				action: 'remove_token'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// New UI handlers
	bot.action(/^switch_to_buy_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				await tradingService.handleSwitchToBuy(ctx, match[1]);
			}
		} catch (error) {
			logger.error('Error switching to buy', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'switch_to_buy_token',
				action: 'switch_to_buy'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^switch_to_sell_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				await tradingService.handleSwitchToSell(ctx, match[1]);
			}
		} catch (error) {
			logger.error('Error switching to sell', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'switch_to_sell_token',
				action: 'switch_to_sell'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^buy_amount_(.+)_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, amount, tokenAddress] = match;
				await tradingService.handleBuyAmount(ctx, amount, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in buy amount callback', { 
				error,
				userId: ctx.from?.id,
				amount: 'buy_amount_value',
				tokenAddress: 'buy_amount_token',
				action: 'buy_amount'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^sell_percent_(.+)_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, percentage, tokenAddress] = match;
				await tradingService.handleSellPercentage(ctx, percentage, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in sell percent callback', { 
				error,
				userId: ctx.from?.id,
				percentage: 'sell_percent_value',
				tokenAddress: 'sell_percent_token',
				action: 'sell_percent'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^buy_custom_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				await tradingService.handleCustomBuy(ctx, match[1]);
			}
		} catch (error) {
			logger.error('Error in custom buy callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'buy_custom_token',
				action: 'buy_custom'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^sell_custom_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				await tradingService.handleCustomSell(ctx, match[1]);
			}
		} catch (error) {
			logger.error('Error in custom sell callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'sell_custom_token',
				action: 'sell_custom'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Refresh token info
	bot.action(/^refresh_token_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				await tradingService.handleAutoDetectedToken(ctx, tokenAddress);
			}
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error('Error refreshing token', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'refresh_token_address',
				action: 'refresh_token'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorRefreshing');
			await ctx.answerCbQuery(errorMsg);
		}
	});


	// Confirm buy/sell callbacks
	bot.action(/^confirm_buy_(.+)_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, tokenAddress, bnbAmount] = match;
				await tradingService.executeBuy(ctx, tokenAddress, bnbAmount);
			}
		} catch (error) {
			logger.error('Error in confirm buy callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'confirm_buy_token',
				bnbAmount: 'confirm_buy_amount',
				action: 'confirm_buy'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^confirm_sell_(.+)_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const [, percentage, tokenAddress] = match;
				await tradingService.executeSell(ctx, tokenAddress, percentage);
			}
		} catch (error) {
			logger.error('Error in confirm sell callback', { 
				error,
				userId: ctx.from?.id,
				percentage: 'confirm_sell_percentage',
				tokenAddress: 'confirm_sell_token',
				action: 'confirm_sell'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Analytics callbacks for specific addresses
	bot.action(/^history_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const address = match[1];
				await handleWalletHistory(ctx, address);
			}
		} catch (error) {
			logger.error('Error in history callback', { 
				error,
				userId: ctx.from?.id,
				address: 'history_wallet_address',
				action: 'history'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^pnl_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const address = match[1];
				await handleWalletPnL(ctx, address);
			}
		} catch (error) {
			logger.error('Error in PnL callback', { 
				error,
				userId: ctx.from?.id,
				address: 'pnl_wallet_address',
				action: 'pnl'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^refresh_defi_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const address = match[1];
				const scannerService = new ScannerService();
				await scannerService.handleRefreshDeFiPositions(ctx, address);
			}
		} catch (error) {
			logger.error('Error in refresh DeFi callback', { 
				error,
				userId: ctx.from?.id,
				address: 'refresh_defi_address',
				action: 'refresh_defi'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorProcessing');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Token search details callback
	bot.action(/^token_details_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { handleTokenDetails } = await import('../menus/tokenSearch');
				await handleTokenDetails(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in token details callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'token_details_address',
				action: 'token_details'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorLoadingTokenDetails');
			await ctx.answerCbQuery(errorMsg);
		}
	});
	
	// Analyze token callback (reusing existing rug alerts service)
	bot.action(/^analyze_token_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				// Store token address in session for rug alerts service
				const userId = ctx.from!.id;
				const session = global.userSessions.get(userId);
				if (session) {
					if (!session.rugAlerts) session.rugAlerts = {};
					session.rugAlerts.lastAnalyzedToken = tokenAddress;
					global.userSessions.set(userId, session);
				}
				// Use existing rug alerts service to analyze
				await rugAlertsService.analyzeToken(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in analyze token callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'analyze_token_address',
				action: 'analyze_token'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorAnalyzingToken');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Auto-trade callbacks
	bot.action(/^autotrade_rules_(.+)$/, async (ctx) => {
		try {
			await ctx.answerCbQuery();
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.handleAutoTradeMenu(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in auto-trade rules callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'autotrade_rules_token',
				action: 'autotrade_rules'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorLoadingAutoTradeMenu');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^toggle_autotrade_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.toggleAutoTrade(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in toggle auto-trade callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'toggle_autotrade_token',
				action: 'toggle_autotrade'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorTogglingAutoTrade');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^set_entry_rules_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.initiateEntryRuleSetup(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in set entry rules callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'set_entry_rules_token',
				action: 'set_entry_rules'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingUpEntryRules');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^set_take_profit_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.initiateTakeProfitSetup(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in set take profit callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'set_take_profit_token',
				action: 'set_take_profit'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingUpTakeProfit');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^set_stop_loss_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.initiateStopLossSetup(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in set stop loss callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'set_stop_loss_token',
				action: 'set_stop_loss'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingUpStopLoss');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	bot.action(/^clear_autotrade_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.clearAutoTradeRules(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in clear auto-trade callback', { 
				error,
				userId: ctx.from?.id,
				tokenAddress: 'clear_autotrade_token',
				action: 'clear_autotrade'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorClearingAutoTradeRules');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Entry rule preset callbacks
	bot.action(/^entry_preset_(.+)_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1] && match[2]) {
				const tokenAddress = match[1];
				const preset = match[2];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.handleEntryPreset(ctx, tokenAddress, preset);
			}
		} catch (error) {
			logger.error('Error in entry preset callback', { 
				error,
				userId: ctx.from?.id,
				action: 'entry_preset'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingEntryPreset');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Entry amount selection callbacks (simplified)
	bot.action(/^entry_amt_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const amountStr = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				
				if (amountStr === 'custom') {
					// Handle custom amount input
					await AutoTradeMenu.handleCustomEntryAmount(ctx);
				} else {
					// Handle preset amounts
					const amount = parseFloat(amountStr);
					await AutoTradeMenu.handleEntryAmountSelection(ctx, amount);
				}
			}
		} catch (error) {
			logger.error('Error in entry amount callback', { 
				error,
				userId: ctx.from?.id,
				action: 'entry_amt'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingEntryAmount');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Take profit preset callbacks (simplified)
	bot.action(/^tp_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const preset = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				
				if (preset === 'custom') {
					// Handle custom take profit input
					await AutoTradeMenu.handleCustomTakeProfit(ctx);
				} else {
					// Handle preset take profit
					await AutoTradeMenu.handleTakeProfitPreset(ctx, preset);
				}
			}
		} catch (error) {
			logger.error('Error in take profit preset callback', { 
				error,
				userId: ctx.from?.id,
				action: 'tp_preset'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingTakeProfitPreset');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Stop loss preset callbacks (simplified)
	bot.action(/^sl_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const preset = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				
				if (preset === 'custom') {
					// Handle custom stop loss input
					await AutoTradeMenu.handleCustomStopLoss(ctx);
				} else {
					// Handle preset stop loss
					await AutoTradeMenu.handleStopLossPreset(ctx, preset);
				}
			}
		} catch (error) {
			logger.error('Error in stop loss preset callback', { 
				error,
				userId: ctx.from?.id,
				action: 'sl_preset'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingStopLossPreset');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Refresh auto-trade data callback
	bot.action(/^refresh_autotrade_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.refreshAutoTradeData(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in refresh auto-trade callback', { 
				error,
				userId: ctx.from?.id,
				action: 'refresh_autotrade'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorRefreshingData');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Entry custom price callback
	bot.action(/^entry_custom_(.+)$/, async (ctx) => {
		try {
			const match = ctx.match;
			if (match && match[1]) {
				const tokenAddress = match[1];
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				await AutoTradeMenu.handleCustomEntryPrice(ctx, tokenAddress);
			}
		} catch (error) {
			logger.error('Error in entry custom callback', { 
				error,
				userId: ctx.from?.id,
				action: 'entry_custom'
			});
			const errorMsg = await getTranslation(ctx, 'common.errorSettingCustomEntry');
			await ctx.answerCbQuery(errorMsg);
		}
	});

	// Custom address refresh handlers (for refresh button on custom wallet scans)
	handleCallback('opbnb_holdings_custom_address', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbHoldings } = await import('../menus/opbnb');
			await showOpbnbHoldings(ctx, walletAddress, 'Custom');
		} else {
			await ctx.answerCbQuery('Please scan a wallet first', { show_alert: true });
		}
	});
	
	handleCallback('opbnb_transactions_custom_address', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the last scanned address from session
		const session = global.userSessions.get(userId);
		const walletAddress = session?.opbnbLastScanned;
		
		if (walletAddress) {
			const { showOpbnbTransactions } = await import('../menus/opbnb');
			await showOpbnbTransactions(ctx, walletAddress, 'Custom');
		} else {
			await ctx.answerCbQuery('Please scan a wallet first', { show_alert: true });
		}
	});

	// Simplified opBNB navigation handlers using stored session address
	handleCallback('opbnb_show_transactions_stored', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the stored address from session
		const session = global.userSessions.get(userId);
		let walletAddress = session?.opbnbLastScanned;
		
		// Debug logging
		console.log('opbnb_show_transactions_stored - Session state:', {
			userId,
			hasSession: !!session,
			opbnbLastScanned: walletAddress,
			allSessionData: session
		});
		
		// Validate the stored address
		if (!walletAddress || 
		    walletAddress === 'stored' || 
		    walletAddress === 'saved' ||
		    !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
			
			console.error('Invalid stored address detected for transactions:', walletAddress);
			
			// Clear invalid data from session
			if (session && walletAddress === 'stored') {
				delete session.opbnbLastScanned;
				global.userSessions.set(userId, session);
			}
			
			const lang = await getUserLanguage(userId);
			const errorMsg = lang === 'zh' 
				? '❌ 未找到有效的钱包地址\n\n请重新输入地址' 
				: '❌ No valid wallet address found\n\nPlease enter an address again';
			await ctx.answerCbQuery(errorMsg, { show_alert: true });
			
			// Navigate back to check holdings menu
			const { opbnbCheckHoldings } = await import('../menus/opbnb');
			await opbnbCheckHoldings(ctx);
			return;
		}
		
		const { showOpbnbTransactions } = await import('../menus/opbnb');
		
		// Determine wallet type
		const { UserService } = await import('../../services/user');
		const mainWallet = await UserService.getMainWalletAddress(userId);
		const walletType = mainWallet && mainWallet.toLowerCase() === walletAddress.toLowerCase() 
			? 'Main' 
			: 'Custom';
		
		await showOpbnbTransactions(ctx, walletAddress, walletType);
	});

	handleCallback('opbnb_show_holdings_stored', async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		
		// Get the stored address from session
		const session = global.userSessions.get(userId);
		let walletAddress = session?.opbnbLastScanned;
		
		// Debug logging
		console.log('opbnb_show_holdings_stored - Session state:', {
			userId,
			hasSession: !!session,
			opbnbLastScanned: walletAddress,
			sessionKeys: session ? Object.keys(session) : [],
			allSessionData: session
		});
		
		// Validate the stored address
		if (!walletAddress || 
		    walletAddress === 'stored' || 
		    walletAddress === 'saved' ||
		    !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
			
			console.error('Invalid stored address detected:', walletAddress);
			
			// Clear invalid data from session
			if (session && walletAddress === 'stored') {
				delete session.opbnbLastScanned;
				global.userSessions.set(userId, session);
			}
			
			const lang = await getUserLanguage(userId);
			const errorMsg = lang === 'zh' 
				? '❌ 未找到有效的钱包地址\n\n请重新输入地址' 
				: '❌ No valid wallet address found\n\nPlease enter an address again';
			await ctx.answerCbQuery(errorMsg, { show_alert: true });
			
			// Navigate back to transaction history menu
			const { opbnbTransactionHistoryMenu } = await import('../menus/opbnb');
			await opbnbTransactionHistoryMenu(ctx);
			return;
		}
		
		const { showOpbnbHoldings } = await import('../menus/opbnb');
		
		// Determine wallet type
		const { UserService } = await import('../../services/user');
		const mainWallet = await UserService.getMainWalletAddress(userId);
		const walletType = mainWallet && mainWallet.toLowerCase() === walletAddress.toLowerCase() 
			? 'Main' 
			: 'Custom';
		
		await showOpbnbHoldings(ctx, walletAddress, walletType);
	});


}

function requiresWallet(action: string): boolean {
	const walletRequiredActions = [
		// Wallet management actions - these directly need a connected wallet
		'wallet_info', 'disconnect_wallet', 'scan_connected_wallet',
		
		// Transfer actions - require connected wallet for source of funds
		'transfer_menu', 'transfer_to_trading', 'transfer_from_trading',
		'transfer_0.01', 'transfer_0.05', 'transfer_0.1', 'transfer_0.5',
		'transfer_percent_25', 'transfer_percent_50', 'transfer_percent_75', 'transfer_percent_100',
		'transfer_from_0.01', 'transfer_from_0.05', 'transfer_from_0.1', 'transfer_from_0.5',
		'transfer_from_percent_25', 'transfer_from_percent_50', 'transfer_from_percent_75', 'transfer_from_percent_100',
		'transfer_custom_to_trading', 'transfer_custom_from_trading',
		
		// Trading actions - require wallet for transactions
		'confirm_trade',
		'amount_0.1', 'amount_0.5', 'amount_1', 'amount_5',
		'percent_25', 'percent_50', 'percent_75', 'percent_100'
		
		// Removed: wallet_analytics, wallet_history, wallet_pnl, wallet_scan, yield_tips
		// These can prompt for wallet connection or allow manual address input
	];

	return walletRequiredActions.includes(action);
}