import { Context } from 'telegraf';
import { ScannerService } from '../../services/wallet/scanner';
import { getTranslation } from '@/i18n';
import { createLogger } from '@/utils/logger';

const logger = createLogger('telegram.menus.walletScan');

export async function handleWalletScanMenu(ctx: Context, scannerService: ScannerService) {
	const userId = ctx.from!.id;
	logger.info('User initiated wallet scan', { userId });

	// Import UserService to get wallet addresses
	const { UserService } = await import('../../services/user');
	const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

	const session = global.userSessions.get(userId);
	
	// Check session first, then database (same as main menu)
	const mainWalletAddress = session?.address || await UserService.getMainWalletAddress(userId);
	
	// If address found in database but not in session, sync it to session
	if (mainWalletAddress && session && !session.address) {
		session.address = mainWalletAddress;
	}
	
	logger.info('Current session state', {
		userId,
		hasSession: !!session,
		waitingForWalletInput: session?.waitingForWalletInput,
		hasAddress: !!mainWalletAddress
	});

	try {
		// Set waiting input state
		if (!session) {
			logger.info('Creating new session', { userId });
			global.userSessions.set(userId, {
				client: null as any,
				waitingForWalletInput: true
			});
		} else {
			logger.info('Updating existing session', { userId });
			
			// Clear all other waiting states to avoid conflicts
			delete session.waitingForWalletAddress;
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
			session.waitingForWalletInput = true;
		}

		// Build keyboard based on wallet status
		const keyboardRows = [];
		
		// Main wallet button
		if (mainWalletAddress) {
			keyboardRows.push([{ text: await getTranslation(ctx, 'walletScan.useMainWallet'), callback_data: 'scan_connected_wallet' }]);
		} else {
			keyboardRows.push([{ text: await getTranslation(ctx, 'walletScan.connectMainWallet'), callback_data: 'connect_wallet' }]);
		}
		
		// Trading wallet button
		if (tradingWalletAddress) {
			keyboardRows.push([{ text: await getTranslation(ctx, 'walletScan.useTradingWallet'), callback_data: 'scan_trading_wallet' }]);
		}
		
		// Both wallets button - only show if both wallets exist
		if (mainWalletAddress && tradingWalletAddress) {
			keyboardRows.push([{ text: await getTranslation(ctx, 'walletScan.useBothWallets'), callback_data: 'scan_both_wallets' }]);
		}
		
		// Back button
		keyboardRows.push([{ text: await getTranslation(ctx, 'walletScan.backToMenu'), callback_data: 'start_edit' }]);

		const keyboard = {
			inline_keyboard: keyboardRows
		};

		logger.info('Attempting to send message', { userId });

		// Try to delete the previous message first
		try {
			await ctx.deleteMessage().catch((error: Error) => {
				logger.info('Could not delete previous message', { userId, error: error.message });
			});
		} catch (error) {
			logger.error('Error deleting message', { userId, error });
		}

		// Build message using translations
		const title = await getTranslation(ctx, 'walletScan.title');
		const enterAddress = await getTranslation(ctx, 'walletScan.enterAddress');
		const example = await getTranslation(ctx, 'walletScan.example');
		const orUseWallet = await getTranslation(ctx, 'walletScan.orUseWallet');
		
		const messageText = `${title}\n\n${enterAddress}\n\n${example} \`0x1234567890123456789012345678901234567890\`\n\n${orUseWallet}`;

		// Send new message using reply
		const message = await ctx.reply(
			messageText,
			{
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			}
		);

		logger.info('Successfully sent message', { userId, messageId: message.message_id });

	} catch (error) {
		logger.error('Error sending message', { userId, error });

		// Try to send error message to user
		try {
			const errorMessage = await getTranslation(ctx, 'walletScan.errorMessage');
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply(errorMessage, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'wallet_scan' }]
					]
				}
			});
		} catch (e) {
			logger.error('Failed to send error message', { userId, error: e });
		}
	}
}

export async function handleScanConnectedWallet(ctx: Context, scannerService: ScannerService) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);
	
	// Import UserService to check database
	const { UserService } = await import('../../services/user');
	
	// Check session first, then database (same as menu)
	const mainWalletAddress = session?.address || await UserService.getMainWalletAddress(userId);

	if (!mainWalletAddress) {
		const message = await getTranslation(ctx, 'walletScan.connectWalletFirst');
		await ctx.answerCbQuery(message);
		return;
	}
	
	// If address found in database but not in session, sync it to session
	if (mainWalletAddress && session && !session.address) {
		session.address = mainWalletAddress;
	}

	// Clear waiting input state
	if (session) {
		session.waitingForWalletInput = false;
	}

	await scannerService.handleWalletInput(ctx, mainWalletAddress);
}

export async function handleScanTradingWallet(ctx: Context, scannerService: ScannerService) {
	const userId = ctx.from!.id;
	
	// Import UserService to get trading wallet
	const { UserService } = await import('../../services/user');
	const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

	if (!tradingWalletAddress) {
		const message = await getTranslation(ctx, 'walletScan.tradingWalletNotFound');
		await ctx.answerCbQuery(message);
		return;
	}

	// Clear waiting input state  
	const session = global.userSessions.get(userId);
	if (session) {
		session.waitingForWalletInput = false;
	}

	await scannerService.handleWalletInput(ctx, tradingWalletAddress);
}

export async function handleScanBothWallets(ctx: Context, scannerService: ScannerService) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);
	
	// Import UserService to get both wallet addresses
	const { UserService } = await import('../../services/user');
	const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
	
	// Check session first, then database (same as menu)
	const mainWalletAddress = session?.address || await UserService.getMainWalletAddress(userId);

	if (!mainWalletAddress || !tradingWalletAddress) {
		const message = await getTranslation(ctx, 'walletScan.bothWalletsRequired');
		await ctx.answerCbQuery(message);
		return;
	}
	
	// If address found in database but not in session, sync it to session
	if (mainWalletAddress && session && !session.address) {
		session.address = mainWalletAddress;
	}

	// Clear waiting input state
	if (session) {
		session.waitingForWalletInput = false;
	}

	// Scan both wallets
	await scannerService.handleMultipleWallets(ctx, [mainWalletAddress, tradingWalletAddress]);
}