import { Markup, Context } from "telegraf";
import { getUserLanguage, t, interpolate } from '../../i18n';
import { opbnbService } from '../../services/nodereal/opbnbService';
import { opbnbAnalytics } from '../../services/opbnb/analyticsService';
import { formatBNBBalance, formatUSDValue } from '../../services/wallet/balance';
import { UserService } from '../../services/user';

export async function opbnbDashboard(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Get wallet addresses
    const session = global.userSessions?.get(userId);
    const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);
    const tradingWallet = await UserService.getTradingWalletAddress(userId);
    
    // Fetch balances for both wallets on opBNB
    let mainBalance: { balance: string; formatted: string; usdValue?: number } = { balance: '0', formatted: '0 BNB', usdValue: 0 };
    let tradingBalance: { balance: string; formatted: string; usdValue?: number } = { balance: '0', formatted: '0 BNB', usdValue: 0 };
    
    try {
        if (mainWallet) {
            mainBalance = await opbnbService.getNativeBalance(mainWallet);
        }
        if (tradingWallet) {
            tradingBalance = await opbnbService.getNativeBalance(tradingWallet);
        }
    } catch (error) {
        console.error('Error fetching opBNB balances:', error);
    }
    
    // Build message with wallet balances
    let message = lang === 'zh' 
        ? `🔗 *opBNB 控制台*\n\n`
        : `🔗 *opBNB Dashboard*\n\n`;
    
    // Add wallet section
    message += lang === 'zh' ? `💳 钱包:\n` : `💳 Wallets:\n`;
    
    if (mainWallet) {
        const mainBNB = parseFloat(mainBalance.formatted.replace(' BNB', ''));
        message += lang === 'zh' 
            ? `• 主钱包: \`${mainWallet}\`\n  └ ${formatBNBBalance(mainBNB.toString())} BNB`
            : `• Main: \`${mainWallet}\`\n  └ ${formatBNBBalance(mainBNB.toString())} BNB`;
        if (mainBalance.usdValue && mainBalance.usdValue > 0) {
            message += ` (${formatUSDValue(mainBalance.usdValue)})`;
        }
        message += '\n';
    } else {
        message += lang === 'zh' 
            ? `• 主钱包: 未连接\n`
            : `• Main: Not connected\n`;
    }
    
    if (tradingWallet) {
        const tradingBNB = parseFloat(tradingBalance.formatted.replace(' BNB', ''));
        message += lang === 'zh' 
            ? `• 交易钱包: \`${tradingWallet}\`\n  └ ${formatBNBBalance(tradingBNB.toString())} BNB`
            : `• Trading: \`${tradingWallet}\`\n  └ ${formatBNBBalance(tradingBNB.toString())} BNB`;
        if (tradingBalance.usdValue && tradingBalance.usdValue > 0) {
            message += ` (${formatUSDValue(tradingBalance.usdValue)})`;
        }
        message += '\n';
    } else {
        message += lang === 'zh' 
            ? `• 交易钱包: 未创建\n`
            : `• Trading: Not created\n`;
    }
    
    message += '\n';
    message += lang === 'zh' 
        ? `欢迎使用 opBNB Layer 2 功能！\n\n请选择您想要执行的操作：`
        : `Welcome to opBNB Layer 2 functionality!\n\nPlease select the action you want to perform:`;

    const inlineKeyboard = [
        [
            Markup.button.callback(
                lang === 'zh' ? '💰 查看持仓' : '💰 Check Holdings',
                'opbnb_check_holdings'
            ),
            Markup.button.callback(
                lang === 'zh' ? '📊 交易历史' : '📊 Transaction History',
                'opbnb_transaction_history_menu'
            )
        ],
        [
            Markup.button.callback(
                lang === 'zh' ? '🐋 巨鲸追踪' : '🐋 Whale Tracker',
                'opbnb_whale_tracker'
            ),
            Markup.button.callback(
                lang === 'zh' ? '🔥 热门代币' : '🔥 Hot Tokens',
                'opbnb_hot_tokens'
            )
        ],
        [
            Markup.button.callback(
                lang === 'zh' ? '💊 代币健康检查' : '💊 Token Health Check',
                'opbnb_token_health'
            )
        ],
        [
            Markup.button.callback(
                lang === 'zh' ? '🔙 返回主菜单' : '🔙 Back to Main Menu',
                'main_menu'
            )
        ]
    ];

    const keyboard = {
        inline_keyboard: inlineKeyboard
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}

// Check Holdings menu - allows user to choose main wallet or enter custom address
export async function opbnbCheckHoldings(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Set up session for waiting for address input
    const session = global.userSessions.get(userId) || {};
    session.waitingForOpbnbAddress = true;
    session.opbnbAction = 'holdings';
    global.userSessions.set(userId, session);
    
    // Get connected wallet addresses
    const { UserService } = await import('../../services/user');
    const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);

    const message = lang === 'zh' 
        ? `💰 *查看 opBNB 持仓*

${mainWallet ? `您可以使用已连接的主钱包，或直接输入自定义钱包地址：

示例: \`0x1234567890123456789012345678901234567890\`` : `请输入 opBNB 钱包地址：

示例: \`0x1234567890123456789012345678901234567890\``}`
        : `💰 *Check opBNB Holdings*

${mainWallet ? `You can use your connected main wallet or directly enter a custom wallet address:

Example: \`0x1234567890123456789012345678901234567890\`` : `Please enter the opBNB wallet address:

Example: \`0x1234567890123456789012345678901234567890\``}`;

    const inlineKeyboard = [];

    // Add main wallet option if available
    if (mainWallet) {
        inlineKeyboard.push([
            Markup.button.callback(
                lang === 'zh' ? '💳 使用主钱包' : '💳 Use Main Wallet',
                'opbnb_holdings_main_wallet'
            )
        ]);
    }

    // Back button
    inlineKeyboard.push([
        Markup.button.callback(
            lang === 'zh' ? '🔙 返回 opBNB 控制台' : '🔙 Back to opBNB Dashboard',
            'opbnb_dashboard'
        )
    ]);

    const keyboard = {
        inline_keyboard: inlineKeyboard
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}

// Transaction History menu - similar structure to Check Holdings
export async function opbnbTransactionHistoryMenu(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Set up session for waiting for address input
    const session = global.userSessions.get(userId) || {};
    session.waitingForOpbnbAddress = true;
    session.opbnbAction = 'transactions';
    global.userSessions.set(userId, session);
    
    // Get connected wallet addresses
    const { UserService } = await import('../../services/user');
    const mainWallet = session?.address || await UserService.getMainWalletAddress(userId);

    const message = lang === 'zh' 
        ? `📊 *查看 opBNB 交易历史*

${mainWallet ? `您可以使用已连接的主钱包，或直接输入自定义钱包地址：

示例: \`0x1234567890123456789012345678901234567890\`` : `请输入 opBNB 钱包地址：

示例: \`0x1234567890123456789012345678901234567890\``}`
        : `📊 *Check opBNB Transaction History*

${mainWallet ? `You can use your connected main wallet or directly enter a custom wallet address:

Example: \`0x1234567890123456789012345678901234567890\`` : `Please enter the opBNB wallet address:

Example: \`0x1234567890123456789012345678901234567890\``}`;

    const inlineKeyboard = [];

    // Add main wallet option if available
    if (mainWallet) {
        inlineKeyboard.push([
            Markup.button.callback(
                lang === 'zh' ? '💳 使用主钱包' : '💳 Use Main Wallet',
                'opbnb_transactions_main_wallet'
            )
        ]);
    }

    // Back button
    inlineKeyboard.push([
        Markup.button.callback(
            lang === 'zh' ? '🔙 返回 opBNB 控制台' : '🔙 Back to opBNB Dashboard',
            'opbnb_dashboard'
        )
    ]);

    const keyboard = {
        inline_keyboard: inlineKeyboard
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}


// Function to display holdings only
export async function showOpbnbHoldings(ctx: Context, walletAddress: string, walletType: string = 'Custom') {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Validate wallet address
    if (!walletAddress || walletAddress === 'stored' || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
        console.error('Invalid wallet address provided to showOpbnbHoldings:', walletAddress);
        const lang = await getUserLanguage(userId);
        const errorMessage = lang === 'zh'
            ? '❌ 无效的钱包地址\n\n请提供有效的 opBNB 钱包地址。'
            : '❌ Invalid wallet address\n\nPlease provide a valid opBNB wallet address.';
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        callback_data: 'opbnb_check_holdings'
                    }]
                ]
            }
        });
        return;
    }

    const lang = await getUserLanguage(userId);

    // Store the address in session FIRST, before any operations (with validation)
    const session = global.userSessions.get(userId) || {};
    // NEVER store "stored" as an address
    if (walletAddress !== 'stored' && /^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
        session.opbnbLastScanned = walletAddress;
        global.userSessions.set(userId, session);
        
        console.log('showOpbnbHoldings - Storing address in session:', {
            userId,
            walletAddress,
            walletType
        });
    } else {
        console.error('showOpbnbHoldings - Invalid address, not storing:', walletAddress);
    }

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在查看 opBNB 持仓...\n\n钱包: \`${opbnbService.shortenAddress(walletAddress)}\``
            : `⏳ Loading opBNB holdings...\n\nWallet: \`${opbnbService.shortenAddress(walletAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Fetch holdings data
        const [nativeBalance, tokens] = await Promise.all([
            opbnbService.getNativeBalance(walletAddress),
            opbnbService.getTokenBalances(walletAddress)
        ]);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Build holdings report
        let message = lang === 'zh'
            ? `💰 *opBNB 持仓报告*\n\n`
            : `💰 *opBNB Holdings Report*\n\n`;

        message += lang === 'zh'
            ? `📍 钱包地址 (${walletType === 'Main' ? '主钱包' : walletType === 'Trading' ? '交易钱包' : '自定义'}):\n\`${walletAddress}\`\n\n`
            : `📍 Wallet Address (${walletType}):\n\`${walletAddress}\`\n\n`;

        // Native Balance Section
        message += lang === 'zh' ? `💎 *原生 BNB 余额*\n` : `💎 *Native BNB Balance*\n`;
        message += `${nativeBalance.formatted}`;
        if (nativeBalance.usdValue) {
            message += ` ≈ $${nativeBalance.usdValue.toFixed(2)}`;
        }
        message += '\n\n';

        // Token Holdings Section
        message += lang === 'zh' ? `🪙 *代币持有 (${tokens.length})*\n` : `🪙 *Token Holdings (${tokens.length})*\n`;
        
        if (tokens.length === 0) {
            message += lang === 'zh' 
                ? '_无代币余额_\n\n'
                : '_No token balances_\n\n';
        } else {
            // Calculate total portfolio value with improved debugging
            let totalValue = nativeBalance.usdValue || 0;
            console.log('opBNB Holdings calculation:', {
                nativeUsdValue: nativeBalance.usdValue,
                tokensCount: tokens.length,
                tokens: tokens.map(t => ({ symbol: t.symbol, usdValue: t.usdValue, formatted: t.formatted }))
            });
            
            tokens.forEach(token => {
                if (token.usdValue && typeof token.usdValue === 'number' && !isNaN(token.usdValue)) {
                    totalValue += token.usdValue;
                }
            });

            if (totalValue > 0) {
                message += lang === 'zh' 
                    ? `💼 总价值: *$${totalValue.toFixed(2)}*\n\n`
                    : `💼 Total Value: *$${totalValue.toFixed(2)}*\n\n`;
            }

            // Show top 10 tokens with clickable links
            const topTokens = tokens.slice(0, 10);
            topTokens.forEach((token, index) => {
                const value = token.usdValue ? ` ($${token.usdValue.toFixed(2)})` : '';
                const tokenLink = `https://opbnbscan.com/token/${token.contractAddress}`;
                message += `${index + 1}. [${token.symbol}](${tokenLink}) - ${token.formatted}${value}\n`;
            });

            if (tokens.length > 10) {
                message += lang === 'zh' 
                    ? `\n_...还有 ${tokens.length - 10} 个其他代币_\n`
                    : `\n_...and ${tokens.length - 10} more tokens_\n`;
            }
            message += '\n';
        }

        const keyboard = {
            inline_keyboard: [
                // Main action buttons (removed copy button as address is already copyable in context)
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        walletType === 'Main' ? 'opbnb_holdings_main_wallet' : 'opbnb_holdings_custom_address'
                    ),
                    Markup.button.callback(
                        lang === 'zh' ? '📊 查看交易历史' : '📊 View Transactions',
                        'opbnb_show_transactions_stored'
                    )
                ],
                // Back button
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        // Address already stored in session at the beginning of the function

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error fetching opBNB holdings:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 获取持仓时出错\n\n请检查地址是否正确并稍后重试。`
            : `❌ Error fetching holdings\n\nPlease check the address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回持仓菜单' : '🔙 Back to Holdings',
                        'opbnb_check_holdings'
                    )]
                ]
            }
        });
    }
}

// Function to display transaction history only
export async function showOpbnbTransactions(ctx: Context, walletAddress: string, walletType: string = 'Custom') {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Validate wallet address
    if (!walletAddress || walletAddress === 'stored' || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
        console.error('Invalid wallet address provided to showOpbnbTransactions:', walletAddress);
        const lang = await getUserLanguage(userId);
        const errorMessage = lang === 'zh'
            ? '❌ 无效的钱包地址\n\n请提供有效的 opBNB 钱包地址。'
            : '❌ Invalid wallet address\n\nPlease provide a valid opBNB wallet address.';
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        callback_data: 'opbnb_transaction_history_menu'
                    }]
                ]
            }
        });
        return;
    }

    const lang = await getUserLanguage(userId);

    // Store the address in session FIRST, before any operations (with validation)
    const session = global.userSessions.get(userId) || {};
    // NEVER store "stored" as an address
    if (walletAddress !== 'stored' && /^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
        session.opbnbLastScanned = walletAddress;
        global.userSessions.set(userId, session);
        
        console.log('showOpbnbTransactions - Storing address in session:', {
            userId,
            walletAddress,
            walletType
        });
    } else {
        console.error('showOpbnbTransactions - Invalid address, not storing:', walletAddress);
    }

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在查看 opBNB 交易历史...\n\n钱包: \`${opbnbService.shortenAddress(walletAddress)}\``
            : `⏳ Loading opBNB transaction history...\n\nWallet: \`${opbnbService.shortenAddress(walletAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Fetch transaction history
        const transactions = await opbnbService.getTransactionHistory(walletAddress, 10);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Build transaction report using BNB transaction history format
        let message = lang === 'zh'
            ? '📜 *opBNB 交易历史*\n'
            : '📜 *opBNB Transaction History*\n';
        
        message += `${t(lang, 'transactionHistory.wallet')} \`${walletAddress}\`\n`;
        
        if (walletType !== 'Custom') {
            const walletTypeText = walletType === 'Main' 
                ? (lang === 'zh' ? '主钱包' : 'Main Wallet')
                : (lang === 'zh' ? '交易钱包' : 'Trading Wallet');
            message += `📍 (${walletTypeText})\n`;
        }
        message += '\n';

        // Transaction History Section (formatted consistently with main dashboard)
        if (transactions.length === 0) {
            message += `_${t(lang, 'transactionHistory.noTransactions')}_\n\n`;
            message += `🔗 [${t(lang, 'transactionHistory.viewOnBSCScan').replace('BSCScan', 'opBNBScan')}](https://opbnbscan.com/address/${walletAddress})`;
        } else {
            const showingText = interpolate(t(lang, 'transactionHistory.showing'), { count: transactions.length });
            message += `_${showingText}_\n\n`;
                
            transactions.forEach((tx, index) => {
                const date = new Date(tx.timestamp).toLocaleDateString();
                const time = new Date(tx.timestamp).toLocaleTimeString();
                
                message += `*${index + 1}* ${date} ${time}\n`;
                
                // Transaction type with status
                const status = tx.successful ? '✅' : '❌';
                const isOutgoing = tx.from.toLowerCase() === walletAddress.toLowerCase();
                const direction = isOutgoing ? 'Sent' : 'Received';
                const typeText = `${status} ${direction}`;
                message += `${t(lang, 'transactionHistory.type')} *${typeText}*\n`;
                
                // Hash
                message += `${t(lang, 'transactionHistory.hash')} \`${tx.hash}\`\n`;
                
                // BNB value if any
                if (parseFloat(tx.formattedValue) > 0) {
                    message += `${t(lang, 'transactionHistory.value')} *${tx.formattedValue} BNB*\n`;
                }
                
                // Token transfers if any
                if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
                    message += `${t(lang, 'transactionHistory.tokenTransfers')}\n`;
                    for (const transfer of tx.tokenTransfers) {
                        const transferDirection = transfer.from.toLowerCase() === walletAddress.toLowerCase() 
                            ? t(lang, 'transactionHistory.sent') 
                            : t(lang, 'transactionHistory.received');
                        message += `  • ${transferDirection} ${transfer.amount} ${transfer.symbol}\n`;
                    }
                }
                
                // From/To addresses
                message += `${t(lang, 'transactionHistory.from')} \`${tx.from}\`\n`;
                message += `${t(lang, 'transactionHistory.to')} \`${tx.to}\`\n`;
                
                // Gas fee as a note (optional display)
                if (parseFloat(tx.formattedFees) > 0) {
                    message += `📝 Gas: ${tx.formattedFees} BNB\n`;
                }
                
                message += "\n";
            });
            
            // Add opBNBScan link at the end
            message += `🔗 [${t(lang, 'transactionHistory.viewAllTransactions').replace('BSCScan', 'opBNBScan')}](https://opbnbscan.com/address/${walletAddress})`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        walletType === 'Main' ? 'opbnb_transactions_main_wallet' : 'opbnb_transactions_custom_address'
                    ),
                    Markup.button.callback(
                        lang === 'zh' ? '💰 查看持仓' : '💰 View Holdings',
                        'opbnb_show_holdings_stored'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        // Address already stored in session at the beginning of the function

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error fetching opBNB transactions:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 获取交易历史时出错\n\n请检查地址是否正确并稍后重试。`
            : `❌ Error fetching transaction history\n\nPlease check the address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回交易菜单' : '🔙 Back to Transactions',
                        'opbnb_transaction_history_menu'
                    )]
                ]
            }
        });
    }
}

// Legacy scan function for compatibility - now combines holdings and transactions
export async function scanOpbnbWallet(ctx: Context, walletAddress: string, walletType: string = 'Custom') {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在扫描 opBNB 钱包...\n\n钱包: \`${opbnbService.shortenAddress(walletAddress)}\``
            : `⏳ Scanning opBNB wallet...\n\nWallet: \`${opbnbService.shortenAddress(walletAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Fetch all data in parallel
        const [nativeBalance, tokens, transactions] = await Promise.all([
            opbnbService.getNativeBalance(walletAddress),
            opbnbService.getTokenBalances(walletAddress),
            opbnbService.getTransactionHistory(walletAddress, 3)
        ]);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Build comprehensive report
        let message = lang === 'zh'
            ? `📊 *opBNB 钱包分析报告*\n\n`
            : `📊 *opBNB Wallet Analysis Report*\n\n`;

        message += lang === 'zh'
            ? `📍 钱包地址 (${walletType === 'Main' ? '主钱包' : walletType === 'Trading' ? '交易钱包' : '自定义'}):\n\`${walletAddress}\`\n\n`
            : `📍 Wallet Address (${walletType}):\n\`${walletAddress}\`\n\n`;

        // Native Balance Section
        message += lang === 'zh' ? `💰 *原生 BNB 余额*\n` : `💰 *Native BNB Balance*\n`;
        message += `${nativeBalance.formatted}`;
        if (nativeBalance.usdValue) {
            message += ` ≈ $${nativeBalance.usdValue.toFixed(2)}`;
        }
        message += '\n\n';

        // Token Holdings Section
        message += lang === 'zh' ? `🪙 *代币持有 (${tokens.length})*\n` : `🪙 *Token Holdings (${tokens.length})*\n`;
        
        if (tokens.length === 0) {
            message += lang === 'zh' 
                ? '_无代币余额_\n\n'
                : '_No token balances_\n\n';
        } else {
            // Calculate total portfolio value with improved debugging
            let totalValue = nativeBalance.usdValue || 0;
            console.log('opBNB Holdings calculation:', {
                nativeUsdValue: nativeBalance.usdValue,
                tokensCount: tokens.length,
                tokens: tokens.map(t => ({ symbol: t.symbol, usdValue: t.usdValue, formatted: t.formatted }))
            });
            
            tokens.forEach(token => {
                if (token.usdValue && typeof token.usdValue === 'number' && !isNaN(token.usdValue)) {
                    totalValue += token.usdValue;
                }
            });

            if (totalValue > 0) {
                message += lang === 'zh' 
                    ? `💼 总价值: *$${totalValue.toFixed(2)}*\n\n`
                    : `💼 Total Value: *$${totalValue.toFixed(2)}*\n\n`;
            }

            // Show top 5 tokens
            const topTokens = tokens.slice(0, 5);
            topTokens.forEach((token, index) => {
                const value = token.usdValue ? ` ($${token.usdValue.toFixed(2)})` : '';
                message += `${index + 1}. *${token.symbol}* - ${token.formatted}${value}\n`;
            });

            if (tokens.length > 5) {
                message += lang === 'zh' 
                    ? `\n_...还有 ${tokens.length - 5} 个其他代币_\n`
                    : `\n_...and ${tokens.length - 5} more tokens_\n`;
            }
            message += '\n';
        }

        // Recent Activity Section
        message += lang === 'zh' ? `📈 *最近活动*\n` : `📈 *Recent Activity*\n`;
        
        if (transactions.length === 0) {
            message += lang === 'zh' 
                ? '_无最近交易_\n'
                : '_No recent transactions_\n';
        } else {
            message += lang === 'zh' 
                ? `最近 ${transactions.length} 笔交易:\n`
                : `Last ${transactions.length} transactions:\n`;
            
            transactions.forEach(tx => {
                const status = tx.successful ? '✅' : '❌';
                const type = tx.from.toLowerCase() === walletAddress.toLowerCase() ? '↗️' : '↘️';
                message += `${status} ${type} ${tx.formattedValue} BNB\n`;
            });
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        `opbnb_refresh_${walletAddress}`
                    ),
                    Markup.button.callback(
                        lang === 'zh' ? '📋 详细信息' : '📋 Details',
                        'opbnb_detailed_view'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔍 扫描其他地址' : '🔍 Scan Another',
                        'opbnb_dashboard'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回主菜单' : '🔙 Back to Main Menu',
                        'main_menu'
                    )
                ]
            ]
        };

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error scanning opBNB wallet:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 扫描钱包时出错\n\n请检查地址是否正确并稍后重试。`
            : `❌ Error scanning wallet\n\nPlease check the address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        'opbnb_dashboard'
                    )]
                ]
            }
        });
    }
}

// Detailed view for more comprehensive information
export async function opbnbDetailedView(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    const session = global.userSessions.get(userId);
    
    // Get the last scanned address from session
    const walletAddress = session?.opbnbLastScanned;
    
    if (!walletAddress) {
        await ctx.answerCbQuery(
            lang === 'zh' ? '请先扫描钱包' : 'Please scan a wallet first',
            { show_alert: true }
        );
        return;
    }

    const message = lang === 'zh'
        ? `📊 *详细视图选项*\n\n选择您想查看的详细信息：`
        : `📊 *Detailed View Options*\n\nSelect what you want to view in detail:`;

    const keyboard = {
        inline_keyboard: [
            [
                Markup.button.callback(
                    lang === 'zh' ? '💰 原生余额详情' : '💰 Native Balance Details',
                    'opbnb_native_balance'
                )
            ],
            [
                Markup.button.callback(
                    lang === 'zh' ? '🪙 所有代币余额' : '🪙 All Token Balances',
                    'opbnb_token_balances'
                )
            ],
            [
                Markup.button.callback(
                    lang === 'zh' ? '📊 完整交易历史' : '📊 Full Transaction History',
                    'opbnb_transaction_history'
                )
            ],
            [
                Markup.button.callback(
                    lang === 'zh' ? '🔙 返回摘要' : '🔙 Back to Summary',
                    `opbnb_refresh_${walletAddress}`
                )
            ]
        ]
    };

    await ctx.editMessageText(message, {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
    });
}

// Native balance detailed view
export async function opbnbNativeBalance(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    const session = global.userSessions.get(userId);
    const walletAddress = session?.opbnbLastScanned;
    
    if (!walletAddress) {
        await ctx.answerCbQuery(
            lang === 'zh' ? '请先扫描钱包' : 'Please scan a wallet first',
            { show_alert: true }
        );
        return;
    }

    try {
        await ctx.answerCbQuery(lang === 'zh' ? '正在获取余额...' : 'Fetching balance...');
        
        const balanceData = await opbnbService.getNativeBalance(walletAddress);
        
        const message = lang === 'zh'
            ? `💰 *opBNB 原生余额详情*

钱包地址: 
\`${walletAddress}\`

原生 BNB 余额: *${balanceData.formatted}*
${balanceData.usdValue ? `美元价值: *$${balanceData.usdValue.toFixed(2)}*` : ''}

_opBNB 网络上的原生 BNB 用于支付交易费用和转账。_`
            : `💰 *opBNB Native Balance Details*

Wallet Address: 
\`${walletAddress}\`

Native BNB Balance: *${balanceData.formatted}*
${balanceData.usdValue ? `USD Value: *$${balanceData.usdValue.toFixed(2)}*` : ''}

_Native BNB on opBNB network is used for transaction fees and transfers._`;

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        'opbnb_native_balance'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回详细视图' : '🔙 Back to Details',
                        'opbnb_detailed_view'
                    )
                ]
            ]
        };

        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error fetching opBNB native balance:', error);
        await ctx.answerCbQuery(
            lang === 'zh' ? '❌ 获取余额失败' : '❌ Failed to fetch balance',
            { show_alert: true }
        );
    }
}

// Token balances detailed view
export async function opbnbTokenBalances(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    const session = global.userSessions.get(userId);
    const walletAddress = session?.opbnbLastScanned;
    
    if (!walletAddress) {
        await ctx.answerCbQuery(
            lang === 'zh' ? '请先扫描钱包' : 'Please scan a wallet first',
            { show_alert: true }
        );
        return;
    }

    try {
        await ctx.answerCbQuery(lang === 'zh' ? '正在获取代币余额...' : 'Fetching token balances...');
        
        const tokens = await opbnbService.getTokenBalances(walletAddress);
        
        let message = lang === 'zh'
            ? `🪙 *opBNB 代币余额*\n\n钱包地址:\n\`${walletAddress}\`\n\n`
            : `🪙 *opBNB Token Balances*\n\nWallet Address:\n\`${walletAddress}\`\n\n`;

        if (tokens.length === 0) {
            message += lang === 'zh' 
                ? '😢 未找到代币余额\n\n_该钱包在 opBNB 网络上没有代币。_'
                : '😢 No token balances found\n\n_This wallet has no tokens on opBNB network._';
        } else {
            let totalValue = 0;
            tokens.forEach(token => {
                if (token.usdValue) totalValue += token.usdValue;
            });

            if (totalValue > 0) {
                message += lang === 'zh'
                    ? `💼 代币总价值: *$${totalValue.toFixed(2)}*\n\n`
                    : `💼 Total Token Value: *$${totalValue.toFixed(2)}*\n\n`;
            }

            tokens.slice(0, 15).forEach((token, index) => {
                const usdValue = token.usdValue ? ` ($${token.usdValue.toFixed(2)})` : '';
                message += `${index + 1}. *${token.symbol}*\n`;
                message += `   ${token.formatted}${usdValue}\n`;
                message += `   \`${token.contractAddress}\`\n\n`;
            });

            if (tokens.length > 15) {
                message += lang === 'zh' 
                    ? `_显示前 15 个代币，总共 ${tokens.length} 个代币_`
                    : `_Showing first 15 tokens, total ${tokens.length} tokens_`;
            }
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        'opbnb_token_balances'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回详细视图' : '🔙 Back to Details',
                        'opbnb_detailed_view'
                    )
                ]
            ]
        };

        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error fetching opBNB token balances:', error);
        await ctx.answerCbQuery(
            lang === 'zh' ? '❌ 获取代币余额失败' : '❌ Failed to fetch token balances',
            { show_alert: true }
        );
    }
}

// Transaction history detailed view
export async function opbnbTransactionHistory(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    const session = global.userSessions.get(userId);
    const walletAddress = session?.opbnbLastScanned;
    
    if (!walletAddress) {
        await ctx.answerCbQuery(
            lang === 'zh' ? '请先扫描钱包' : 'Please scan a wallet first',
            { show_alert: true }
        );
        return;
    }

    try {
        await ctx.answerCbQuery(lang === 'zh' ? '正在获取交易历史...' : 'Fetching transaction history...');
        
        const transactions = await opbnbService.getTransactionHistory(walletAddress, 10);
        
        let message = lang === 'zh'
            ? `📊 *opBNB 交易历史*\n\n钱包地址:\n\`${walletAddress}\`\n\n`
            : `📊 *opBNB Transaction History*\n\nWallet Address:\n\`${walletAddress}\`\n\n`;

        if (transactions.length === 0) {
            message += lang === 'zh' 
                ? '😢 未找到交易记录\n\n_该钱包在 opBNB 网络上没有交易。_'
                : '😢 No transactions found\n\n_This wallet has no transactions on opBNB network._';
        } else {
            transactions.forEach((tx, index) => {
                const status = tx.successful ? '✅' : '❌';
                const date = opbnbService.formatDate(tx.timestamp);
                const type = tx.from.toLowerCase() === walletAddress.toLowerCase() ? '↗️ OUT' : '↘️ IN';
                
                message += `${index + 1}. ${status} ${type} | ${date}\n`;
                message += `   Hash: \`${tx.hash.slice(0, 10)}...\`\n`;
                message += `   ${lang === 'zh' ? '数量' : 'Amount'}: ${tx.formattedValue} BNB\n`;
                message += `   ${lang === 'zh' ? '手续费' : 'Fee'}: ${tx.formattedFees} BNB\n\n`;
            });

            message += lang === 'zh' 
                ? `_显示最近 ${transactions.length} 笔交易_`
                : `_Showing last ${transactions.length} transactions_`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        'opbnb_transaction_history'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回详细视图' : '🔙 Back to Details',
                        'opbnb_detailed_view'
                    )
                ]
            ]
        };

        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error fetching opBNB transaction history:', error);
        await ctx.answerCbQuery(
            lang === 'zh' ? '❌ 获取交易历史失败' : '❌ Failed to fetch transaction history',
            { show_alert: true }
        );
    }
}

// Token Analysis menu - allows user to enter token address for analysis
export async function opbnbTokenAnalysis(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Set up session for waiting for token address input
    const session = global.userSessions.get(userId) || {};
    session.waitingForOpbnbTokenAddress = true;
    global.userSessions.set(userId, session);
    
    const message = lang === 'zh' 
        ? `🔍 *opBNB 代币分析*

请输入您想要分析的代币合约地址：

示例: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

此功能将分析：
• 代币元数据和基本信息
• 持有者分布和集中度
• 每日交易活动
• 潜在风险警告`
        : `🔍 *opBNB Token Analysis*

Please enter the token contract address you want to analyze:

Example: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

This feature will analyze:
• Token metadata and basic info
• Holder distribution and concentration
• Daily transfer activity
• Potential risk warnings`;

    const keyboard = {
        inline_keyboard: [
            [
                Markup.button.callback(
                    lang === 'zh' ? '🔙 返回 opBNB 控制台' : '🔙 Back to opBNB Dashboard',
                    'opbnb_dashboard'
                )
            ]
        ]
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}

// Function to analyze and display token information
export async function analyzeOpbnbToken(ctx: Context, tokenAddress: string) {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Validate token address
    if (!/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)) {
        const lang = await getUserLanguage(userId);
        const errorMessage = lang === 'zh'
            ? '❌ 无效的代币地址\n\n请提供有效的 opBNB 代币合约地址。'
            : '❌ Invalid token address\n\nPlease provide a valid opBNB token contract address.';
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        callback_data: 'opbnb_token_analysis'
                    }]
                ]
            }
        });
        return;
    }

    const lang = await getUserLanguage(userId);

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在分析代币...\n\n合约地址: \`${opbnbService.shortenAddress(tokenAddress)}\``
            : `⏳ Analyzing token...\n\nContract: \`${opbnbService.shortenAddress(tokenAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Perform token analysis
        const analysis = await opbnbService.analyzeToken(tokenAddress);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Build analysis report
        let message = lang === 'zh'
            ? `🔍 *opBNB 代币分析报告*\n\n`
            : `🔍 *opBNB Token Analysis Report*\n\n`;

        message += lang === 'zh'
            ? `📍 合约地址:\n\`${tokenAddress}\`\n\n`
            : `📍 Contract Address:\n\`${tokenAddress}\`\n\n`;

        // Risk Level with emoji
        const riskEmoji = {
            'low': '🟢',
            'medium': '🟡',
            'high': '🔴'
        };
        
        const riskText = {
            'low': lang === 'zh' ? '低风险' : 'Low Risk',
            'medium': lang === 'zh' ? '中等风险' : 'Medium Risk',
            'high': lang === 'zh' ? '高风险' : 'High Risk'
        };

        message += lang === 'zh' 
            ? `⚠️ *风险等级:* ${riskEmoji[analysis.analysis.riskLevel]} ${riskText[analysis.analysis.riskLevel]}\n\n`
            : `⚠️ *Risk Level:* ${riskEmoji[analysis.analysis.riskLevel]} ${riskText[analysis.analysis.riskLevel]}\n\n`;

        // Token Info
        if (analysis.metadata) {
            message += lang === 'zh' ? `📋 *代币信息*\n` : `📋 *Token Information*\n`;
            if (analysis.metadata.name && analysis.metadata.symbol) {
                message += `• ${analysis.metadata.name} (${analysis.metadata.symbol})\n`;
            }
            if (analysis.metadata.decimals) {
                message += lang === 'zh' 
                    ? `• 精度: ${analysis.metadata.decimals}\n`
                    : `• Decimals: ${analysis.metadata.decimals}\n`;
            }
            if (analysis.metadata.tokenType) {
                message += lang === 'zh' 
                    ? `• 类型: ${analysis.metadata.tokenType.toUpperCase()}\n`
                    : `• Type: ${analysis.metadata.tokenType.toUpperCase()}\n`;
            }
            message += '\n';
        }

        // Insights
        if (analysis.analysis.insights.length > 0) {
            message += lang === 'zh' ? `✅ *积极信号*\n` : `✅ *Positive Indicators*\n`;
            analysis.analysis.insights.forEach(insight => {
                message += `• ${insight}\n`;
            });
            message += '\n';
        }

        // Warnings
        if (analysis.analysis.warnings.length > 0) {
            message += lang === 'zh' ? `⚠️ *风险警告*\n` : `⚠️ *Risk Warnings*\n`;
            analysis.analysis.warnings.forEach(warning => {
                message += `• ${warning}\n`;
            });
            message += '\n';
        }

        // Holder Analysis
        if (analysis.holders && analysis.holders.holders) {
            const totalHolders = analysis.holders.holders.length;
            message += lang === 'zh' ? `👥 *持有者分析*\n` : `👥 *Holder Analysis*\n`;
            
            if (totalHolders > 0) {
                message += lang === 'zh' 
                    ? `• 总持有者数: ${totalHolders}\n`
                    : `• Total holders: ${totalHolders}\n`;
                
                // Show top 5 holders
                const topHolders = analysis.holders.holders.slice(0, 5);
                if (topHolders.length > 0) {
                    message += lang === 'zh' ? `• 前5大持有者:\n` : `• Top 5 holders:\n`;
                    topHolders.forEach((holder: any, index: number) => {
                        const shortenedAddress = opbnbService.shortenAddress(holder.accountAddress);
                        message += `  ${index + 1}. ${shortenedAddress}\n`;
                    });
                }
            } else {
                message += lang === 'zh' 
                    ? `• 未找到持有者数据\n`
                    : `• No holder data found\n`;
            }
            message += '\n';
        }

        // Add explorer link
        message += `🔗 [${lang === 'zh' ? '在 opBNBScan 查看' : 'View on opBNBScan'}](https://opbnbscan.com/token/${tokenAddress})`;

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 分析其他代币' : '🔄 Analyze Another',
                        'opbnb_token_analysis'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error analyzing opBNB token:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 分析代币时出错\n\n请检查地址是否正确并稍后重试。`
            : `❌ Error analyzing token\n\nPlease check the address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回分析菜单' : '🔙 Back to Analysis',
                        'opbnb_token_analysis'
                    )]
                ]
            }
        });
    }
}

// Whale Tracker menu - ask for token address
export async function opbnbWhaleTracker(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Set up session for waiting for token address
    const session = global.userSessions.get(userId) || {};
    session.waitingForOpbnbWhaleToken = true;
    global.userSessions.set(userId, session);
    
    const message = lang === 'zh' 
        ? `🐋 *巨鲸追踪器*

请输入您想要追踪巨鲸的代币合约地址：

示例: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

此功能将显示：
• 前20大持有者及其余额
• 巨鲸集中度分析
• 代币分布情况
• 巨鲸活动警报`
        : `🐋 *Whale Tracker*

Please enter the token contract address to track whales:

Example: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

This feature will show:
• Top 20 holders and their balances
• Whale concentration analysis
• Token distribution metrics
• Whale activity alerts`;

    const keyboard = {
        inline_keyboard: [
            [
                Markup.button.callback(
                    lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                    'opbnb_dashboard'
                )
            ]
        ]
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}

// Display whale tracking results
export async function showWhaleTracking(ctx: Context, tokenAddress: string) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在追踪巨鲸活动...

代币: \`${opbnbService.shortenAddress(tokenAddress)}\``
            : `⏳ Tracking whale activity...

Token: \`${opbnbService.shortenAddress(tokenAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Fetch whale data
        const whaleData = await opbnbAnalytics.getWhaleTracker(tokenAddress, 20);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Check if we have holder data
        if (whaleData.holders.length === 0) {
            const noDataMessage = lang === 'zh'
                ? `❌ *无数据*\n\n无法获取代币 \`${tokenAddress}\` 的持有者数据。\n\n可能原因：\n• 代币地址无效\n• 代币刚部署，暂无持有者\n• 该代币不在 opBNB 网络上`
                : `❌ *No Data*\n\nCould not fetch holder data for token \`${tokenAddress}\`.\n\nPossible reasons:\n• Invalid token address\n• Token just deployed with no holders yet\n• Token is not on opBNB network`;
            
            await ctx.reply(noDataMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback(
                                lang === 'zh' ? '🔍 追踪其他' : '🔍 Track Another',
                                'opbnb_whale_tracker'
                            )
                        ],
                        [
                            Markup.button.callback(
                                lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                                'opbnb_dashboard'
                            )
                        ]
                    ]
                }
            });
            return;
        }

        // Build whale report
        let message = lang === 'zh'
            ? `🐋 *巨鲸追踪报告*

`
            : `🐋 *Whale Tracking Report*

`;

        message += `📍 ${lang === 'zh' ? '代币地址' : 'Token Address'}: \`${tokenAddress}\`

`;

        // Analysis summary
        message += lang === 'zh' ? `📊 *分析摘要*
` : `📊 *Analysis Summary*
`;
        message += lang === 'zh' 
            ? `• 总持有者: ${whaleData.analysis.totalHolders}
`
            : `• Total Holders: ${whaleData.analysis.totalHolders}
`;
        message += lang === 'zh'
            ? `• 巨鲸数量 (>1%): ${whaleData.analysis.whaleCount}
`
            : `• Whale Count (>1%): ${whaleData.analysis.whaleCount}
`;
        message += lang === 'zh'
            ? `• 最大持有者占比: ${whaleData.analysis.topHolderConcentration.toFixed(2)}%\n`
            : `• Top Holder: ${whaleData.analysis.topHolderConcentration.toFixed(2)}%\n`;
        message += '\n';

        // Distribution metrics
        message += lang === 'zh' ? `📈 *代币分布*
` : `📈 *Token Distribution*
`;
        message += lang === 'zh'
            ? `• 前10持有者: ${whaleData.analysis.distribution.top10.toFixed(2)}%
`
            : `• Top 10 Holders: ${whaleData.analysis.distribution.top10.toFixed(2)}%
`;
        message += lang === 'zh'
            ? `• 前20持有者: ${whaleData.analysis.distribution.top20.toFixed(2)}%
`
            : `• Top 20 Holders: ${whaleData.analysis.distribution.top20.toFixed(2)}%
`;
        message += lang === 'zh'
            ? `• 前50持有者: ${whaleData.analysis.distribution.top50.toFixed(2)}%\n`
            : `• Top 50 Holders: ${whaleData.analysis.distribution.top50.toFixed(2)}%\n`;
        message += '\n';

        // Top holders list
        message += lang === 'zh' ? `🏆 *前10大持有者*

` : `🏆 *Top 10 Holders*

`;
        
        const topHolders = whaleData.holders.slice(0, 10);
        topHolders.forEach((holder, index) => {
            const rank = index + 1;
            const address = holder.address;  // Use full address instead of shortened
            const percentage = holder.percentage?.toFixed(2) || '0.00';
            
            // Add emoji based on rank
            const emoji = rank === 1 ? '👑' : rank <= 3 ? '🥇' : rank <= 5 ? '🥈' : '🥉';
            
            // Display with percentage first, then full address
            message += `${emoji} #${rank} - ${percentage}%\n`;
            message += `\`${address}\`\n\n`;
        });

        // Risk assessment
        message += '\n';
        if (whaleData.analysis.distribution.top10 > 80) {
            message += lang === 'zh' 
                ? `⚠️ *警告: 高度集中* - 前10持有者控制超过80%的供应量
`
                : `⚠️ *Warning: High Concentration* - Top 10 holders control >80% of supply
`;
        } else if (whaleData.analysis.distribution.top10 > 60) {
            message += lang === 'zh'
                ? `📊 *中度集中* - 前10持有者控制60-80%的供应量
`
                : `📊 *Moderate Concentration* - Top 10 holders control 60-80% of supply
`;
        } else {
            message += lang === 'zh'
                ? `✅ *健康分布* - 代币分布相对均匀
`
                : `✅ *Healthy Distribution* - Token is well distributed
`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        `opbnb_whale_refresh_${tokenAddress}`
                    ),
                    Markup.button.callback(
                        lang === 'zh' ? '🔍 追踪其他' : '🔍 Track Another',
                        'opbnb_whale_tracker'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error tracking whales:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 追踪巨鲸时出错

请检查代币地址是否正确并稍后重试。`
            : `❌ Error tracking whales

Please check the token address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        'opbnb_whale_tracker'
                    )]
                ]
            }
        });
    }
}

// Hot Tokens Dashboard
export async function opbnbHotTokens(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);

    try {
        // Show loading with callback query answer
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(lang === 'zh' ? '🔥 加载热门代币...' : '🔥 Loading hot tokens...');
        }

        // Fetch hot tokens
        const hotTokens = await opbnbAnalytics.getHotTokens(20);

        // Build hot tokens report
        let message = lang === 'zh'
            ? `🔥 *opBNB 热门代币*

`
            : `🔥 *opBNB Hot Tokens*

`;

        message += lang === 'zh'
            ? `_按24小时转账活动排序_

`
            : `_Sorted by 24h transfer activity_

`;

        if (hotTokens.length === 0) {
            message += lang === 'zh'
                ? `暂无数据\n\n请稍后再试。`
                : `No data available\n\nPlease try again later.`;
        } else {
            // Show top 10 hot tokens
            const topTokens = hotTokens.slice(0, 10);
            topTokens.forEach((token, index) => {
                const rank = index + 1;
                const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🔥';
                
                message += `${emoji} *#${rank} ${token.tokenSymbol || 'Unknown'}*\n`;
                message += `   ${token.tokenName || 'Unknown Token'}\n`;
                
                if (token.holderCount && token.holderCount > 0) {
                    message += lang === 'zh'
                        ? `   👥 持有者: ${opbnbAnalytics.formatNumber(token.holderCount)}\n`
                        : `   👥 Holders: ${opbnbAnalytics.formatNumber(token.holderCount)}\n`;
                }
                
                // Show full address
                message += `   \`${token.tokenAddress}\`\n\n`;
            });

            if (hotTokens.length > 10) {
                message += lang === 'zh'
                    ? `_显示前10个代币，共${hotTokens.length}个活跃代币_
`
                    : `_Showing top 10 of ${hotTokens.length} active tokens_
`;
            }
        }

        // Add tips
        message += '\n';
        message += lang === 'zh'
            ? `💡 *提示*: 高转账活动可能表示交易兴趣增加或代币分发活动。`
            : `💡 *Tip*: High transfer activity may indicate increased trading interest or token distribution events.`;

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        'opbnb_hot_tokens'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        if (ctx.callbackQuery) {
            await ctx.editMessageText(message, {
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            });
        } else {
            await ctx.reply(message, {
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            });
        }

    } catch (error) {
        console.error('Error fetching hot tokens:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 获取热门代币时出错

请稍后重试。`
            : `❌ Error fetching hot tokens

Please try again later.`;
        
        if (ctx.callbackQuery) {
            await ctx.editMessageText(errorMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [Markup.button.callback(
                            lang === 'zh' ? '🔙 返回' : '🔙 Back',
                            'opbnb_dashboard'
                        )]
                    ]
                }
            });
        } else {
            await ctx.reply(errorMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [Markup.button.callback(
                            lang === 'zh' ? '🔙 返回' : '🔙 Back',
                            'opbnb_dashboard'
                        )]
                    ]
                }
            });
        }
    }
}

// Token Health Check menu
export async function opbnbTokenHealth(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);
    
    // Set up session for waiting for token address
    const session = global.userSessions.get(userId) || {};
    session.waitingForOpbnbHealthToken = true;
    global.userSessions.set(userId, session);
    
    const message = lang === 'zh' 
        ? `💊 *代币健康检查*

请输入您想要检查健康状况的代币合约地址：

示例: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

此功能将分析：
• 持有者数量和分布
• 交易活动水平
• 流动性评分
• 风险等级评估
• 潜在警告和洞察`
        : `💊 *Token Health Check*

Please enter the token contract address to check health:

Example: \`0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3\`

This feature will analyze:
• Holder count and distribution
• Trading activity levels
• Liquidity score
• Risk level assessment
• Potential warnings and insights`;

    const keyboard = {
        inline_keyboard: [
            [
                Markup.button.callback(
                    lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                    'opbnb_dashboard'
                )
            ]
        ]
    };

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    } else {
        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }
}

// Display token health check results
export async function showTokenHealthCheck(ctx: Context, tokenAddress: string) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = await getUserLanguage(userId);

    try {
        // Show loading message
        const loadingMessage = lang === 'zh' 
            ? `⏳ 正在检查代币健康状况...

代币: \`${opbnbService.shortenAddress(tokenAddress)}\``
            : `⏳ Checking token health...

Token: \`${opbnbService.shortenAddress(tokenAddress)}\``;
        
        const loadingMsg = await ctx.reply(loadingMessage, { parse_mode: 'Markdown' });

        // Fetch health metrics
        const health = await opbnbAnalytics.getTokenHealthCheck(tokenAddress);

        // Delete loading message
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

        // Build health report
        let message = lang === 'zh'
            ? `💊 *代币健康检查报告*

`
            : `💊 *Token Health Check Report*

`;

        message += `📍 ${lang === 'zh' ? '代币地址' : 'Token Address'}: \`${tokenAddress}\`

`;

        // Risk level with emoji
        const riskEmoji = health.riskLevel === 'low' ? '✅' : health.riskLevel === 'medium' ? '⚠️' : '🚨';
        const riskText = lang === 'zh' 
            ? (health.riskLevel === 'low' ? '低风险' : health.riskLevel === 'medium' ? '中等风险' : '高风险')
            : (health.riskLevel === 'low' ? 'Low Risk' : health.riskLevel === 'medium' ? 'Medium Risk' : 'High Risk');
        
        message += `${riskEmoji} *${lang === 'zh' ? '风险等级' : 'Risk Level'}*: ${riskText}

`;

        // Key metrics
        message += lang === 'zh' ? `📊 *关键指标*
` : `📊 *Key Metrics*
`;
        message += lang === 'zh'
            ? `• 持有者数量: ${health.holderCount}
`
            : `• Holder Count: ${health.holderCount}
`;
        message += lang === 'zh'
            ? `• 最大持有者占比: ${health.topHolderConcentration.toFixed(2)}%
`
            : `• Top Holder: ${health.topHolderConcentration.toFixed(2)}%
`;
        message += lang === 'zh'
            ? `• 日均转账: ${Math.round(health.avgDailyTransfers)}
`
            : `• Avg Daily Transfers: ${Math.round(health.avgDailyTransfers)}
`;
        message += lang === 'zh'
            ? `• 流动性评分: ${health.liquidityScore}/100\n`
            : `• Liquidity Score: ${health.liquidityScore}/100\n`;
        message += '\n';

        // Warnings
        if (health.warnings.length > 0) {
            message += lang === 'zh' ? `⚠️ *警告*
` : `⚠️ *Warnings*
`;
            health.warnings.forEach(warning => {
                message += `${warning}
`;
            });
            message += '\n';
        }

        // Insights
        if (health.insights.length > 0) {
            message += lang === 'zh' ? `💡 *洞察*
` : `💡 *Insights*
`;
            health.insights.forEach(insight => {
                message += `${insight}
`;
            });
            message += '\n';
        }

        // Health score interpretation
        message += lang === 'zh' ? `📈 *健康评估*
` : `📈 *Health Assessment*
`;
        
        if (health.liquidityScore >= 70) {
            message += lang === 'zh'
                ? `✅ 该代币显示出健康的活动和分布模式。`
                : `✅ This token shows healthy activity and distribution patterns.`;
        } else if (health.liquidityScore >= 40) {
            message += lang === 'zh'
                ? `📊 该代币有一些需要注意的指标。请谨慎投资。`
                : `📊 This token has some metrics that need attention. Invest with caution.`;
        } else {
            message += lang === 'zh'
                ? `🚨 该代币显示出多个风险信号。建议进行深入研究。`
                : `🚨 This token shows multiple risk signals. Deep research recommended.`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔄 刷新' : '🔄 Refresh',
                        `opbnb_health_refresh_${tokenAddress}`
                    ),
                    Markup.button.callback(
                        lang === 'zh' ? '🔍 检查其他' : '🔍 Check Another',
                        'opbnb_token_health'
                    )
                ],
                [
                    Markup.button.callback(
                        lang === 'zh' ? '🔙 返回控制台' : '🔙 Back to Dashboard',
                        'opbnb_dashboard'
                    )
                ]
            ]
        };

        await ctx.reply(message, {
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error checking token health:', error);
        
        const errorMessage = lang === 'zh'
            ? `❌ 检查代币健康时出错

请检查代币地址是否正确并稍后重试。`
            : `❌ Error checking token health

Please check the token address and try again later.`;
        
        await ctx.reply(errorMessage, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(
                        lang === 'zh' ? '🔙 返回' : '🔙 Back',
                        'opbnb_token_health'
                    )]
                ]
            }
        });
    }
}
