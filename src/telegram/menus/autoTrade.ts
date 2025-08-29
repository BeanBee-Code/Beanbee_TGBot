import { Context, Markup } from 'telegraf';
import { getTranslation } from '@/i18n';
import { TrackedTokenModel } from '@/database/models/TrackedToken';
import { createLogger } from '@/utils/logger';

const logger = createLogger('telegram.menus.autoTrade');

export class AutoTradeMenu {
    /**
     * Display the auto-trade rules menu for a specific token
     */
    static async handleAutoTradeMenu(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token) {
                await ctx.editMessageText('❌ Token not found or no longer tracked.', {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('🔙 Back', 'manage_tracked_tokens')]
                        ]
                    }
                });
                return;
            }

            const symbol = token.tokenSymbol || 'Unknown';
            const currentPrice = token.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
            const marketCap = token.marketCap ? `$${this.formatMarketCap(token.marketCap)}` : 'N/A';

            let message = `🤖 **Auto-Trade Rules: ${symbol}**\n\n`;
            message += `**Current Token Info:**\n`;
            message += `• Price: ${currentPrice}\n`;
            message += `• Market Cap: ${marketCap}\n`;
            message += `• Address: \`${tokenAddress}\`\n\n`;

            message += `**Auto-Trade Status:** ${token.isAutoTradeActive ? '✅ Active' : '❌ Inactive'}\n`;
            if (token.autoTradeStatus) {
                message += `**Current Phase:** ${this.formatTradeStatus(token.autoTradeStatus)}\n`;
            }
            message += '\n';

            // Entry Rules
            message += `**📈 Entry Rules:**\n`;
            const entryAmount = token.entryAmountBNB || token.entryAmountUSD;
            
            // Check for price-based entry rules first, then fall back to market cap rules
            if (token.priceEntryTarget && entryAmount) {
                const amountDisplay = token.entryAmountBNB 
                    ? `${token.entryAmountBNB} BNB` 
                    : `$${token.entryAmountUSD}`;
                const priceFormatted = token.priceEntryTarget >= 1 
                    ? `$${token.priceEntryTarget.toFixed(4)}` 
                    : `$${token.priceEntryTarget.toFixed(6)}`;
                message += `• Buy ${amountDisplay} when price reaches ${priceFormatted}\n`;
            } else if (token.marketCapEntryTarget && entryAmount) {
                const amountDisplay = token.entryAmountBNB 
                    ? `${token.entryAmountBNB} BNB` 
                    : `$${token.entryAmountUSD}`;
                message += `• Buy ${amountDisplay} when market cap reaches $${this.formatNumber(token.marketCapEntryTarget)}\n`;
            } else {
                message += `• Not configured\n`;
            }

            // Exit Rules
            message += `\n**📉 Exit Rules:**\n`;
            if (token.takeProfitPrice || token.stopLossPrice) {
                if (token.takeProfitPrice) {
                    message += `• Take Profit: $${token.takeProfitPrice}\n`;
                }
                if (token.stopLossPrice) {
                    message += `• Stop Loss: $${token.stopLossPrice}\n`;
                }
            } else {
                message += `• Not configured\n`;
            }

            const keyboard = this.buildAutoTradeKeyboard(token.isAutoTradeActive, tokenAddress);

            try {
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } catch (editError) {
                // If edit fails, send a new message instead
                logger.warn('Failed to edit message, sending new one', { error: editError });
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            logger.error('Error displaying auto-trade menu', { error, userId, tokenAddress });
            const backButtonText = await getTranslation(ctx, 'common.back');
            await ctx.reply('❌ Error loading auto-trade menu', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: backButtonText, callback_data: 'manage_tracked_tokens' }]
                    ]
                }
            });
        }
    }

    /**
     * Toggle auto-trade activation for a token
     */
    static async toggleAutoTrade(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token) {
                await ctx.answerCbQuery('❌ Token not found', { show_alert: true });
                return;
            }

            const newStatus = !token.isAutoTradeActive;
            
            // If activating, ensure rules are configured
            const entryAmount = token.entryAmountBNB || token.entryAmountUSD;
            const hasEntryTarget = token.priceEntryTarget || token.marketCapEntryTarget;
            if (newStatus && (!hasEntryTarget || !entryAmount)) {
                await ctx.answerCbQuery('❌ Please configure entry rules first', { show_alert: true });
                return;
            }

            // If activating, set initial status to pending_entry
            if (newStatus && !token.autoTradeStatus) {
                token.autoTradeStatus = 'pending_entry';
            }

            token.isAutoTradeActive = newStatus;
            await token.save();

            const statusText = newStatus ? 'activated' : 'deactivated';
            await ctx.answerCbQuery(`✅ Auto-trade ${statusText}`, { show_alert: true });
            
            // Refresh the menu
            await this.handleAutoTradeMenu(ctx, tokenAddress);

        } catch (error) {
            logger.error('Error toggling auto-trade', { error, userId, tokenAddress });
            await ctx.answerCbQuery('❌ Error updating auto-trade status', { show_alert: true });
        }
    }

    /**
     * Clear all auto-trade rules for a token
     */
    static async clearAutoTradeRules(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            await TrackedTokenModel.updateOne(
                { telegramId: userId, tokenAddress: tokenAddress.toLowerCase() },
                {
                    $unset: {
                        marketCapEntryTarget: 1,
                        priceEntryTarget: 1,
                        entryAmountBNB: 1,
                        entryAmountUSD: 1,
                        takeProfitPrice: 1,
                        stopLossPrice: 1,
                        autoTradeStatus: 1
                    },
                    isAutoTradeActive: false
                }
            );

            await ctx.answerCbQuery('✅ All rules cleared', { show_alert: true });
            await this.handleAutoTradeMenu(ctx, tokenAddress);

        } catch (error) {
            logger.error('Error clearing auto-trade rules', { error, userId, tokenAddress });
            await ctx.answerCbQuery('❌ Error clearing rules', { show_alert: true });
        }
    }

    /**
     * Initiate the process to set entry rules with preset options
     */
    static async initiateEntryRuleSetup(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.editMessageText('❌ Token price data not found. Please refresh token prices first.', {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('🔙 Back', `autotrade_rules_${tokenAddress}`)]
                        ]
                    }
                });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            const currentPriceFormatted = currentPrice >= 1 ? `$${currentPrice.toFixed(4)}` : `$${currentPrice.toFixed(6)}`;

            const message = `📈 **Set Entry Rules**\n\n` +
                `Choose when to trigger a buy order based on token price:\n\n` +
                `**Current Price:** ${currentPriceFormatted}\n\n` +
                `Select a preset or choose custom input:`;

            const keyboard = {
                inline_keyboard: [
                    [
                        Markup.button.callback('📊 Current Price', `entry_preset_${tokenAddress}_current`)
                    ],
                    [
                        Markup.button.callback('📉 -25%', `entry_preset_${tokenAddress}_minus25`),
                        Markup.button.callback('📉 -10%', `entry_preset_${tokenAddress}_minus10`)
                    ],
                    [
                        Markup.button.callback('📉 -5%', `entry_preset_${tokenAddress}_minus5`),
                        Markup.button.callback('📈 +5%', `entry_preset_${tokenAddress}_plus5`)
                    ],
                    [
                        Markup.button.callback('📈 +10%', `entry_preset_${tokenAddress}_plus10`),
                        Markup.button.callback('📈 +25%', `entry_preset_${tokenAddress}_plus25`)
                    ],
                    [
                        Markup.button.callback('✏️ Custom Price', `entry_custom_${tokenAddress}`)
                    ],
                    [
                        Markup.button.callback('❌ Cancel', `autotrade_rules_${tokenAddress}`)
                    ]
                ]
            };

            try {
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } catch (editError) {
                logger.warn('Failed to edit message, sending new one', { error: editError });
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            logger.error('Error initiating entry rule setup', { error, userId, tokenAddress });
            const backButtonText = await getTranslation(ctx, 'common.back');
            await ctx.reply('❌ Error setting up entry rules', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: backButtonText, callback_data: `autotrade_rules_${tokenAddress}` }]
                    ]
                }
            });
        }
    }

    /**
     * Initiate the process to set take profit with preset options
     */
    static async initiateTakeProfitSetup(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.editMessageText('❌ Token data not found. Please refresh token prices first.', {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('🔙 Back', `autotrade_rules_${tokenAddress}`)]
                        ]
                    }
                });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            const currentPriceFormatted = `$${currentPrice.toPrecision(6)}`;

            // Store token info in session to avoid long callback data
            let session = global.userSessions.get(userId);
            if (!session) {
                const { WalletService } = await import('@/services/wallet/connect');
                const walletService = new WalletService(global.userSessions);
                await walletService.initializeConnection(userId);
                session = global.userSessions.get(userId);
            }

            if (session) {
                session.autoTradeSetup = {
                    waitingForInput: 'take_profit',
                    tokenAddress: tokenAddress
                };
                global.userSessions.set(userId, session);
            }

            const message = `📈 **Set Take Profit Price**\n\n` +
                `Choose the price target to sell for profit:\n\n` +
                `**Current Price:** ${currentPriceFormatted}\n\n` +
                `Select a preset profit target:`;

            const keyboard = {
                inline_keyboard: [
                    [
                        Markup.button.callback('📈 +25%', `tp_plus25`),
                        Markup.button.callback('📈 +50%', `tp_plus50`)
                    ],
                    [
                        Markup.button.callback('🚀 +100%', `tp_plus100`),
                        Markup.button.callback('🚀 +200%', `tp_plus200`)
                    ],
                    [
                        Markup.button.callback('🌟 +500%', `tp_plus500`),
                        Markup.button.callback('💎 +1000%', `tp_plus1000`)
                    ],
                    [
                        Markup.button.callback('✏️ Custom Price', `tp_custom`)
                    ],
                    [
                        Markup.button.callback('❌ Cancel', `autotrade_rules_${tokenAddress}`)
                    ]
                ]
            };

            try {
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } catch (editError) {
                logger.warn('Failed to edit message, sending new one', { error: editError });
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            logger.error('Error initiating take profit setup', { error, userId, tokenAddress });
            const backButtonText = await getTranslation(ctx, 'common.back');
            await ctx.reply('❌ Error setting up take profit', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: backButtonText, callback_data: `autotrade_rules_${tokenAddress}` }]
                    ]
                }
            });
        }
    }

    /**
     * Initiate the process to set stop loss with preset options
     */
    static async initiateStopLossSetup(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.editMessageText('❌ Token data not found. Please refresh token prices first.', {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('🔙 Back', `autotrade_rules_${tokenAddress}`)]
                        ]
                    }
                });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            const currentPriceFormatted = `$${currentPrice.toPrecision(6)}`;

            // Store token info in session to avoid long callback data
            let session = global.userSessions.get(userId);
            if (!session) {
                const { WalletService } = await import('@/services/wallet/connect');
                const walletService = new WalletService(global.userSessions);
                await walletService.initializeConnection(userId);
                session = global.userSessions.get(userId);
            }

            if (session) {
                session.autoTradeSetup = {
                    waitingForInput: 'stop_loss',
                    tokenAddress: tokenAddress
                };
                global.userSessions.set(userId, session);
            }

            const message = `📉 **Set Stop Loss Price**\n\n` +
                `Choose the price level to limit your losses:\n\n` +
                `**Current Price:** ${currentPriceFormatted}\n\n` +
                `Select a preset stop loss level:`;

            const keyboard = {
                inline_keyboard: [
                    [
                        Markup.button.callback('📉 -5%', `sl_minus5`),
                        Markup.button.callback('📉 -10%', `sl_minus10`)
                    ],
                    [
                        Markup.button.callback('🔻 -20%', `sl_minus20`),
                        Markup.button.callback('🔻 -30%', `sl_minus30`)
                    ],
                    [
                        Markup.button.callback('⚠️ -50%', `sl_minus50`),
                        Markup.button.callback('🚨 -75%', `sl_minus75`)
                    ],
                    [
                        Markup.button.callback('✏️ Custom Price', `sl_custom`)
                    ],
                    [
                        Markup.button.callback('❌ Cancel', `autotrade_rules_${tokenAddress}`)
                    ]
                ]
            };

            try {
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } catch (editError) {
                logger.warn('Failed to edit message, sending new one', { error: editError });
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            logger.error('Error initiating stop loss setup', { error, userId, tokenAddress });
            const backButtonText = await getTranslation(ctx, 'common.back');
            await ctx.reply('❌ Error setting up stop loss', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: backButtonText, callback_data: `autotrade_rules_${tokenAddress}` }]
                    ]
                }
            });
        }
    }

    /**
     * Build the auto-trade keyboard based on current state
     */
    private static buildAutoTradeKeyboard(isActive: boolean, tokenAddress: string) {
        return {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        isActive ? '🛑 Deactivate' : '✅ Activate',
                        `toggle_autotrade_${tokenAddress}`
                    )
                ],
                [
                    Markup.button.callback('📈 Entry Rules', `set_entry_rules_${tokenAddress}`),
                    Markup.button.callback('📊 Take Profit', `set_take_profit_${tokenAddress}`)
                ],
                [
                    Markup.button.callback('📉 Stop Loss', `set_stop_loss_${tokenAddress}`),
                    Markup.button.callback('🗑️ Clear All', `clear_autotrade_${tokenAddress}`)
                ],
                [
                    Markup.button.callback('🔄 Refresh Price', `refresh_autotrade_${tokenAddress}`)
                ],
                [
                    Markup.button.callback('🔙 Back', 'manage_tracked_tokens')
                ]
            ]
        };
    }

    /**
     * Refresh token price and market cap data
     */
    static async refreshAutoTradeData(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            // Show loading message
            await ctx.answerCbQuery('🔄 Refreshing price data...', { show_alert: false });

            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token) {
                await ctx.answerCbQuery('❌ Token not found', { show_alert: true });
                return;
            }

            // Import required services
            const { PancakeSwapTrader } = await import('@/services/pancakeswap');
            const { pairDiscoveryService } = await import('@/services/pancakeswap/pairDiscovery');
            const trader = new PancakeSwapTrader();

            // Get basic token info from blockchain
            const tokenInfo = await trader.getTokenInfo(tokenAddress);
            if (!tokenInfo) {
                await ctx.answerCbQuery('❌ Failed to fetch token data', { show_alert: true });
                return;
            }

            // Get price and market cap from pair discovery
            const discoveryResult = await pairDiscoveryService.discoverTokenPair(tokenAddress);
            if (!discoveryResult?.currentPrice || !discoveryResult?.marketCap) {
                await ctx.answerCbQuery('❌ Failed to fetch price data', { show_alert: true });
                return;
            }

            // Update token data in database
            await TrackedTokenModel.updateOne(
                { telegramId: userId, tokenAddress: tokenAddress.toLowerCase() },
                {
                    currentPrice: discoveryResult.currentPrice,
                    marketCap: discoveryResult.marketCap,
                    tokenSymbol: tokenInfo.symbol,
                    tokenName: tokenInfo.name
                }
            );

            logger.info('Auto-trade token data refreshed', {
                userId,
                tokenAddress,
                symbol: tokenInfo.symbol,
                newPrice: discoveryResult.currentPrice,
                newMarketCap: discoveryResult.marketCap
            });

            // Show updated menu with refreshed data
            await this.handleAutoTradeMenu(ctx, tokenAddress);

        } catch (error) {
            logger.error('Error refreshing auto-trade data', { error, userId, tokenAddress });
            await ctx.answerCbQuery('❌ Error refreshing data', { show_alert: true });
        }
    }

    /**
     * Format trade status for display
     */
    private static formatTradeStatus(status: string): string {
        switch (status) {
            case 'pending_entry': return '⏳ Waiting for entry signal';
            case 'executing_entry': return '🔄 Executing buy order...';
            case 'position_open': return '📈 Position open, monitoring exit';
            case 'completed': return '✅ Trade completed';
            default: return status;
        }
    }

    /**
     * Format market cap for display
     */
    private static formatMarketCap(marketCap: string): string {
        const mc = parseFloat(marketCap);
        if (mc >= 1e9) {
            return `${(mc / 1e9).toFixed(2)}B`;
        } else if (mc >= 1e6) {
            return `${(mc / 1e6).toFixed(2)}M`;
        } else if (mc >= 1e3) {
            return `${(mc / 1e3).toFixed(2)}K`;
        }
        return `${mc.toFixed(2)}`;
    }

    /**
     * Format number for display
     */
    private static formatNumber(num: number): string {
        if (num >= 1e9) {
            return `${(num / 1e9).toFixed(2)}B`;
        } else if (num >= 1e6) {
            return `${(num / 1e6).toFixed(2)}M`;
        } else if (num >= 1e3) {
            return `${(num / 1e3).toFixed(2)}K`;
        }
        return num.toLocaleString();
    }

    /**
     * Get current market cap for a token
     */
    private static async getCurrentMarketCap(tokenAddress: string): Promise<string> {
        try {
            const token = await TrackedTokenModel.findOne({
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });
            return token?.marketCap ? `$${this.formatMarketCap(token.marketCap)}` : 'N/A';
        } catch (error) {
            logger.error('Error getting current market cap', { error, tokenAddress });
            return 'N/A';
        }
    }

    /**
     * Get current price for a token
     */
    private static async getCurrentPrice(tokenAddress: string): Promise<string> {
        try {
            const token = await TrackedTokenModel.findOne({
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });
            return token?.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
        } catch (error) {
            logger.error('Error getting current price', { error, tokenAddress });
            return 'N/A';
        }
    }

    /**
     * Handle entry rule preset selection
     */
    static async handleEntryPreset(ctx: Context, tokenAddress: string, preset: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.answerCbQuery('❌ Token price data not found', { show_alert: true });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            let targetPrice: number;
            let description: string;

            switch (preset) {
                case 'current':
                    targetPrice = currentPrice;
                    description = 'Current price';
                    break;
                case 'minus25':
                    targetPrice = currentPrice * 0.75;
                    description = 'Current price - 25%';
                    break;
                case 'minus10':
                    targetPrice = currentPrice * 0.9;
                    description = 'Current price - 10%';
                    break;
                case 'minus5':
                    targetPrice = currentPrice * 0.95;
                    description = 'Current price - 5%';
                    break;
                case 'plus5':
                    targetPrice = currentPrice * 1.05;
                    description = 'Current price + 5%';
                    break;
                case 'plus10':
                    targetPrice = currentPrice * 1.1;
                    description = 'Current price + 10%';
                    break;
                case 'plus25':
                    targetPrice = currentPrice * 1.25;
                    description = 'Current price + 25%';
                    break;
                default:
                    await ctx.answerCbQuery('❌ Invalid preset', { show_alert: true });
                    return;
            }

            // Show amount selection
            await this.showAmountSelection(ctx, tokenAddress, targetPrice, description);

        } catch (error) {
            logger.error('Error handling entry preset', { error, userId, tokenAddress, preset });
            await ctx.answerCbQuery('❌ Error setting entry rules', { show_alert: true });
        }
    }

    /**
     * Show amount selection for entry rules
     */
    static async showAmountSelection(ctx: Context, tokenAddress: string, targetPrice: number, description: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        // Store the target price in user session to avoid long callback data
        let session = global.userSessions.get(userId);
        if (!session) {
            const { WalletService } = await import('@/services/wallet/connect');
            const walletService = new WalletService(global.userSessions);
            await walletService.initializeConnection(userId);
            session = global.userSessions.get(userId);
        }

        if (session) {
            session.autoTradeSetup = {
                waitingForInput: 'entry_amount',
                tokenAddress: tokenAddress,
                targetPrice: targetPrice
            };
            global.userSessions.set(userId, session);
        }

        const targetFormatted = targetPrice >= 1 ? `$${targetPrice.toFixed(4)}` : `$${targetPrice.toFixed(6)}`;
        
        // Get trading wallet balance
        let balanceMessage = '';
        try {
            const { UserService } = await import('@/services/user');
            const { getBNBBalance } = await import('@/services/wallet/balance');
            
            const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
            if (tradingWalletAddress) {
                const bnbBalance = await getBNBBalance(tradingWalletAddress);
                const bnbPrice = await import('@/services/wallet/tokenPriceCache').then(m => m.getBNBPrice());
                const balanceUSD = (parseFloat(bnbBalance) * bnbPrice).toFixed(2);
                
                balanceMessage = `\n💳 **Trading Wallet:** ${bnbBalance} BNB ($${balanceUSD})\n`;
            }
        } catch (error) {
            logger.warn('Failed to get trading wallet balance for entry amount', { error, userId });
        }
        
        const message = `💰 **Set Entry Amount**\n\n` +
            `**Target:** ${description}\n` +
            `**Target Price:** ${targetFormatted}${balanceMessage}\n` +
            `How much do you want to invest when this target is reached?`;

        // Use short callback data to avoid Telegram's 64-character limit
        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback('💎 0.1 BNB', `entry_amt_0.1`),
                    Markup.button.callback('💎 0.5 BNB', `entry_amt_0.5`)
                ],
                [
                    Markup.button.callback('💰 1 BNB', `entry_amt_1`),
                    Markup.button.callback('💰 2 BNB', `entry_amt_2`)
                ],
                [
                    Markup.button.callback('🚀 5 BNB', `entry_amt_5`),
                    Markup.button.callback('✏️ Custom', `entry_amt_custom`)
                ],
                [
                    Markup.button.callback('🔙 Back', `set_entry_rules_${tokenAddress}`)
                ]
            ]
        };

        try {
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (error) {
            logger.warn('Failed to edit message, sending new one', { error });
            await ctx.reply(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    /**
     * Handle final entry rule setup using session data
     */
    static async handleEntryAmountSelection(ctx: Context, amount: number): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress || 
                (!session?.autoTradeSetup?.targetPrice && !session?.autoTradeSetup?.targetMarketCap)) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            const tokenAddress = session.autoTradeSetup.tokenAddress;
            const targetPrice = session.autoTradeSetup.targetPrice;
            const targetMarketCap = session.autoTradeSetup.targetMarketCap; // For backwards compatibility

            // Use price-based entry rules if available, otherwise fall back to market cap
            const updateData: any = {
                entryAmountBNB: amount,
                $unset: { entryAmountUSD: 1 } // Remove old USD amount
            };

            if (targetPrice) {
                updateData.priceEntryTarget = targetPrice;
                updateData.$unset.marketCapEntryTarget = 1; // Remove old market cap target
            } else if (targetMarketCap) {
                updateData.marketCapEntryTarget = targetMarketCap;
            }

            await TrackedTokenModel.updateOne(
                { telegramId: userId, tokenAddress: tokenAddress.toLowerCase() },
                updateData
            );

            // Clear session data
            delete session.autoTradeSetup;
            global.userSessions.set(userId, session);

            const targetFormatted = targetPrice 
                ? (targetPrice >= 1 ? `$${targetPrice.toFixed(4)}` : `$${targetPrice.toFixed(6)}`)
                : (targetMarketCap ? this.formatNumber(targetMarketCap) : 'N/A');
            await ctx.answerCbQuery('✅ Entry rules saved!', { show_alert: true });
            
            // Show success message and return to auto-trade menu
            const targetLabel = targetPrice ? 'Target Price' : 'Target Market Cap';
            const triggerMessage = targetPrice 
                ? 'The system will automatically buy when the price reaches this target.'
                : 'The system will automatically buy when the market cap reaches this target.';
                
            const message = `✅ **Entry Rules Set Successfully!**\n\n` +
                `**${targetLabel}:** ${targetFormatted}\n` +
                `**Investment Amount:** ${amount} BNB\n\n` +
                triggerMessage;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('🔙 Back to Auto-Trade', `autotrade_rules_${tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error saving entry rules', { error, userId });
            await ctx.answerCbQuery('❌ Error saving entry rules', { show_alert: true });
        }
    }

    /**
     * Handle custom entry price input
     */
    static async handleCustomEntryPrice(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.answerCbQuery('❌ Token price data not found', { show_alert: true });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            const currentPriceFormatted = currentPrice >= 1 ? `$${currentPrice.toFixed(4)}` : `$${currentPrice.toFixed(6)}`;

            // Set up session for custom price input
            let session = global.userSessions.get(userId);
            if (!session) {
                const { WalletService } = await import('@/services/wallet/connect');
                const walletService = new WalletService(global.userSessions);
                await walletService.initializeConnection(userId);
                session = global.userSessions.get(userId);
            }

            if (session) {
                session.autoTradeSetup = {
                    waitingForInput: 'entry_price',
                    tokenAddress: tokenAddress
                };
                global.userSessions.set(userId, session);
            }

            const message = `💰 **Enter Custom Price**\n\n` +
                `**Current Price:** ${currentPriceFormatted}\n\n` +
                `Please enter your target price in USD:\n\n` +
                `**Examples:**\n` +
                `• ${(currentPrice * 0.9).toFixed(6)} (10% below current)\n` +
                `• ${currentPriceFormatted.replace('$', '')} (current price)\n` +
                `• ${(currentPrice * 1.1).toFixed(4)} (10% above current)`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('❌ Cancel', `set_entry_rules_${tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling custom entry price', { error, userId, tokenAddress });
            await ctx.answerCbQuery('❌ Error setting custom price', { show_alert: true });
        }
    }

    /**
     * Handle custom entry amount input
     */
    static async handleCustomEntryAmount(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress || 
                (!session?.autoTradeSetup?.targetPrice && !session?.autoTradeSetup?.targetMarketCap)) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            // Update session to wait for custom amount input
            session.autoTradeSetup.waitingForInput = 'entry_amount';
            global.userSessions.set(userId, session);

            // Format the target (price or market cap based on what's available)
            let targetFormatted: string;
            let targetLabel: string;
            
            if (session.autoTradeSetup.targetPrice) {
                targetFormatted = session.autoTradeSetup.targetPrice >= 1 
                    ? `$${session.autoTradeSetup.targetPrice.toFixed(4)}` 
                    : `$${session.autoTradeSetup.targetPrice.toFixed(6)}`;
                targetLabel = 'Target Price';
            } else if (session.autoTradeSetup.targetMarketCap) {
                targetFormatted = `$${this.formatNumber(session.autoTradeSetup.targetMarketCap)}`;
                targetLabel = 'Market Cap Target';
            } else {
                targetFormatted = 'N/A';
                targetLabel = 'Target';
            }
            
            const message = `💰 **Enter Custom Amount**\n\n` +
                `**${targetLabel}:** ${targetFormatted}\n\n` +
                `Please enter the amount in BNB you want to invest:\n\n` +
                `**Examples:**\n` +
                `• 0.1 (for 0.1 BNB)\n` +
                `• 2.5 (for 2.5 BNB)\n` +
                `• 10 (for 10 BNB)`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('❌ Cancel', `autotrade_rules_${session.autoTradeSetup.tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling custom entry amount', { error, userId });
            await ctx.answerCbQuery('❌ Error setting up custom amount', { show_alert: true });
        }
    }

    /**
     * Handle take profit preset selection using session
     */
    static async handleTakeProfitPreset(ctx: Context, preset: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            const tokenAddress = session.autoTradeSetup.tokenAddress;

            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.answerCbQuery('❌ Token data not found', { show_alert: true });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            let targetPrice: number;
            let description: string;

            switch (preset) {
                case 'plus25':
                    targetPrice = currentPrice * 1.25;
                    description = 'Current price + 25%';
                    break;
                case 'plus50':
                    targetPrice = currentPrice * 1.5;
                    description = 'Current price + 50%';
                    break;
                case 'plus100':
                    targetPrice = currentPrice * 2;
                    description = 'Current price + 100%';
                    break;
                case 'plus200':
                    targetPrice = currentPrice * 3;
                    description = 'Current price + 200%';
                    break;
                case 'plus500':
                    targetPrice = currentPrice * 6;
                    description = 'Current price + 500%';
                    break;
                case 'plus1000':
                    targetPrice = currentPrice * 11;
                    description = 'Current price + 1000%';
                    break;
                default:
                    await ctx.answerCbQuery('❌ Invalid preset', { show_alert: true });
                    return;
            }

            // Save take profit price
            await TrackedTokenModel.updateOne(
                { telegramId: userId, tokenAddress: tokenAddress.toLowerCase() },
                { takeProfitPrice: targetPrice }
            );

            // Clear session
            delete session.autoTradeSetup;
            global.userSessions.set(userId, session);

            await ctx.answerCbQuery('✅ Take profit set!', { show_alert: true });
            
            const message = `✅ **Take Profit Set Successfully!**\n\n` +
                `**Target:** ${description}\n` +
                `**Take Profit Price:** $${targetPrice.toPrecision(6)}\n\n` +
                `The system will automatically sell when this price is reached.`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('🔙 Back to Auto-Trade', `autotrade_rules_${tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling take profit preset', { error, userId, preset });
            await ctx.answerCbQuery('❌ Error setting take profit', { show_alert: true });
        }
    }

    /**
     * Handle custom take profit input
     */
    static async handleCustomTakeProfit(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            // Update session to wait for custom take profit input
            session.autoTradeSetup.waitingForInput = 'take_profit';
            global.userSessions.set(userId, session);

            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: session.autoTradeSetup.tokenAddress.toLowerCase(),
                isActive: true
            });

            const currentPrice = token?.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
            
            const message = `📈 **Enter Custom Take Profit Price**\n\n` +
                `**Current Price:** ${currentPrice}\n\n` +
                `Please enter the price (in USD) at which you want to sell for profit:\n\n` +
                `**Examples:**\n` +
                `• 5.0 (for $5.00 per token)\n` +
                `• 2.85 (for $2.85 per token)\n` +
                `• 10 (for $10.00 per token)`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('❌ Cancel', `autotrade_rules_${session.autoTradeSetup.tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling custom take profit', { error, userId });
            await ctx.answerCbQuery('❌ Error setting up custom take profit', { show_alert: true });
        }
    }

    /**
     * Handle custom stop loss input
     */
    static async handleCustomStopLoss(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            // Update session to wait for custom stop loss input
            session.autoTradeSetup.waitingForInput = 'stop_loss';
            global.userSessions.set(userId, session);

            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: session.autoTradeSetup.tokenAddress.toLowerCase(),
                isActive: true
            });

            const currentPrice = token?.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
            
            const message = `📉 **Enter Custom Stop Loss Price**\n\n` +
                `**Current Price:** ${currentPrice}\n\n` +
                `Please enter the price (in USD) at which you want to sell to limit losses:\n\n` +
                `**Examples:**\n` +
                `• 2.0 (for $2.00 per token)\n` +
                `• 1.5 (for $1.50 per token)\n` +
                `• 0.5 (for $0.50 per token)`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('❌ Cancel', `autotrade_rules_${session.autoTradeSetup.tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling custom stop loss', { error, userId });
            await ctx.answerCbQuery('❌ Error setting up custom stop loss', { show_alert: true });
        }
    }

    /**
     * Handle stop loss preset selection using session
     */
    static async handleStopLossPreset(ctx: Context, preset: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const session = global.userSessions.get(userId);
            if (!session?.autoTradeSetup?.tokenAddress) {
                await ctx.answerCbQuery('❌ Session expired, please try again', { show_alert: true });
                return;
            }

            const tokenAddress = session.autoTradeSetup.tokenAddress;

            const token = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (!token || !token.currentPrice) {
                await ctx.answerCbQuery('❌ Token data not found', { show_alert: true });
                return;
            }

            const currentPrice = parseFloat(token.currentPrice);
            let targetPrice: number;
            let description: string;

            switch (preset) {
                case 'minus5':
                    targetPrice = currentPrice * 0.95;
                    description = 'Current price - 5%';
                    break;
                case 'minus10':
                    targetPrice = currentPrice * 0.9;
                    description = 'Current price - 10%';
                    break;
                case 'minus20':
                    targetPrice = currentPrice * 0.8;
                    description = 'Current price - 20%';
                    break;
                case 'minus30':
                    targetPrice = currentPrice * 0.7;
                    description = 'Current price - 30%';
                    break;
                case 'minus50':
                    targetPrice = currentPrice * 0.5;
                    description = 'Current price - 50%';
                    break;
                case 'minus75':
                    targetPrice = currentPrice * 0.25;
                    description = 'Current price - 75%';
                    break;
                default:
                    await ctx.answerCbQuery('❌ Invalid preset', { show_alert: true });
                    return;
            }

            // Save stop loss price
            await TrackedTokenModel.updateOne(
                { telegramId: userId, tokenAddress: tokenAddress.toLowerCase() },
                { stopLossPrice: targetPrice }
            );

            // Clear session
            delete session.autoTradeSetup;
            global.userSessions.set(userId, session);

            await ctx.answerCbQuery('✅ Stop loss set!', { show_alert: true });
            
            const message = `✅ **Stop Loss Set Successfully!**\n\n` +
                `**Target:** ${description}\n` +
                `**Stop Loss Price:** $${targetPrice.toPrecision(6)}\n\n` +
                `The system will automatically sell when this price is reached to limit losses.`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('🔙 Back to Auto-Trade', `autotrade_rules_${tokenAddress}`)]
                ]
            };

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling stop loss preset', { error, userId, preset });
            await ctx.answerCbQuery('❌ Error setting stop loss', { show_alert: true });
        }
    }
}