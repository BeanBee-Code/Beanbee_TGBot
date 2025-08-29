import { Context } from "telegraf"
import { getTranslation, getUserLanguage } from "@/i18n"
import { UserModel } from "@/database/models/User"
import { UserService } from "@/services/user"

export async function settingsMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const user = await UserModel.findOne({ telegramId })
	if (!user) return
	
	const currentLang = user.language || 'en'
	const isEnglish = currentLang === 'en'
	
	const title = await getTranslation(ctx, 'settings.title')
	const languageLabel = await getTranslation(ctx, 'settings.language')
	const notificationsLabel = await getTranslation(ctx, 'settings.notifications')
	const backLabel = await getTranslation(ctx, 'settings.back')
	
	// Format notification status with timezone
	const userTimezone = user.timezone || 'UTC';
	const lang = await getUserLanguage(telegramId);
	const notificationStatus = user.dailyNotificationEnabled 
		? `✅ ${user.dailyNotificationHour}:00 ${userTimezone}`
		: (lang === 'zh' ? '❌ 关闭' : '❌ Off')
	
	// Format name status
	const nameStatus = user.name ? `📝 ${user.name}` : (lang === 'zh' ? '🕵️ 匿名' : '🕵️ Anonymous')
	
	// Get wallet preference
	const session = global.userSessions.get(telegramId)
	const walletPref = session?.selectedWallet || 'main'
	const walletPrefDisplay = walletPref === 'main' ? (lang === 'zh' ? '💳 主钱包' : '💳 Main Wallet') : 
	                         walletPref === 'trading' ? (lang === 'zh' ? '🤖 交易钱包' : '🤖 Trading Wallet') : 
	                         (lang === 'zh' ? '💼 两个钱包' : '💼 Both Wallets')
	
	// Format quick trade status
	const quickTradeStatus = user.showTradeConfirmations ? 
		(lang === 'zh' ? '📝 显示确认' : '📝 Show Confirmations') : 
		(lang === 'zh' ? '⚡ 快速交易' : '⚡ Quick Trade')
	
	// Format debug mode status
	const debugModeStatus = user.debugMode ? 
		(lang === 'zh' ? '🐛 开启' : '🐛 On') : 
		(lang === 'zh' ? '🐛 关闭' : '🐛 Off')
	
	// Format chain selection status
	const chainStatus = user.selectedChain === 'opbnb' ? 
		'🔗 opBNB' : 
		'⛓️ BNB Chain'
	
  const settingsMessage = `${title}
  👤 ${lang === 'zh' ? '名称' : 'Name'}: ${nameStatus}
  👛 ${lang === 'zh' ? '投资组合/收益查询' : 'Portfolio/Yield Queries'}: ${walletPrefDisplay}
  ⚡ ${lang === 'zh' ? '交易确认设置' : 'Trade Confirmations'}: ${quickTradeStatus}
  🔗 ${lang === 'zh' ? 'AI 链选择' : 'AI Chain'}: ${chainStatus}
  ${languageLabel}: ${isEnglish ? '🇬🇧 English' : '🇨🇳 中文'}
  🌍 ${lang === 'zh' ? '时区' : 'Timezone'}: ${userTimezone}
  ${notificationsLabel}: ${notificationStatus}
  🐛 ${lang === 'zh' ? '调试模式' : 'Debug Mode'}: ${debugModeStatus}`

	const keyboard = {
		inline_keyboard: [
			[{ 
				text: lang === 'zh' ? '👤 更改名称' : '👤 Change Name', 
				callback_data: 'name_settings' 
			}],
			[{ 
				text: lang === 'zh' ? '👛 钱包偏好设置' : '👛 Wallet Preference', 
				callback_data: 'wallet_preference' 
			}],
			[{ 
				text: user.showTradeConfirmations ? 
					(lang === 'zh' ? '⚡ 启用快速交易' : '⚡ Enable Quick Trade') : 
					(lang === 'zh' ? '📝 显示确认' : '📝 Show Confirmations'), 
				callback_data: 'toggle_trade_confirmations' 
			}],
			[{ 
				text: user.selectedChain === 'opbnb' ? 
					(lang === 'zh' ? '🔗 opBNB → ⛓️ BNB Chain' : '🔗 opBNB → ⛓️ BNB Chain') : 
					(lang === 'zh' ? '⛓️ BNB Chain → 🔗 opBNB' : '⛓️ BNB Chain → 🔗 opBNB'), 
				callback_data: 'chain_selection' 
			}],
			[{ 
				text: isEnglish ? '🇬🇧 → 🇨🇳' : '🇨🇳 → 🇬🇧', 
				callback_data: isEnglish ? 'set_language:zh' : 'set_language:en' 
			}],
			[{ 
				text: `🌍 ${userTimezone}`, 
				callback_data: 'select_timezone' 
			}],
			[
				{ 
					text: user.dailyNotificationEnabled ? (lang === 'zh' ? '🔕 关闭' : '🔕 Off') : (lang === 'zh' ? '🔔 开启' : '🔔 On'), 
					callback_data: 'toggle_daily_notification' 
				},
				{ 
					text: `🕐 ${user.dailyNotificationHour}:00`, 
					callback_data: 'select_notification_hour' 
				}
			],
			[{ 
				text: user.debugMode ? 
					(lang === 'zh' ? '🐛 关闭调试模式' : '🐛 Turn Off Debug Mode') : 
					(lang === 'zh' ? '🐛 开启调试模式' : '🐛 Turn On Debug Mode'), 
				callback_data: 'toggle_debug_mode' 
			}],
			[{ 
				text: lang === 'zh' ? '🗑️ 清除聊天记录' : '🗑️ Clear Chat History', 
				callback_data: 'confirm_clear_history' 
			}],
			[{ text: backLabel, callback_data: 'start_edit' }]
		]
	}

	// Check if this is a callback query (can edit) or a command (must reply)
	if (ctx.callbackQuery) {
		await ctx.editMessageText(settingsMessage, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(settingsMessage, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}


export async function notificationHourMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const user = await UserModel.findOne({ telegramId })
	const timezone = user?.timezone || 'UTC'
	
	const title = await getTranslation(ctx, 'notifications.selectHour') + ` (${timezone})`
	const backLabel = await getTranslation(ctx, 'notifications.back')

	// Create hour selection grid (0-23)
	const hourButtons = []
	for (let i = 0; i < 24; i += 4) {
		const row = []
		for (let j = i; j < i + 4 && j < 24; j++) {
			row.push({ text: `${j}:00`, callback_data: `set_notification_hour:${j}` })
		}
		hourButtons.push(row)
	}

	const keyboard = {
		inline_keyboard: [
			...hourButtons,
			[{ text: backLabel, callback_data: 'settings' }]
		]
	}

	if (ctx.callbackQuery) {
		await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(title, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}

export async function nameSettingsMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const user = await UserModel.findOne({ telegramId })
	if (!user) return
	
	const lang = await getUserLanguage(telegramId)
	const currentName = user.name ? `📝 ${user.name}` : (lang === 'zh' ? '🕵️ 匿名' : '🕵️ Anonymous')
	
	const message = lang === 'zh' ? 
		`👤 **名称设置**

当前名称：${currentName}

请选择一个选项：` :
		`👤 **Name Settings**

Current name: ${currentName}

Choose an option:`

	const keyboard = {
		inline_keyboard: [
			[{ 
				text: lang === 'zh' ? '✏️ 更改名称' : '✏️ Change Name', 
				callback_data: 'change_name' 
			}],
			[{ 
				text: lang === 'zh' ? '🕵️ 设为匿名' : '🕵️ Go Anonymous', 
				callback_data: 'go_anonymous' 
			}],
			[{ 
				text: lang === 'zh' ? '🔙 返回设置' : '🔙 Back to Settings', 
				callback_data: 'settings' 
			}]
		]
	}

	if (ctx.callbackQuery) {
		await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}

export async function walletPreferenceMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const session = global.userSessions.get(telegramId)
	const tradingWallet = await UserService.getTradingWalletAddress(telegramId)
	const lang = await getUserLanguage(telegramId)
	
	const currentPref = session?.selectedWallet || 'main'
	const currentPrefDisplay = currentPref === 'main' ? (lang === 'zh' ? '💳 主钱包' : '💳 Main Wallet') : 
	                          currentPref === 'trading' ? (lang === 'zh' ? '🤖 交易钱包' : '🤖 Trading Wallet') : 
	                          (lang === 'zh' ? '💼 两个钱包' : '💼 Both Wallets')
	
	const message = lang === 'zh' ?
		`👛 **投资组合和收益查询的钱包偏好设置**

当前偏好：${currentPrefDisplay}

选择在询问投资组合或收益头寸时使用哪个钱包：` :
		`👛 **Wallet Preference for Portfolio & Yield Queries**

Current preference: ${currentPrefDisplay}

Select which wallet(s) to use when asking about your portfolio or yield positions:`

	const buttons = []
	
	// Always show main wallet option
	if (session?.address) {
		buttons.push([{ 
			text: currentPref === 'main' ? 
				(lang === 'zh' ? '✅ 主钱包' : '✅ Main Wallet') : 
				(lang === 'zh' ? '💳 主钱包' : '💳 Main Wallet'), 
			callback_data: 'set_wallet_pref:main' 
		}])
	}
	
	// Show trading wallet option if available
	if (tradingWallet) {
		buttons.push([{ 
			text: currentPref === 'trading' ? 
				(lang === 'zh' ? '✅ 交易钱包' : '✅ Trading Wallet') : 
				(lang === 'zh' ? '🤖 交易钱包' : '🤖 Trading Wallet'), 
			callback_data: 'set_wallet_pref:trading' 
		}])
	}
	
	// Show both option if both wallets available
	if (session?.address && tradingWallet) {
		buttons.push([{ 
			text: currentPref === 'both' ? 
				(lang === 'zh' ? '✅ 两个钱包' : '✅ Both Wallets') : 
				(lang === 'zh' ? '💼 两个钱包' : '💼 Both Wallets'), 
			callback_data: 'set_wallet_pref:both' 
		}])
	}
	
	// Add back button
	buttons.push([{ 
		text: lang === 'zh' ? '🔙 返回设置' : '🔙 Back to Settings', 
		callback_data: 'settings' 
	}])

	const keyboard = {
		inline_keyboard: buttons
	}

	if (ctx.callbackQuery) {
		await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}

export async function chainSelectionMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const user = await UserModel.findOne({ telegramId })
	if (!user) return
	
	const lang = await getUserLanguage(telegramId)
	const currentChain = user.selectedChain || 'bnb'
	
	const message = lang === 'zh' ?
		`🔗 **AI 链选择**

当前链：${currentChain === 'opbnb' ? '🔗 opBNB' : '⛓️ BNB Chain'}

选择 AI 助手应该使用哪条链来响应您的查询：

• **BNB Chain** - 主网，用于交易、DeFi 收益等
• **opBNB** - Layer 2，低费用、快速交易

您也可以通过自然语言切换链：
• "切换到 opBNB"
• "使用 BNB 链"` :
		`🔗 **AI Chain Selection**

Current chain: ${currentChain === 'opbnb' ? '🔗 opBNB' : '⛓️ BNB Chain'}

Select which chain the AI assistant should use for your queries:

• **BNB Chain** - Mainnet for trading, DeFi yields, etc.
• **opBNB** - Layer 2 for low fees and fast transactions

You can also switch chains using natural language:
• "Switch to opBNB"
• "Use BNB chain"`

	const keyboard = {
		inline_keyboard: [
			[{ 
				text: currentChain === 'bnb' ? 
					(lang === 'zh' ? '✅ BNB Chain (主网)' : '✅ BNB Chain (Mainnet)') : 
					(lang === 'zh' ? '⛓️ BNB Chain (主网)' : '⛓️ BNB Chain (Mainnet)'), 
				callback_data: 'set_chain:bnb' 
			}],
			[{ 
				text: currentChain === 'opbnb' ? 
					(lang === 'zh' ? '✅ opBNB (Layer 2)' : '✅ opBNB (Layer 2)') : 
					(lang === 'zh' ? '🔗 opBNB (Layer 2)' : '🔗 opBNB (Layer 2)'), 
				callback_data: 'set_chain:opbnb' 
			}],
			[{ 
				text: lang === 'zh' ? '🔙 返回设置' : '🔙 Back to Settings', 
				callback_data: 'settings' 
			}]
		]
	}

	if (ctx.callbackQuery) {
		await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}

export async function timezoneMenu(ctx: Context) {
	const telegramId = ctx.from?.id
	if (!telegramId) return
	
	const user = await UserModel.findOne({ telegramId })
	if (!user) return
	
	const currentTimezone = user.timezone || 'UTC'
	
	// Common timezones organized by region
	const timezones = [
		// Americas
		{ text: '🇺🇸 New York (EST)', data: 'America/New_York' },
		{ text: '🇺🇸 Chicago (CST)', data: 'America/Chicago' },
		{ text: '🇺🇸 Denver (MST)', data: 'America/Denver' },
		{ text: '🇺🇸 Los Angeles (PST)', data: 'America/Los_Angeles' },
		{ text: '🇨🇦 Toronto', data: 'America/Toronto' },
		{ text: '🇧🇷 São Paulo', data: 'America/Sao_Paulo' },
		// Europe
		{ text: '🇬🇧 London', data: 'Europe/London' },
		{ text: '🇫🇷 Paris', data: 'Europe/Paris' },
		{ text: '🇩🇪 Berlin', data: 'Europe/Berlin' },
		{ text: '🇷🇺 Moscow', data: 'Europe/Moscow' },
		// Asia
		{ text: '🇦🇪 Dubai', data: 'Asia/Dubai' },
		{ text: '🇮🇳 Mumbai', data: 'Asia/Kolkata' },
		{ text: '🇸🇬 Singapore', data: 'Asia/Singapore' },
		{ text: '🇭🇰 Hong Kong', data: 'Asia/Hong_Kong' },
		{ text: '🇨🇳 Shanghai', data: 'Asia/Shanghai' },
		{ text: '🇯🇵 Tokyo', data: 'Asia/Tokyo' },
		{ text: '🇰🇷 Seoul', data: 'Asia/Seoul' },
		// Others
		{ text: '🇦🇺 Sydney', data: 'Australia/Sydney' },
		{ text: '🌍 UTC', data: 'UTC' }
	]
	
	// Get current time in user's timezone
	const currentTime = new Date()
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: currentTimezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	})
	const currentLocalTime = formatter.format(currentTime)
	
	const lang = await getUserLanguage(telegramId)
	const message = lang === 'zh' ? 
		`🌍 **选择您的时区**

当前时区：${currentTimezone}
当前时间：${currentLocalTime}

选择您的时区：` :
		`🌍 **Select Your Timezone**

Current timezone: ${currentTimezone}
Current time: ${currentLocalTime}

Choose your timezone:`
	
	// Create buttons grid (2 per row)
	const buttons = []
	for (let i = 0; i < timezones.length; i += 2) {
		const row = []
		for (let j = i; j < i + 2 && j < timezones.length; j++) {
			const tz = timezones[j]
			const isSelected = tz.data === currentTimezone
			row.push({
				text: isSelected ? `✅ ${tz.text}` : tz.text,
				callback_data: `set_timezone:${tz.data}`
			})
		}
		buttons.push(row)
	}
	
	// Add back button
	buttons.push([{ 
		text: lang === 'zh' ? '🔙 返回设置' : '🔙 Back to Settings', 
		callback_data: 'settings' 
	}])
	
	const keyboard = {
		inline_keyboard: buttons
	}
	
	if (ctx.callbackQuery) {
		await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	} else {
		await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' })
	}
}