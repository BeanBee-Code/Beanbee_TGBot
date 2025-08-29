import { Context } from 'telegraf';
import { TradingService } from '../../services/trading';
import { getTranslation } from '@/i18n';

export async function handleBuySellMenu(ctx: Context, tradingService: TradingService) {
	const backText = await getTranslation(ctx, 'trading.back');
	const keyboard = {
		inline_keyboard: [
			[{ text: backText, callback_data: 'start_edit' }]
		]
	};

	const title = await getTranslation(ctx, 'trading.title');
	const enterAddress = await getTranslation(ctx, 'trading.enterAddress');
	const example = await getTranslation(ctx, 'trading.example');
	const cakeExample = await getTranslation(ctx, 'trading.cakeExample');
	const important = await getTranslation(ctx, 'trading.important');
	const verifyContracts = await getTranslation(ctx, 'trading.verifyContracts');
	const connectWallet = await getTranslation(ctx, 'trading.connectWallet');
	const autoDetect = await getTranslation(ctx, 'trading.autoDetect');

	const message = `${title}

${enterAddress}

${example} \`0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82\` ${cakeExample}

${important}
${verifyContracts}
${connectWallet}
${autoDetect}`;

	await ctx.editMessageText(message, {
		reply_markup: keyboard,
		parse_mode: 'Markdown'
	});

	// Set the user session to wait for token input
	const userId = ctx.from!.id;
	let session = global.userSessions.get(userId);
	
	// Create session if it doesn't exist
	if (!session) {
		session = {
			client: null as any,
			trading: { waitingForTokenInput: true }
		};
		global.userSessions.set(userId, session);
	} else {
		// Clear all other waiting states to avoid conflicts
		delete session.waitingForWalletInput;
		delete session.waitingForWalletAddress;
		delete session.waitingForTokenAddress;
		delete session.waitingForTokenSearchInput;
		if (session.rugAlerts) {
			delete session.rugAlerts.waitingForTokenInput;
		}
		if (session.transfer) {
			delete session.transfer.waitingForAmountInput;
		}
		if (session.autoTradeSetup) {
			delete session.autoTradeSetup.waitingForInput;
		}
		
		if (!session.trading) session.trading = {};
		session.trading.waitingForTokenInput = true;
	}
}