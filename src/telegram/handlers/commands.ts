import { Telegraf, Context } from 'telegraf';
import { WalletService } from '../../services/wallet/connect';
import { mainMenu } from '../menus/main';
import { settingsMenu } from '../menus/settings';
import { UserService } from '../../services/user';
import { generateWallet, encryptPrivateKey } from '../../services/wallet/tradingWallet';
import { handleYieldTips } from './yieldTips';
import { UserModel } from '../../database/models/User';
import { KeeperService, HONEY_REWARDS } from '../../services/keeper';
import { HoneyTransactionType } from '../../database/models/HoneyTransaction';

export function setupCommands(bot: Telegraf, walletService: WalletService) {
	bot.command('start', async (ctx: Context) => {
		const userId = ctx.from!.id;

		// Handle referral deep links
		const startPayload = (ctx.message as any)?.text?.substring(7) || '';
		if (startPayload.startsWith('ref_')) {
			const referralCode = startPayload.substring(4);
			await processReferralLink(ctx, referralCode);
		}

		// Check if this is a new user
		const user = await UserService.findOrCreateUser(userId);
		
		// Check for daily login reward if user is a keeper
		if (user.isKeeper) {
			const lastActiveDate = user.lastActiveDate;
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			
			if (!lastActiveDate || lastActiveDate < today) {
				// Give daily login reward
				await KeeperService.rewardHoney(
					userId,
					HONEY_REWARDS.DAILY_LOGIN,
					HoneyTransactionType.TASK_REWARD,
					'Daily login bonus'
				);
			}
			
			// Update activity streak
			await KeeperService.updateActivityStreak(userId);
		}
		
		// If user doesn't have a name and hasn't chosen to be anonymous, start onboarding
		if (!user.name && !user.hasChosenAnonymous) {
			// Initialize session for onboarding
			const session = global.userSessions.get(userId);
			if (!session) {
				// Initialize basic session
				const { WalletService } = await import('../../services/wallet/connect');
				const walletService = new WalletService(global.userSessions);
				await walletService.initializeConnection(userId);
			}
			
			// Show language selection first
			await ctx.reply(
				'👋 Welcome to BeanBee!\n欢迎使用 BeanBee！\n\n' +
				'Please select your preferred language:\n请选择您的语言偏好：',
				{
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '🇬🇧 English', callback_data: 'onboarding_language:en' },
								{ text: '🇨🇳 中文', callback_data: 'onboarding_language:zh' }
							]
						]
					}
				}
			);
			return;
		}
		
		// If user doesn't have a trading wallet, show onboarding
		if (!user.tradingWalletAddress) {
			// Import required functions
			const { getUserLanguage } = await import('../../i18n');
			const userLanguage = await getUserLanguage(userId);
			
			// Generate trading wallet
			const { address, privateKey } = generateWallet();
			const { encrypted, iv } = encryptPrivateKey(privateKey);
			
			// Save to database
			await UserService.updateTradingWallet(userId, address, encrypted, iv);
			
			// Show onboarding with private key in user's language
			const onboardingText = userLanguage === 'zh' ?
				`🎉 *欢迎回来，${user.name}！*\n\n` +
				'我已为您创建了一个交易钱包，用于自主执行交易。\n\n' +
				'⚠️ *重要提示：请立即保存您的私钥！*\n' +
				'您只能查看它一次。\n\n' +
				`🔑 *私钥：*\n\`${privateKey}\`\n\n` +
				`📍 *钱包地址：*\n\`${address}\`\n\n` +
				'💡 *提示：*\n' +
				'• 将此密钥保存在安全的密码管理器中\n' +
				'• 绝不要与任何人分享\n' +
				'• 为此钱包充值以开始交易\n\n' +
				'保存密钥后请点击"继续"。' :
				`🎉 *Welcome back, ${user.name}!*\n\n` +
				'I\'ve created a trading wallet for you to execute trades autonomously.\n\n' +
				'⚠️ *IMPORTANT: Save your private key NOW!*\n' +
				'You can only view it this ONE time.\n\n' +
				`🔑 *Private Key:*\n\`${privateKey}\`\n\n` +
				`📍 *Wallet Address:*\n\`${address}\`\n\n` +
				'💡 *Tips:*\n' +
				'• Save this key in a secure password manager\n' +
				'• Never share it with anyone\n' +
				'• Fund this wallet to start trading\n\n' +
				'Press "Continue" when you\'ve saved your key.';
			
			const continueButtonText = userLanguage === 'zh' ? 
				'✅ 继续（我已保存密钥）' : 
				'✅ Continue (I\'ve saved my key)';
			
			await ctx.reply(
				onboardingText,
				{
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[{ text: continueButtonText, callback_data: 'onboarding_complete' }]
						]
					}
				}
			);
			
			// Mark key as exported immediately
			await UserService.markPrivateKeyAsExported(userId);
			
		} else {
			// Existing user - show main menu (don't initialize wallet unless needed)
			mainMenu(ctx);
		}
	});

	bot.command('settings', settingsMenu);
	
	bot.command('yieldtips', (ctx) => handleYieldTips(ctx, false));
	bot.command('yield', (ctx) => handleYieldTips(ctx, false));
	
	bot.command('search', async (ctx) => {
		const { handleTokenSearchMenu } = await import('../menus/tokenSearch');
		await handleTokenSearchMenu(ctx);
	});
	
	// Test command for daily summary (for development/testing)
	bot.command('testsummary', async (ctx) => {
		const { handleTestSummary } = await import('../commands/testSummary');
		await handleTestSummary(ctx);
	});
	
	// Clear news cache command (for development/testing)
	bot.command('clearnewscache', async (ctx) => {
		const { handleClearNewsCache } = await import('../commands/clearNewsCache');
		await handleClearNewsCache(ctx);
	});
	
}

async function processReferralLink(ctx: Context, referralCode: string) {
	const userId = ctx.from?.id;
	if (!userId) return;

	try {
		const user = await UserModel.findOne({ telegramId: userId });
		const referrer = await UserModel.findOne({ referralCode });

		if (!referrer) {
			// Referral code doesn't exist, continue silently
			return;
		}

		if (!user) {
			// New user - create with referrer
			const newUser = new UserModel({
				telegramId: userId,
				name: ctx.from?.username || ctx.from?.first_name || 'Unknown User',
				referrer: referrer._id,
			});
			await newUser.save();
		} else if (!user.referrer) {
			// Existing user without referrer - set referrer
			user.referrer = referrer._id;
			await user.save();
			
			// Update referrer's active referral count if this is a keeper
			if (referrer && user.walletAddress) {
				const { KeeperService } = await import('../../services/keeper');
				await KeeperService.updateActiveReferrals(referrer.telegramId);
			}
		}
		// If user already has a referrer, do nothing
	} catch (error) {
		// Log error but don't interrupt the start flow
		console.error('Error processing referral link:', error);
	}
}