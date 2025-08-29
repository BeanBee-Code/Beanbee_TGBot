import { Telegraf, Context } from 'telegraf';
import { ScannerService } from '../../services/wallet/scanner';
import { TradingService } from '../../services/trading';
import { RugAlertsService } from '../../services/rugAlerts';
import { TransferService } from '../../services/wallet/transfer';
import { geminiAI } from '../../services/ai/geminiService';
import { UserService } from '../../services/user';
import { generateWallet, encryptPrivateKey } from '../../services/wallet/tradingWallet';
import { createLogger } from '@/utils/logger';
import { getUserLanguage, getTranslation } from '@/i18n';
import { sanitizeMarkdown } from '@/utils/markdown';
import { parseHoneyCommand, executeHoneyCommand } from '../parsers/honeyCommands';
import { checkHoneyAndProceed } from '../helpers/honeyCheck';
import { HoneyFeature } from '@/database/models/HoneyTransaction';

const logger = createLogger('telegram.messages');


export function setupMessages(
	bot: Telegraf, 
	scannerService: ScannerService, 
	tradingService: TradingService,
	rugAlertsService: RugAlertsService
) {
	const transferService = new TransferService();
	bot.on('text', async (ctx: Context) => {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		const text = (ctx.message as any).text;

		try {
			// Check if waiting for name input
			if (session?.waitingForName) {
				await handleNameInput(ctx, text, session);
				return;
			}
			
			// Check if waiting for name change input
			if (session?.waitingForNameChange) {
				await handleNameChangeInput(ctx, text, session);
				return;
			}

			// Check if waiting for referral code input
			if (session?.waitingForReferralCode) {
				const { processRedeemCode } = await import('../menus/referral');
				await processRedeemCode(ctx, text);
				return;
			}

			// Check for referral management custom amounts
			if (session?.referralManagement?.isWaitingForConvertAmount) {
				session.referralManagement.isWaitingForConvertAmount = false;
				global.userSessions.set(userId, session);

				const { UserModel } = await import('@/database/models/User');
				const { ReferralService } = await import('@/services/referralService');
				const user = await UserModel.findOne({ telegramId: userId });
				if (user) {
					const result = await ReferralService.convertReferralBNBToHoney(user, text);
					await ctx.reply(result.message);
					if (result.success && result.honeyAdded) {
						await ctx.reply(`✨ You received ${result.honeyAdded.toLocaleString()} 🍯 Honey!`);
					}
					const { handleReferralMenu } = await import('../menus/referral');
					await handleReferralMenu(ctx);
				}
				return;
			}

			if (session?.referralManagement?.isWaitingForWithdrawAmount) {
				session.referralManagement.isWaitingForWithdrawAmount = false;
				global.userSessions.set(userId, session);

				const { UserModel } = await import('@/database/models/User');
				const { ReferralService } = await import('@/services/referralService');
				const user = await UserModel.findOne({ telegramId: userId });
				if (user) {
					await ctx.reply('🔄 Processing withdrawal...');
					const result = await ReferralService.withdrawReferralBNB(user, text);
					await ctx.reply(result.message + (result.txHash ? `\n\n🔗 Transaction: \`${result.txHash}\`` : ''), { parse_mode: 'Markdown' });
					const { handleReferralMenu } = await import('../menus/referral');
					await handleReferralMenu(ctx);
				}
				return;
			}

			// Check if existing user doesn't have a name (and not a command)
			if (!text.startsWith('/')) {
				const user = await UserService.findOrCreateUser(userId);
				if (!user.name && !user.hasChosenAnonymous && !session?.skipNamePrompt) {
					// Initialize session if needed
					let currentSession = session;
					if (!currentSession) {
						const { WalletService } = await import('../../services/wallet/connect');
						const walletService = new WalletService(global.userSessions);
						await walletService.initializeConnection(userId);
						currentSession = global.userSessions.get(userId);
					}
					
					if (currentSession) {
						// Set flag to track we're waiting for name
						currentSession.waitingForName = true;
						currentSession.skipNamePrompt = false;
						global.userSessions.set(userId, currentSession);
						
						await ctx.reply(
							'👋 I noticed you haven\'t set a name yet!\n\n' +
							'What would you like me to call you?\n\n' +
							'Please type your name below:',
							{
								parse_mode: 'Markdown',
								reply_markup: {
									inline_keyboard: [
										[{ text: '🕵️ Stay Anonymous', callback_data: 'skip_name' }]
									]
								}
							}
						);
						return;
					}
				}
			}

			// Check if waiting for wallet address input
			if (session?.waitingForWalletInput) {
				await scannerService.handleWalletInput(ctx, text);
				return;
			}

			// Check if waiting for token address input (trading)
			if (session?.trading?.waitingForTokenInput) {
				await tradingService.handleTokenInput(ctx, text);
				return;
			}

			// Check if waiting for amount input (trading)
			if (session?.trading?.waitingForAmountInput) {
				await tradingService.handleAmountInput(ctx, text);
				return;
			}

			// Check if waiting for wallet address input (tracking) - higher priority
			if (session?.waitingForWalletAddress) {
				const { WalletTrackingService } = await import('../../services/walletTracking');
				await WalletTrackingService.handleWalletAddressInput(ctx, text);
				return;
			}

			// Check if waiting for opBNB token address for analysis
			if (session?.waitingForOpbnbTokenAddress) {
				const tokenAddress = text.trim();
				
				// Clear waiting state
				session.waitingForOpbnbTokenAddress = false;
				global.userSessions.set(userId, session);
				
				// Analyze the token
				const { analyzeOpbnbToken } = await import('../menus/opbnb');
				await analyzeOpbnbToken(ctx, tokenAddress);
				return;
			}
			
			// Check if waiting for opBNB whale tracker token address
			if (session?.waitingForOpbnbWhaleToken) {
				const tokenAddress = text.trim();
				
				// Clear waiting state
				session.waitingForOpbnbWhaleToken = false;
				global.userSessions.set(userId, session);
				
				// Show whale tracking
				const { showWhaleTracking } = await import('../menus/opbnb');
				await showWhaleTracking(ctx, tokenAddress);
				return;
			}
			
			// Check if waiting for opBNB health check token address
			if (session?.waitingForOpbnbHealthToken) {
				const tokenAddress = text.trim();
				
				// Clear waiting state
				session.waitingForOpbnbHealthToken = false;
				global.userSessions.set(userId, session);
				
				// Show token health check
				const { showTokenHealthCheck } = await import('../menus/opbnb');
				await showTokenHealthCheck(ctx, tokenAddress);
				return;
			}

			// Check if waiting for opBNB address input
			if (session?.waitingForOpbnbAddress) {
				// Get the trimmed address
				const address = text.trim();
				const addressLower = address.toLowerCase();
				
				// Debug logging
				console.log('opBNB address input received:', { 
					userId, 
					inputText: text,
					trimmedAddress: address,
					action: session.opbnbAction 
				});
				
				// Check if user typed "stored" or similar keywords
				if (addressLower === 'stored' || addressLower === 'saved' || addressLower === 'last' || addressLower === 'previous') {
					const lang = await getUserLanguage(userId);
					const lastScanned = session.opbnbLastScanned;
					
					if (lastScanned && lastScanned !== 'stored' && /^0x[a-fA-F0-9]{40}$/i.test(lastScanned)) {
						// Use the last scanned address
						session.waitingForOpbnbAddress = false;
						global.userSessions.set(userId, session);
						
						const action = session.opbnbAction;
						if (action === 'holdings') {
							const { showOpbnbHoldings } = await import('../menus/opbnb');
							await showOpbnbHoldings(ctx, lastScanned, 'Custom');
						} else if (action === 'transactions') {
							const { showOpbnbTransactions } = await import('../menus/opbnb');
							await showOpbnbTransactions(ctx, lastScanned, 'Custom');
						}
						return;
					} else {
						// No valid stored address
						const errorMessage = lang === 'zh'
							? '❌ 没有找到已保存的地址\n\n请输入一个有效的 opBNB 钱包地址（以 0x 开头，42 个字符）'
							: '❌ No saved address found\n\nPlease enter a valid opBNB wallet address (starting with 0x, 42 characters)';
						
						await ctx.reply(errorMessage, {
							reply_markup: {
								inline_keyboard: [
									[{
										text: lang === 'zh' ? '🔙 返回' : '🔙 Back',
										callback_data: session.opbnbAction === 'holdings' ? 'opbnb_check_holdings' : 'opbnb_transaction_history_menu'
									}]
								]
							}
						});
						return;
					}
				}
				
				// Validate the actual address format
				if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
					const lang = await getUserLanguage(userId);
					const errorMessage = lang === 'zh'
						? '❌ 无效的钱包地址格式\n\n请确保地址以 0x 开头且长度为 42 个字符。'
						: '❌ Invalid wallet address format\n\nPlease ensure the address starts with 0x and is 42 characters long.';
					
					// Determine the appropriate back button based on action
					const action = session.opbnbAction;
					let backCallback = 'opbnb_dashboard';
					if (action === 'holdings') {
						backCallback = 'opbnb_check_holdings';
					} else if (action === 'transactions') {
						backCallback = 'opbnb_transaction_history_menu';
					}

					await ctx.reply(errorMessage, {
						reply_markup: {
							inline_keyboard: [
								[{
									text: lang === 'zh' ? '🔙 返回' : '🔙 Back',
									callback_data: backCallback
								}]
							]
						}
					});
					return;
				}
				
				// Store the address and clear waiting state (with validation)
				// CRITICAL: Never store "stored" or invalid addresses
				if (address !== 'stored' && /^0x[a-fA-F0-9]{40}$/i.test(address)) {
					session.opbnbLastScanned = address;
				} else {
					console.error('Message handler - Attempted to store invalid address:', address);
					// Clear any invalid data
					delete session.opbnbLastScanned;
				}
				session.waitingForOpbnbAddress = false;
				global.userSessions.set(userId, session);
				
				// Handle based on the action type
				const action = session.opbnbAction;
				if (action === 'holdings') {
					const { showOpbnbHoldings } = await import('../menus/opbnb');
					await showOpbnbHoldings(ctx, address, 'Custom');
				} else if (action === 'transactions') {
					const { showOpbnbTransactions } = await import('../menus/opbnb');
					await showOpbnbTransactions(ctx, address, 'Custom');
				} else {
					// Legacy support - scan the wallet (combined view)
					const { scanOpbnbWallet } = await import('../menus/opbnb');
					await scanOpbnbWallet(ctx, address, 'Custom');
				}
				return;
			}

			// Check if waiting for token address input (tracking) - higher priority
			if (session?.waitingForTokenAddress) {
				const { TokenTrackingService } = await import('../../services/tokenTracking');
				await TokenTrackingService.handleTokenAddressInput(ctx, text);
				return;
			}

			// Check if waiting for token address input (rug alerts)
			if (session?.rugAlerts?.waitingForTokenInput) {
				await rugAlertsService.handleTokenInput(ctx, text);
				return;
			}
			
			// Check if waiting for token search input
			if (session?.waitingForTokenSearchInput) {
				const { handleTokenSearchInput } = await import('../menus/tokenSearch');
				await handleTokenSearchInput(ctx, text);
				return;
			}

			// Check if waiting for transfer amount input
			if (session?.transfer?.waitingForAmountInput) {
				await handleTransferAmountInput(ctx, text, transferService);
				return;
			}

			// Check if waiting for auto-trade rule input
			if (session?.autoTradeSetup?.waitingForInput) {
				await handleAutoTradeInput(ctx, text, session);
				return;
			}


			// Auto-detect wallet/token address
			if (isTokenAddress(text)) {
				// Show wallet scan with analytics options
				await scannerService.handleWalletInput(ctx, text);
				return;
			}

			// Handle other commands
			if (text.startsWith('/')) {
				return; // Commands are handled by bot.command
			}


			// Simple transfer detection with natural language
			const lowerText = text.toLowerCase();
			if (lowerText.includes('transfer') || lowerText.includes('send') || lowerText.includes('move')) {
				// Extract amount using regex
				const amountMatch = text.match(/([\d.]+)\s*bnb/i);
				if (amountMatch) {
					const amount = amountMatch[1];
					
					// Determine direction from text
					let direction: 'to_trading' | 'from_trading' | null = null;
					if (lowerText.includes('to trading') || lowerText.includes('to bot')) {
						direction = 'to_trading';
					} else if (lowerText.includes('from trading') || lowerText.includes('to main')) {
						direction = 'from_trading';
					} else if (lowerText.includes('from main')) {
						direction = 'to_trading';
					}
					
					// If we have both amount and direction, execute transfer
					if (direction && parseFloat(amount) >= 0.001) {
						// Check if wallet is connected (same as button handler)
						if (!session?.address) {
							const userLanguage = await getUserLanguage(userId);
							const errorMessage = userLanguage === 'zh' ? 
								'❌ 请先使用 /start 连接您的钱包' : 
								'❌ Please connect your wallet first using /start';
							const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
							await ctx.reply(errorMessage, {
								reply_markup: {
									inline_keyboard: [
										[{ text: backButtonText, callback_data: 'start_edit' }]
									]
								}
							});
							return;
						}
						
						logger.info('Detected transfer request', { userId, amount, direction });
						if (direction === 'to_trading') {
							await transferService.handleTransferToTrading(ctx, amount);
						} else {
							await transferService.handleTransferFromTrading(ctx, amount);
						}
						return;
					}
				}
			}

			// Check for honey-related commands
			const honeyCommand = parseHoneyCommand(text);
			if (honeyCommand) {
				await executeHoneyCommand(ctx, honeyCommand);
				return;
			}

			// Check honey and proceed with AI processing
			await checkHoneyAndProceed(ctx, HoneyFeature.AI_QUERY, async () => {
				// Smart routing and message standardization
				let messageForAI = text;
				const lowerText = text.toLowerCase();

				// Define search-related trigger words (including more variations)
				const searchTriggers = [
					'search token', 
					'find token', 
					'look up token', 
					'search for', 
					'can you search token', // Add new trigger pattern
					'find me the token',
					'find',
					'lookup',
					'search' // Most generic one last
				];

				// Intelligent keyword extraction from anywhere in the sentence
				for (const trigger of searchTriggers) {
					const index = lowerText.indexOf(trigger);
					if (index !== -1) {
						// Found trigger word, extract everything after it as the query
						const query = text.substring(index + trigger.length).trim();
						if (query) {
							messageForAI = `Please search for the token with the keyword "${query}" and give me a conversational summary of the results.`;
							logger.info('Standardizing user search query for AI', { 
								userId, 
								originalText: text,
								standardizedPrompt: messageForAI 
							});
							break; // Use first matching trigger
						}
					}
				}

			// Process the message (either original or standardized) with AI
			const userIdString = ctx.from!.id.toString();
			const userLanguage = await getUserLanguage(userId);
			
			logger.info('Processing message with AI', { userId, finalMessageForAI: messageForAI });
			
			// Send immediate acknowledgment for token analysis
			let processingMessage;
			if (text.includes('0x') && text.includes('safe')) {
				const processingText = userLanguage === 'zh' ? 
					'🔍 正在分析代币安全性...\n⏳ 复杂代币可能需要30秒左右。' : 
					'🔍 Analyzing token safety...\n⏳ This may take up to 30 seconds for complex tokens.';
				processingMessage = await ctx.reply(processingText);
			} else {
				const processingText = userLanguage === 'zh' ? '🤖 正在处理您的请求...' : '🤖 Processing your request...';
				processingMessage = await ctx.reply(processingText);
			}
			
			// Process AI request and update the message
			try {
				const aiResponse = await geminiAI.processMessage(messageForAI, text, userIdString, userLanguage);
				// Safely delete the processing message
				try {
					await ctx.deleteMessage(processingMessage.message_id);
				} catch (deleteError) {
					logger.warn('Failed to delete processing message', { deleteError, userId });
				}
				
				// Send AI response with safe Markdown formatting
				try {
					const sanitizedResponse = sanitizeMarkdown(aiResponse);
					await ctx.reply(sanitizedResponse, { parse_mode: 'Markdown' });
				} catch (markdownError) {
					// If markdown parsing fails, try without formatting
					logger.warn('Markdown parsing failed, sending as plain text', { markdownError, userId });
					await ctx.reply(aiResponse);
				}
			} catch (aiError) {
				// Safely delete the processing message
				try {
					await ctx.deleteMessage(processingMessage.message_id);
				} catch (deleteError) {
					logger.warn('Failed to delete processing message in error handler', { deleteError, userId });
				}
				logger.error('AI processing error', { error: aiError });
				const errorText = userLanguage === 'zh' ? '❌ 处理请求时出错，请重试。' : '❌ Error processing your request. Please try again.';
				const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
				await ctx.reply(errorText, {
					reply_markup: {
						inline_keyboard: [
							[{ text: backButtonText, callback_data: 'start_edit' }]
						]
					}
				});
			}
			}); // End of checkHoneyAndProceed
		} catch (error) {
			logger.error('Error processing message', { 
				userId, 
				messageText: text,
				error: error instanceof Error ? error.message : String(error) 
			});
			const userLanguage = await getUserLanguage(userId);
			const errorText = userLanguage === 'zh' ? '❌ 处理您的消息时出错，请重试。' : '❌ Error processing your message. Please try again.';
			const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
			await ctx.reply(errorText, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'start_edit' }]
					]
				}
			});
		}
	});
}

// Helper function to detect token addresses
function isTokenAddress(text: string): boolean {
	return /^0x[a-fA-F0-9]{40}$/.test(text.trim());
}

// Handle transfer amount input
async function handleTransferAmountInput(ctx: Context, text: string, transferService: TransferService) {
	const userId = ctx.from!.id;
	const session = global.userSessions.get(userId);
	
	if (!session?.transfer) {
		return;
	}

	// Clear waiting state
	session.transfer.waitingForAmountInput = false;

	// Validate amount
	const amount = parseFloat(text.trim());
	if (isNaN(amount) || amount <= 0) {
		const userLanguage = await getUserLanguage(userId);
		const errorText = userLanguage === 'zh' ? '❌ 无效金额。请输入正数。' : '❌ Invalid amount. Please enter a positive number.';
		const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
		await ctx.reply(errorText, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
		return;
	}

	if (amount < 0.001) {
		const userLanguage = await getUserLanguage(userId);
		const errorText = userLanguage === 'zh' ? '❌ 金额太小。最小转账金额为 0.001 BNB。' : '❌ Amount too small. Minimum transfer is 0.001 BNB.';
		const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
		await ctx.reply(errorText, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
		return;
	}

	// Execute transfer based on direction
	if (session.transfer.direction === 'to_trading') {
		await transferService.handleTransferToTrading(ctx, amount.toString());
	} else if (session.transfer.direction === 'from_trading') {
		await transferService.handleTransferFromTrading(ctx, amount.toString());
	}
}

// Handle name input during onboarding
async function handleNameInput(ctx: Context, text: string, session: any) {
	const userId = ctx.from!.id;
	const trimmedText = text.trim();
	
	// Clear waiting state
	session.waitingForName = false;
	
	// Get user's language preference
	const userLanguage = await getUserLanguage(userId);
	
	// Validate name
	if (trimmedText.length < 1 || trimmedText.length > 50) {
		session.waitingForName = true;
		
		const errorMessage = userLanguage === 'zh' ? 
			'❌ 请输入1到50个字符之间的名字。' : 
			'❌ Please enter a name between 1 and 50 characters.';
		const anonymousButtonText = userLanguage === 'zh' ? '🕵️ 保持匿名' : '🕵️ Stay Anonymous';
		
		await ctx.reply(
			errorMessage,
			{
				reply_markup: {
					inline_keyboard: [
						[{ text: anonymousButtonText, callback_data: 'skip_name' }]
					]
				}
			}
		);
		return;
	}
	
	// Save the user's name
	await UserService.updateUserName(userId, trimmedText);
	
	// Continue with onboarding
	await continueOnboarding(ctx, userId, trimmedText);
}

// Handle name change input from settings
async function handleNameChangeInput(ctx: Context, text: string, session: any) {
	const userId = ctx.from!.id;
	const trimmedText = text.trim();
	
	// Clear waiting state
	session.waitingForNameChange = false;
	global.userSessions.set(userId, session);
	
	// Validate name
	if (trimmedText.length < 1 || trimmedText.length > 50) {
		await ctx.reply(
			'❌ Please enter a name between 1 and 50 characters.',
			{
				reply_markup: {
					inline_keyboard: [
						[{ text: '🔙 Back to Name Settings', callback_data: 'name_settings' }]
					]
				}
			}
		);
		return;
	}
	
	// Save the user's name
	await UserService.updateUserName(userId, trimmedText);
	
	// Show success message and return to name settings
	const userLanguage = await getUserLanguage(userId);
	const successMessage = userLanguage === 'zh' ? 
		`✅ 您的名称已更新为：**${trimmedText}**` :
		`✅ Your name has been updated to: **${trimmedText}**`;
	const backButtonText = userLanguage === 'zh' ? '🔙 返回名称设置' : '🔙 Back to Name Settings';
	
	await ctx.reply(
		successMessage,
		{
			parse_mode: 'Markdown',
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'name_settings' }]
				]
			}
		}
	);
}

// Continue onboarding after name is set (or skipped)
export async function continueOnboardingFromCallback(ctx: Context, userId: number, name?: string) {
	await continueOnboarding(ctx, userId, name);
}

// Continue onboarding after name is set (or skipped)
async function continueOnboarding(ctx: Context, userId: number, name?: string) {
	const user = await UserService.findOrCreateUser(userId);
	
	// Get user's language preference
	const userLanguage = await getUserLanguage(userId);
	
	// If user doesn't have a trading wallet, create one
	if (!user.tradingWalletAddress) {
		// Generate trading wallet
		const { address, privateKey } = generateWallet();
		const { encrypted, iv } = encryptPrivateKey(privateKey);
		
		// Save to database
		await UserService.updateTradingWallet(userId, address, encrypted, iv);
		
		// Show onboarding with private key in user's language
		const greeting = userLanguage === 'zh' ?
			(name ? `🎉 *欢迎，${name}！*` : '🐝 *欢迎使用 BeanBee！*') :
			(name ? `🎉 *Welcome, ${name}!*` : '🐝 *Welcome to BeanBee!*');
		
		const onboardingText = userLanguage === 'zh' ?
			`${greeting}\n\n` +
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
			`${greeting}\n\n` +
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
		// User already has a wallet, just show the main menu
		const { mainMenu } = await import('../menus/main');
		await mainMenu(ctx);
	}
}

// Handle auto-trade rule input
async function handleAutoTradeInput(ctx: Context, text: string, session: any) {
	const userId = ctx.from!.id;
	const trimmedText = text.trim();
	
	if (!session.autoTradeSetup) {
		return;
	}

	const { waitingForInput, tokenAddress, targetMarketCap, targetPrice } = session.autoTradeSetup;
	
	// Store target values before clearing session  
	const storedTargetMarketCap = targetMarketCap;
	const storedTargetPrice = targetPrice;
	
	// Clear the waiting state
	delete session.autoTradeSetup;
	global.userSessions.set(userId, session);

	// Validate numeric input
	const numericValue = parseFloat(trimmedText);
	if (isNaN(numericValue) || numericValue <= 0) {
		const userLanguage = await getUserLanguage(userId);
		const errorText = userLanguage === 'zh' ? '❌ 请输入有效的正数。' : '❌ Please enter a valid positive number.';
		const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
		await ctx.reply(errorText, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: `autotrade_rules_${tokenAddress}` }]
				]
			}
		});
		return;
	}

	try {
		const { TrackedTokenModel } = await import('@/database/models/TrackedToken');
		
		// Find the token
		const token = await TrackedTokenModel.findOne({
			telegramId: userId,
			tokenAddress: tokenAddress.toLowerCase(),
			isActive: true
		});

		if (!token) {
			const userLanguage = await getUserLanguage(userId);
			const errorText = userLanguage === 'zh' ? '❌ 未找到代币。' : '❌ Token not found.';
			const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
			await ctx.reply(errorText, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'start_edit' }]
					]
				}
			});
			return;
		}

		// Update the appropriate field based on input type
		switch (waitingForInput) {
			case 'entry_price':
				// Set the price target and show amount selection
				session.autoTradeSetup = {
					waitingForInput: 'entry_amount',
					tokenAddress: tokenAddress,
					targetPrice: numericValue
				};
				global.userSessions.set(userId, session);
				
				// Show amount selection with the new price target
				const { AutoTradeMenu } = await import('../menus/autoTrade');
				const priceDescription = `Custom price: $${numericValue >= 1 ? numericValue.toFixed(4) : numericValue.toFixed(6)}`;
				await AutoTradeMenu.showAmountSelection(ctx, tokenAddress, numericValue, priceDescription);
				return;
				
			case 'entry_marketcap':
				token.marketCapEntryTarget = numericValue;
				
				// If this is the first time setting entry rules, ask for amount next
				if (!token.entryAmountBNB && !token.entryAmountUSD) {
					await token.save();
					
					// Set up for amount input
					session.autoTradeSetup = {
						waitingForInput: 'entry_amount',
						tokenAddress: tokenAddress
					};
					global.userSessions.set(userId, session);
					
					// Get user's BNB balance
					let balanceMessage = '';
					try {
						const { getBNBBalance } = await import('@/services/wallet/balance');
						const { UserService } = await import('@/services/user');
						
						let walletAddress = session.address;
						if (!walletAddress) {
							const connection = await UserService.getWalletConnection(userId);
							walletAddress = connection?.address;
						}
						
						if (walletAddress) {
							const bnbBalance = await getBNBBalance(walletAddress);
							balanceMessage = `\n**Your BNB Balance:** ${bnbBalance} BNB\n`;
						}
					} catch (error) {
						logger.warn('Failed to get BNB balance for entry amount', { error, userId });
					}

					const message = `✅ Entry target set to $${numericValue.toLocaleString()} market cap.\n\n` +
						`💰 **Set Entry Amount**\n\n` +
						`How much BNB should I buy when the target is reached?${balanceMessage}\n` +
						`**Examples:**\n` +
						`• 0.1 (for 0.1 BNB)\n` +
						`• 0.5 (for 0.5 BNB)`;

					const keyboard = {
						inline_keyboard: [
							[{ text: '❌ Cancel', callback_data: `autotrade_rules_${tokenAddress}` }]
						]
					};

					await ctx.reply(message, {
						parse_mode: 'Markdown',
						reply_markup: keyboard
					});
					return;
				}
				break;

			case 'entry_amount':
				// Handle both price-based and market cap-based entry rules using session data
				token.entryAmountBNB = numericValue;
				
				// Set price-based target if available from session
				if (storedTargetPrice) {
					token.priceEntryTarget = storedTargetPrice;
					// Clear any old market cap target when setting price target
					token.marketCapEntryTarget = undefined;
				} else {
					// Fallback to market cap-based for backwards compatibility
					let finalTargetMarketCap = storedTargetMarketCap;
					if (!finalTargetMarketCap && token.marketCapEntryTarget) {
						finalTargetMarketCap = token.marketCapEntryTarget;
					}
					
					if (finalTargetMarketCap) {
						token.marketCapEntryTarget = finalTargetMarketCap;
					}
				}
				
				// Set status to pending_entry if not already set
				if (!token.autoTradeStatus) {
					token.autoTradeStatus = 'pending_entry';
				}
				break;

			case 'take_profit':
				token.takeProfitPrice = numericValue;
				break;

			case 'stop_loss':
				token.stopLossPrice = numericValue;
				break;
		}

		await token.save();

		// Show success message and return to auto-trade menu
		const fieldNames: Record<string, string> = {
			'entry_marketcap': 'Entry market cap target',
			'entry_amount': 'Entry amount',
			'take_profit': 'Take profit price',
			'stop_loss': 'Stop loss price'
		};

		await ctx.reply(`✅ ${fieldNames[waitingForInput]} set successfully!`);
		
		// Redirect back to auto-trade menu
		const { AutoTradeMenu } = await import('../menus/autoTrade');
		await AutoTradeMenu.handleAutoTradeMenu(ctx, tokenAddress);

	} catch (error) {
		logger.error('Error handling auto-trade input', { error, userId, waitingForInput, tokenAddress });
		const userLanguage = await getUserLanguage(userId);
		const errorText = userLanguage === 'zh' ? '❌ 保存自动交易规则时出错，请重试。' : '❌ Error saving auto-trade rule. Please try again.';
		const backButtonText = await getTranslation({ from: { id: userId } } as Context, 'common.back');
		await ctx.reply(errorText, {
			reply_markup: {
				inline_keyboard: [
					[{ text: backButtonText, callback_data: 'start_edit' }]
				]
			}
		});
	}
}