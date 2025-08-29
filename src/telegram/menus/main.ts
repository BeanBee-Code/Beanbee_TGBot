import { Markup, Context } from "telegraf"
import { formatBNBBalance, formatUSDValue } from '../../services/wallet/balance';
import { getUserLanguage, t } from '../../i18n';
import { HONEY_COSTS, KeeperService } from '../../services/keeper';
import { HoneyFeature } from '../../database/models/HoneyTransaction';

interface WalletInfo {
	mainWallet?: string;
	tradingWallet?: string;
	mainBalance?: string;
	tradingBalance?: string;
	bnbPrice?: number;
	userName?: string | null;
}

async function getMainMenu(walletInfo: WalletInfo, telegramId: number) {
	const { mainWallet, tradingWallet, mainBalance = '0', tradingBalance = '0', bnbPrice = 0, userName } = walletInfo;
	const lang = await getUserLanguage(telegramId);
	
	// Get keeper status and badge
	const keeperStatus = await KeeperService.getKeeperStatus(telegramId);
	const roleInfo = keeperStatus.role ? KeeperService.getRoleInfo(keeperStatus.role) : null;
	const badge = await KeeperService.getUserBadge(telegramId);
	
	// Calculate total balance
	const totalBalance = (parseFloat(mainBalance) + parseFloat(tradingBalance)).toString();
	
	// Calculate USD values
	const mainUSD = parseFloat(mainBalance) * bnbPrice;
	const tradingUSD = parseFloat(tradingBalance) * bnbPrice;
	const totalUSD = parseFloat(totalBalance) * bnbPrice;
	
	// Include badge in welcome message - only if wallet is connected
	const welcomeMessage = userName 
		? (lang === 'zh' ? `👋 *欢迎回来，${userName}！* ${mainWallet ? badge : ''}` : `👋 *Welcome back, ${userName}!* ${mainWallet ? badge : ''}`)
		: t(lang, 'mainMenu.welcome');
	
	// Build keeper status line - show for all keepers regardless of wallet connection
	let keeperStatusLine = '';
	if (keeperStatus.isKeeper && roleInfo) {
		const isZh = lang === 'zh';
		keeperStatusLine = `\n${isZh ? '身份' : 'Role'}: ${roleInfo.emoji} *${isZh ? roleInfo.nameCn : roleInfo.name}* | 🍯 ${isZh ? '蜂蜜' : 'Honey'}: *${keeperStatus.dailyHoney || 0}*\n`;
	}

	const message = `${welcomeMessage}${keeperStatusLine}

${bnbPrice > 0 ? `${t(lang, 'mainMenu.bnbPrice')} ${formatUSDValue(bnbPrice)}` : ''} 

${t(lang, 'mainMenu.wallets')}
${mainWallet ? `• *${t(lang, 'mainMenu.main')}*: \`${mainWallet}\`\n  └ ${formatBNBBalance(mainBalance)} BNB (${formatUSDValue(mainUSD)})` : `• ${t(lang, 'mainMenu.main')}: ${t(lang, 'mainMenu.notConnected')}`}
${tradingWallet ? `• *${t(lang, 'mainMenu.trading')}*: \`${tradingWallet}\`\n  └ ${formatBNBBalance(tradingBalance)} BNB (${formatUSDValue(tradingUSD)})` : `• ${t(lang, 'mainMenu.trading')}: ${t(lang, 'mainMenu.notCreated')}`}

${t(lang, 'mainMenu.totalBalance')} ${formatBNBBalance(totalBalance)} BNB (${formatUSDValue(totalUSD)})

${t(lang, 'mainMenu.description')}`

	const connectWalletButton = mainWallet
		? Markup.button.callback(t(lang, 'mainMenu.walletInfo'), 'wallet_info')
		: Markup.button.callback(t(lang, 'mainMenu.connectMainWallet'), 'connect_wallet')

	// Always show account button so users can view their role
	const accountButton = { text: lang === 'zh' ? '🐝 账户面板' : '🐝 Account Panel', callback_data: 'account_menu' };
	const claimHoneyButton = { text: lang === 'zh' ? '🍯 领取蜂蜜' : '🍯 Claim Honey', callback_data: 'claim_honey' };

	const keyboard = {
		inline_keyboard: [
			[connectWalletButton],
			[accountButton, claimHoneyButton],
		// Honey-consuming features first
		[
			Markup.button.callback(
				`${t(lang, 'mainMenu.walletScan')} 🍯`, 
				'wallet_scan'
			), 
			Markup.button.callback(
				`${t(lang, 'mainMenu.rugAlerts')} 🍯`, 
				'rug_alerts'
			)
		],
		[
			Markup.button.callback(
				`${t(lang, 'mainMenu.yieldTips')} 🍯`, 
				'yield_tips'
			),
			Markup.button.callback(
				`${t(lang, 'mainMenu.marketSentiment')} 🍯`, 
				'market_sentiment'
			)
		],
		// Free features below
		[
			Markup.button.callback(t(lang, 'mainMenu.buySell'), 'buy_sell'),
			Markup.button.callback(t(lang, 'mainMenu.todaysPick'), 'todays_pick')
		],
		[
			Markup.button.callback(t(lang, 'mainMenu.trackWallet'), 'track_wallet'),
			Markup.button.callback(t(lang, 'mainMenu.trackToken'), 'track_token')
		],
		[
			Markup.button.callback(t(lang, 'mainMenu.tokenSearch'), 'token_search'),
			Markup.button.callback(lang === 'zh' ? '🎯 推荐系统' : '🎯 Referral System', 'referral_menu')
		],
		[
			Markup.button.callback(lang === 'zh' ? '🔗 opBNB 控制台' : '🔗 opBNB Dashboard', 'opbnb_dashboard'),
			Markup.button.callback(t(lang, 'mainMenu.settings'), 'settings')
		]
	]
}

	return {
		message,
		keyboard
	}
}

export async function mainMenu(ctx: Context) {
	const userId = ctx.from?.id;
	if (!userId) return;
	
	// Import services
	const { UserService } = await import('../../services/user');
	const { getMultipleBNBBalances, getBNBPrice } = await import('../../services/wallet/balance');
	
	// Get wallet addresses and user name
	// @ts-ignore - userSessions is defined globally
	const session = global.userSessions?.get(userId);
	// Check session first, then database
	const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
	const tradingWallet = await UserService.getTradingWalletAddress(userId);
	const userName = await UserService.getUserName(userId);
	
	// Prepare addresses to fetch balances
	const addressesToFetch = [];
	if (mainWallet) addressesToFetch.push(mainWallet);
	if (tradingWallet) addressesToFetch.push(tradingWallet);
	
	// Fetch balances and BNB price
	let balances: { [address: string]: string } = {};
	let bnbPrice = 0;
	
	if (addressesToFetch.length > 0) {
		// Fetch balances and price in parallel
		[balances, bnbPrice] = await Promise.all([
			getMultipleBNBBalances(addressesToFetch),
			getBNBPrice()
		]);
	}
	
	const walletInfo = {
		mainWallet,
		tradingWallet: tradingWallet || undefined,
		mainBalance: mainWallet ? balances[mainWallet] : '0',
		tradingBalance: tradingWallet ? balances[tradingWallet] : '0',
		bnbPrice,
		userName
	};
	
	const { message, keyboard } = await getMainMenu(walletInfo, userId);
	await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

export async function mainMenuEdit(ctx: Context) {
	const userId = ctx.from?.id;
	if (!userId) return;
	
	// Import services
	const { UserService } = await import('../../services/user');
	const { getMultipleBNBBalances, getBNBPrice } = await import('../../services/wallet/balance');
	
	// Get wallet addresses and user name
	// @ts-ignore - userSessions is defined globally
	const session = global.userSessions?.get(userId);
	// Check session first, then database
	const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
	const tradingWallet = await UserService.getTradingWalletAddress(userId);
	const userName = await UserService.getUserName(userId);
	
	// Prepare addresses to fetch balances
	const addressesToFetch = [];
	if (mainWallet) addressesToFetch.push(mainWallet);
	if (tradingWallet) addressesToFetch.push(tradingWallet);
	
	// Fetch balances and BNB price
	let balances: { [address: string]: string } = {};
	let bnbPrice = 0;
	
	if (addressesToFetch.length > 0) {
		// Fetch balances and price in parallel
		[balances, bnbPrice] = await Promise.all([
			getMultipleBNBBalances(addressesToFetch),
			getBNBPrice()
		]);
	}
	
	const walletInfo = {
		mainWallet,
		tradingWallet: tradingWallet || undefined,
		mainBalance: mainWallet ? balances[mainWallet] : '0',
		tradingBalance: tradingWallet ? balances[tradingWallet] : '0',
		bnbPrice,
		userName
	};
	
	const { message, keyboard } = await getMainMenu(walletInfo, userId);
	await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: 'Markdown' });
}