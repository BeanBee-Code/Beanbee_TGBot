import { Context } from "telegraf";
import { WalletHistoryService } from "../../services/wallet/history";
import { EnhancedWalletHistoryService } from "../../services/wallet/enhancedHistory";
import { CustomPnLService } from "../../services/wallet/customPnL";
import { PNLCalculatorService } from "../../services/pnlCalculator";
import { getTranslation } from "@/i18n";
import { createLogger } from '@/utils/logger';

const logger = createLogger('telegram.menus.analytics');

const historyService = new WalletHistoryService();
const enhancedHistoryService = new EnhancedWalletHistoryService();
const customPnLService = new CustomPnLService();

/**
 * Handles the wallet analytics menu display
 * Shows options for viewing transaction history and PnL analysis
 */
export async function handleWalletAnalytics(ctx: Context) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);

	if (!session?.address) {
		const backButtonText = await getTranslation(ctx, 'common.back');
		await ctx.reply("🔗 Please connect your wallet first to view analytics.", {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
		return;
	}

	const keyboard = {
		inline_keyboard: [
			[
				{ text: "📜 Transaction History", callback_data: "wallet_history" },
				{ text: "📊 PnL Analysis", callback_data: "wallet_pnl" },
			],
			[{ text: "🔙 Back to Menu", callback_data: "start_edit" }],
		],
	};

	await ctx.editMessageText(
		`📈 *Wallet Analytics*\n\n` +
		`Connected Wallet: \`${session.address}\`\n\n` +
		`Choose what you'd like to analyze:`,
		{
			reply_markup: keyboard,
			parse_mode: "Markdown",
		},
	);
}

/**
 * Handles the transaction history request
 * Fetches and displays the wallet's transaction history
 * @param ctx - Telegram context
 * @param providedAddress - Optional wallet address to check (if not provided, uses connected wallet)
 */
export async function handleWalletHistory(ctx: Context, providedAddress?: string) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);

	// Use provided address or fall back to connected wallet
	const walletAddress = providedAddress || session?.address;
	logger.info('Using wallet address for history', { walletAddress, providedAddress });

	if (!walletAddress) {
		if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
			await ctx.answerCbQuery("Please connect your wallet first");
		}
		return;
	}

	try {
		// Check if this is a callback query context
		if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
			await ctx.answerCbQuery().catch(() => {});
		}
		const fetchingMsg = await getTranslation(ctx, 'transactionHistory.fetchingHistory');
		await ctx.reply(fetchingMsg);

		const historyData = await enhancedHistoryService.getFilteredWalletHistory(walletAddress, { limit: 10 });
		const telegramId = ctx.from!.id;
		const message = await enhancedHistoryService.formatHistoryMessage(historyData, walletAddress, telegramId);

		const backButtonText = await getTranslation(ctx, 'common.back');
		await ctx.reply(message, { 
			parse_mode: "Markdown",
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
	} catch (error) {
		logger.error('Error fetching wallet history', { walletAddress, error: error instanceof Error ? error.message : String(error) });
		const errorMsg = await getTranslation(ctx, 'transactionHistory.errorFetching');
		const backButtonText = await getTranslation(ctx, 'common.back');
		await ctx.reply(errorMsg, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
	}
}

/**
 * Handles the PnL analysis request using custom calculation
 * Calculates 7-day PnL using on-chain data
 * @param ctx - Telegram context
 * @param providedAddress - Optional wallet address to check (if not provided, uses connected wallet)
 */
export async function handleWalletPnL(ctx: Context, providedAddress?: string) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);

	// Use provided address or fall back to connected wallet
	const walletAddress = providedAddress || session?.address;

	if (!walletAddress) {
		if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
			await ctx.answerCbQuery("Please connect your wallet first");
		}
		return;
	}

	try {
		// Check if this is a callback query context
		if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
			await ctx.answerCbQuery().catch(() => {});
		}

		const calculatingMsg = await getTranslation(ctx, 'pnlAnalysis.calculating');
		await ctx.reply(calculatingMsg);

		// Calculate PNL
		const pnlData = await PNLCalculatorService.calculatePNL(walletAddress);
		
		// Format and send the message
		const telegramId = ctx.from!.id;
		const message = await PNLCalculatorService.formatPNLForDisplay(pnlData, telegramId);
		const backButtonText = await getTranslation(ctx, 'common.back');
		await ctx.reply(message, { 
			parse_mode: "Markdown",
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});

	} catch (error) {
		logger.error('Error in PnL handler', { userId, error: error instanceof Error ? error.message : String(error) });
		const errorMsg = await getTranslation(ctx, 'pnlAnalysis.errorCalculating');
		const backButtonText = await getTranslation(ctx, 'common.back');
		await ctx.reply(errorMsg, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
	}
} 