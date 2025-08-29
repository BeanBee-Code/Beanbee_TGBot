import { Context, Markup } from 'telegraf';
import { pairDiscoveryService } from './pancakeswap/pairDiscovery';
import { createLogger } from '@/utils/logger';
import { ethers } from 'ethers';
import { TrackedTokenModel } from '@/database/models/TrackedToken';

const logger = createLogger('services.tokenTracking');

export class TokenTrackingService {
    /**
     * Display the token tracking menu with user's tracked tokens
     */
    static async showTokenTrackingMenu(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const trackedTokens = await TrackedTokenModel.find({
                telegramId: userId,
                isActive: true
            }).sort({ createdAt: -1 });

            let message = '🪙 **Token Tracking**\n\n';

            if (trackedTokens.length === 0) {
                message += 'You are not tracking any tokens yet.\n\n';
                message += 'Click "➕ Add Token" to start tracking a token address. You will receive real-time price and trading activity notifications.';
            } else {
                message += `You are tracking ${trackedTokens.length} token${trackedTokens.length > 1 ? 's' : ''}:\n\n`;

                for (const token of trackedTokens.slice(0, 5)) { // Show max 5 tokens
                    const symbol = token.tokenSymbol || 'Unknown';
                    const alias = token.alias ? ` (${token.alias})` : '';
                    const price = token.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
                    const marketCap = token.marketCap ? `$${this.formatMarketCap(token.marketCap)}` : 'N/A';

                    message += `• **${symbol}**${alias}\n`;
                    message += `  └ Address: \`${token.tokenAddress}\`\n`;
                    message += `  └ Price: ${price} | Market Cap: ${marketCap}\n\n`;
                }

                if (trackedTokens.length > 5) {
                    message += `_...and ${trackedTokens.length - 5} more_\n\n`;
                }
            }

            const keyboard = {
                inline_keyboard: [
                    [
                        Markup.button.callback('➕ Add Token', 'add_tracked_token'),
                        ...(trackedTokens.length > 0 ? [Markup.button.callback('📋 Manage', 'manage_tracked_tokens')] : [])
                    ],
                    [
                        ...(trackedTokens.length > 0 ? [Markup.button.callback('🔄 Refresh Prices', 'refresh_token_prices')] : []),
                        Markup.button.callback('🔙 Back to Menu', 'start_edit')
                    ]
                ]
            };

            if (ctx.callbackQuery) {
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
            } else {
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            logger.error('Error showing token tracking menu', { error, userId });
            await ctx.reply('❌ Error loading token tracking menu');
        }
    }

    /**
     * Handle user clicking "Add Token" button
     */
    static async handleAddToken(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const userTokenCount = await TrackedTokenModel.countDocuments({
                telegramId: userId,
                isActive: true
            });

            if (userTokenCount >= 10) {
                await ctx.editMessageText(
                    '❌ **Tracking Limit Reached**\n\nYou can track up to 10 tokens. Please remove some tokens before adding new ones.',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [Markup.button.callback('📋 Manage Tokens', 'manage_tracked_tokens')],
                                [Markup.button.callback('🔙 Back', 'track_token')]
                            ]
                        }
                    }
                );
                return;
            }

            // Set user session to expect token address input
            let session = global.userSessions.get(userId);
            if (!session) {
                const { WalletService } = await import('./wallet/connect');
                const walletService = new WalletService(global.userSessions);
                await walletService.initializeConnection(userId);
                session = global.userSessions.get(userId);
            }

            if (session) {
                session.waitingForTokenAddress = true;
                global.userSessions.set(userId, session);
            }

            const message = '🪙 **Add Token to Track**\n\n' +
                'Please enter the token contract address you want to track.\n\n' +
                '**Requirements:**\n' +
                '• Must be a valid BSC (BEP-20) contract address\n' +
                '• Must start with "0x" followed by 40 characters\n' +
                '• Token must have liquidity on PancakeSwap\n\n' +
                '**Example:**\n' +
                '`0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82` (CAKE)';

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

    /**
     * Handle user input of token address
     */
    static async handleTokenAddressInput(ctx: Context, address: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        // Clear the waiting state
        const session = global.userSessions.get(userId);
        if (session) {
            session.waitingForTokenAddress = false;
        }

        try {
            // Validate address format
            if (!ethers.isAddress(address)) {
                await ctx.reply('❌ Invalid token address. Please enter a valid BSC contract address.', {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('🔙 Back', 'track_token')]
                        ]
                    }
                });
                return;
            }

            // Check if already tracking this token
            const existingToken = await TrackedTokenModel.findOne({
                telegramId: userId,
                tokenAddress: address.toLowerCase(),
                isActive: true
            });

            if (existingToken) {
                await ctx.reply('⚠️ You are already tracking this token address.');
                await this.showTokenTrackingMenu(ctx);
                return;
            }

            // Show processing message
            const processingMsg = await ctx.reply('🔍 **Discovering token information...**\n\nThis may take a moment, we are:\n• Verifying token contract\n• Finding best trading pairs\n• Calculating current price');

            // Discover token information and pairs
            const tokenInfo = await pairDiscoveryService.discoverTokenPair(address);

            // Remove processing message
            if (typeof processingMsg !== 'boolean' && processingMsg.message_id) {
                await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
            }

            if (!tokenInfo || !tokenInfo.bestPair) {
                await ctx.reply(
                    '❌ **Token Not Supported**\n\nThis token might:\n• Not exist or not be a valid BEP-20 token\n• Have no liquidity on PancakeSwap\n• Cannot be properly analyzed\n\nPlease try a different token address.',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [Markup.button.callback('🔄 Try Again', 'add_tracked_token')],
                                [Markup.button.callback('🔙 Back', 'track_token')]
                            ]
                        }
                    }
                );
                return;
            }

            // Save to database
            const newToken = await TrackedTokenModel.create({
                telegramId: userId,
                tokenAddress: tokenInfo.address.toLowerCase(),
                pairAddress: tokenInfo.bestPair.pairAddress,
                pairedToken: tokenInfo.bestPair.pairedToken,
                tokenSymbol: tokenInfo.symbol,
                tokenName: tokenInfo.name,
                totalSupply: tokenInfo.totalSupply,
                currentPrice: tokenInfo.currentPrice,
                marketCap: tokenInfo.marketCap,
                isActive: true
            });

            // Initialize monitoring
            await this.initializeTokenMonitoring(tokenInfo.address, tokenInfo.bestPair.pairAddress, tokenInfo.symbol, tokenInfo.bestPair.pairedToken);

            // Format response with USD pricing
            const price = tokenInfo.currentPrice ? `$${parseFloat(tokenInfo.currentPrice).toPrecision(6)}` : 'N/A';
            const marketCap = tokenInfo.marketCap ? `$${this.formatMarketCap(tokenInfo.marketCap)}` : 'N/A';

            const message = `✅ **Token Added Successfully!**\n\n` +
                `**${tokenInfo.symbol}** - ${tokenInfo.name}\n` +
                `Address: \`${tokenInfo.address}\`\n\n` +
                `**Trading Information:**\n` +
                `• Trading Pair: ${tokenInfo.symbol}/${tokenInfo.bestPair.pairedToken}\n` +
                `• Current Price: ${price}\n` +
                `• Market Cap: ${marketCap}\n\n` +
                `🔔 **You will now receive notifications for:**\n` +
                `• Significant price changes (±5%) - Testing Mode\n` +
                `• Large buy/sell transactions`;

            const keyboard = {
                inline_keyboard: [
                    [Markup.button.callback('➕ Add Another', 'add_tracked_token')],
                    [Markup.button.callback('🔙 Back', 'track_token')]
                ]
            };

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            logger.error('Error handling token address input', { error, userId, address });
            await ctx.reply('❌ Error adding token to tracking list.');
        }
    }

    /**
     * Manage tracked tokens (for removal)
     */
    static async handleManageTokens(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const trackedTokens = await TrackedTokenModel.find({
                telegramId: userId,
                isActive: true
            }).sort({ createdAt: -1 });

            if (trackedTokens.length === 0) {
                await this.showTokenTrackingMenu(ctx);
                return;
            }

            let message = '📋 **Manage Tracked Tokens**\n\nSelect an action for each token:\n\n';

            const buttons = trackedTokens.map(token => {
                const symbol = token.tokenSymbol || 'Unknown';
                const alias = token.alias ? ` (${token.alias})` : '';
                const autoTradeStatus = token.isAutoTradeActive ? ' 🤖' : '';
                return [
                    Markup.button.callback(
                        `⚙️ ${symbol}${alias}${autoTradeStatus}`,
                        `autotrade_rules_${token.tokenAddress}`
                    ),
                    Markup.button.callback(
                        `❌ Remove`,
                        `remove_token_${token.tokenAddress}`
                    )
                ];
            });

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

    /**
     * Remove token from tracking list
     */
    static async handleRemoveToken(ctx: Context, tokenAddress: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            // Actually delete the token from the database
            await TrackedTokenModel.deleteOne({
                telegramId: userId,
                tokenAddress: tokenAddress.toLowerCase()
            });

            // Stop monitoring if no other users are tracking this token
            await this.decommissionTokenMonitoring(tokenAddress);

            await ctx.answerCbQuery('✅ Token removed', { show_alert: true });
            await this.showTokenTrackingMenu(ctx); // Refresh the menu
        } catch (error) {
            logger.error('Error removing token', { error, userId, tokenAddress });
            await ctx.reply('❌ Error removing token');
        }
    }

    /**
     * Refresh prices for all user's tracked tokens (with USD conversion)
     */
    static async refreshTokenPrices(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            await ctx.answerCbQuery('🔄 Refreshing prices...');
            const processingMsg = await ctx.editMessageText('🔄 Refreshing token prices and converting to USD...');

            const trackedTokens = await TrackedTokenModel.find({
                telegramId: userId,
                isActive: true
            });

            let updatedCount = 0;
            const promises = trackedTokens.map(async (token) => {
                try {
                    logger.info(`Refreshing ${token.tokenSymbol} (${token.tokenAddress}) with USD conversion`);
                    const tokenInfo = await pairDiscoveryService.discoverTokenPair(token.tokenAddress);
                    if (tokenInfo && tokenInfo.currentPrice && tokenInfo.marketCap) {
                        const oldPrice = token.currentPrice;
                        const oldMarketCap = token.marketCap;
                        
                        token.currentPrice = tokenInfo.currentPrice;
                        token.marketCap = tokenInfo.marketCap;
                        token.updatedAt = new Date();
                        await token.save();
                        updatedCount++;
                        
                        logger.info(`Updated ${token.tokenSymbol}: Price ${oldPrice} → ${tokenInfo.currentPrice}, Market Cap ${oldMarketCap} → ${tokenInfo.marketCap}`);
                    }
                } catch (e) {
                    logger.warn('Error updating token price', { error: e, tokenAddress: token.tokenAddress });
                }
            });

            await Promise.all(promises);

            if (typeof processingMsg !== 'boolean' && processingMsg.message_id) {
                await ctx.deleteMessage(processingMsg.message_id).catch(() => { });
            }
            await ctx.reply(`✅ Successfully refreshed ${updatedCount} token prices with USD conversion.`);
            await this.showTokenTrackingMenu(ctx);

        } catch (error) {
            logger.error('Error refreshing token prices', { error, userId });
            await ctx.reply('❌ Error refreshing token prices');
        }
    }

    /**
     * Send price change alert to users tracking the token
     */
    static async sendPriceAlert(tokenAddress: string, priceChange: number, currentPrice: string): Promise<void> {
        try {
            const watchers = await TrackedTokenModel.find({
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (watchers.length === 0) return;

            for (const watcher of watchers) {
                let newMarketCap = 'N/A';
                let newMarketCapValue: string | undefined = undefined;

                // Dynamically calculate the new market cap using current price and total supply
                if (watcher.totalSupply && watcher.tokenSymbol) {
                    try {
                        // Most BEP-20 tokens have 18 decimals
                        const decimals = 18;
                        const priceNum = parseFloat(currentPrice);

                        // Use ethers to handle large numbers safely
                        const totalSupplyFormatted = parseFloat(ethers.formatUnits(watcher.totalSupply, decimals));
                        const marketCapNum = priceNum * totalSupplyFormatted;

                        newMarketCapValue = marketCapNum.toString();
                        newMarketCap = this.formatMarketCap(newMarketCapValue);
                    } catch (calcError) {
                        logger.warn('Error calculating market cap, falling back to stored value', { 
                            error: calcError, 
                            tokenAddress: watcher.tokenAddress,
                            currentPrice,
                            totalSupply: watcher.totalSupply 
                        });
                        // Fallback to stored market cap if calculation fails
                        newMarketCap = watcher.marketCap ? this.formatMarketCap(watcher.marketCap) : 'N/A';
                    }
                } else {
                    // Fallback to stored market cap if total supply is not available
                    newMarketCap = watcher.marketCap ? this.formatMarketCap(watcher.marketCap) : 'N/A';
                }

                // Update notification stats and store the new price and market cap
                watcher.notificationCount++;
                watcher.lastNotified = new Date();
                watcher.currentPrice = currentPrice;
                if (newMarketCapValue) {
                    watcher.marketCap = newMarketCapValue; // Persist the new market cap
                }
                await watcher.save();

                // Send notification to user with the dynamically calculated market cap
                await this.sendTokenNotification(watcher.telegramId, watcher, priceChange, newMarketCap);
            }
        } catch (error) {
            logger.error('Error sending price alert', { error, tokenAddress });
        }
    }

    /**
     * Send notification to individual user
     */
    private static async sendTokenNotification(telegramId: number, token: any, priceChange: number, marketCap: string): Promise<void> {
        try {
            const bot = (globalThis as any).botExport;
            if (!bot) return;

            const symbol = token.tokenSymbol || 'Unknown';
            const price = token.currentPrice ? `$${parseFloat(token.currentPrice).toPrecision(6)}` : 'N/A';
            const changeEmoji = priceChange >= 0 ? '🟢' : '🔴';
            const changeText = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;

            const chartUrl = `https://dexscreener.com/bsc/${token.tokenAddress}`;
            const message = `${changeEmoji} **${symbol} Price Alert**\n\n` +
                `Price: ${price} (${changeText})\n` +
                `Market Cap: $${marketCap}\n\n` +
                `Contract: \`${token.tokenAddress}\`\n\n` +
                `📊 [See the chart on DexScreener](${chartUrl})`;

            const keyboard = {
                inline_keyboard: [
                    [
                        Markup.button.callback('📋 Manage', 'manage_tracked_tokens')
                    ]
                ]
            };

            await bot.telegram.sendMessage(telegramId, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
                disable_web_page_preview: true
            });
        } catch (error) {
            logger.error('Error sending token notification', { error, telegramId });
        }
    }

    /**
     * Initialize monitoring for a new token
     */
    private static async initializeTokenMonitoring(tokenAddress: string, pairAddress: string, symbol?: string, pairedToken?: string): Promise<void> {
        try {
            logger.info('Initializing token monitoring', { tokenAddress, pairAddress });

            // Import and add to monitoring
            const { tokenPriceMonitor } = await import('./tokenPriceMonitor');
            await tokenPriceMonitor.addTokenToMonitoring(tokenAddress, pairAddress, symbol, pairedToken);

            logger.info('Successfully added token to monitoring', { tokenAddress });
        } catch (error) {
            logger.error('Error initializing token monitoring', { error, tokenAddress });
        }
    }

    /**
     * Stop monitoring token if no users are tracking it
     */
    private static async decommissionTokenMonitoring(tokenAddress: string): Promise<void> {
        try {
            // Check if any other users are still tracking this token
            const count = await TrackedTokenModel.countDocuments({
                tokenAddress: tokenAddress.toLowerCase(),
                isActive: true
            });

            if (count === 0) {
                logger.info('Stopping token monitoring as no users are tracking it', { tokenAddress });

                const { tokenPriceMonitor } = await import('./tokenPriceMonitor');
                await tokenPriceMonitor.removeTokenFromMonitoring(tokenAddress);
            }
        } catch (error) {
            logger.error('Error decommissioning token monitoring', { error, tokenAddress });
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
     * Convert existing BNB-priced tokens to USD values
     */
    static async convertExistingTokensToUSD(): Promise<void> {
        try {
            logger.info('Starting conversion of existing tokens to USD pricing');

            // Find all tokens that might have BNB-based pricing (low prices suggest BNB pricing)
            const tokensToUpdate = await TrackedTokenModel.find({
                isActive: true,
                currentPrice: { $exists: true },
                $or: [
                    { currentPrice: { $lt: "1" } }, // Prices less than $1 might be in BNB
                    { pairedToken: 'WBNB' } // Explicitly WBNB paired tokens
                ]
            });

            logger.info(`Found ${tokensToUpdate.length} tokens to potentially update`);

            let updatedCount = 0;
            for (const token of tokensToUpdate) {
                try {
                    logger.info(`Updating token: ${token.tokenSymbol} (${token.tokenAddress})`);
                    const tokenInfo = await pairDiscoveryService.discoverTokenPair(token.tokenAddress);
                    
                    if (tokenInfo && tokenInfo.currentPrice && tokenInfo.marketCap) {
                        const oldPrice = token.currentPrice;
                        const oldMarketCap = token.marketCap;
                        
                        token.currentPrice = tokenInfo.currentPrice;
                        token.marketCap = tokenInfo.marketCap;
                        token.updatedAt = new Date();
                        await token.save();
                        
                        logger.info(`Updated ${token.tokenSymbol}: Price ${oldPrice} → ${tokenInfo.currentPrice}, Market Cap ${oldMarketCap} → ${tokenInfo.marketCap}`);
                        updatedCount++;
                    }
                } catch (error) {
                    logger.error(`Error updating token ${token.tokenAddress}:`, error);
                }
            }

            logger.info(`Successfully updated ${updatedCount} tokens to USD pricing`);
        } catch (error) {
            logger.error('Error converting existing tokens to USD:', error);
        }
    }
}