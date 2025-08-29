import { ethers } from 'ethers';
import { createLogger } from '@/utils/logger';
import { getBNBPrice } from '@/services/wallet/tokenPriceCache';

const logger = createLogger('services.tokenPriceMonitor');

// V2 Pair ABI for Swap events
const PAIR_ABI = [
    'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)'
];

// V3 Pool ABI for PancakeSwap V3 pools
const V3_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function liquidity() view returns (uint128)',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
];

interface MonitoredToken {
    tokenAddress: string;
    pairAddress: string;
    symbol: string;
    lastPrice: string;
    isToken0: boolean; // true if token is token0 in the pair
    pairedToken: string; // WBNB, BUSD, USDT, etc.
    lastNotificationTime?: number; // timestamp of last notification
}

export class TokenPriceMonitor {
    private static instance: TokenPriceMonitor;
    private provider: ethers.WebSocketProvider | null = null;
    private monitoredTokens: Map<string, MonitoredToken> = new Map();
    private priceCheckInterval: NodeJS.Timeout | null = null;
    private isInitialized = false;
    private executingAutoTrades: Set<string> = new Set(); // Track tokens with active auto-trade executions

    private constructor() {
        this.initializeProvider();
    }

    static getInstance(): TokenPriceMonitor {
        if (!TokenPriceMonitor.instance) {
            TokenPriceMonitor.instance = new TokenPriceMonitor();
        }
        return TokenPriceMonitor.instance;
    }

    private initializeProvider(): void {
        const wsUrl = process.env.QUICKNODE_BSC_WSS_URL || 'wss://bsc-ws-node.nariox.org:443';

        if (!process.env.QUICKNODE_BSC_WSS_URL) {
            logger.warn('Using fallback WebSocket URL. Set QUICKNODE_BSC_WSS_URL for better performance');
        }

        logger.info('Initializing WebSocket provider for token monitoring', { wsUrl });

        try {
            this.provider = new ethers.WebSocketProvider(wsUrl);
            logger.info('WebSocket provider created successfully for token monitoring');
        } catch (error) {
            logger.error('Failed to create WebSocket provider', { error });
            this.provider = null;
        }
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            logger.info('Token price monitor already initialized');
            return;
        }

        if (!this.provider) {
            logger.warn('WebSocket provider not available, token price monitor will not be active');
            return;
        }

        try {
            logger.info('Initializing token price monitor');

            // Start periodic price monitoring
            this.startPriceMonitoring();

            // Mark as initialized first
            this.isInitialized = true;
            logger.info('Token price monitor initialized successfully', {
                monitoredTokenCount: this.monitoredTokens.size
            });

            // Load existing tracked tokens from database in the background
            this.loadTrackedTokensAsync();

        } catch (error) {
            logger.error('Error initializing token price monitor', { error });
            // Don't mark as initialized if there was an error, but don't throw
        }
    }

    private loadTrackedTokensAsync(): void {
        // Run this in the background without blocking initialization
        setTimeout(async () => {
            try {
                logger.info('Starting background token loading...');
                await this.loadTrackedTokens();

                // Setup WebSocket event listeners for existing tokens
                if (this.monitoredTokens.size > 0) {
                    logger.info('Setting up listeners for existing tokens...');
                    await this.setupExistingListeners();
                    logger.info('Token monitoring setup completed', {
                        monitoredTokenCount: this.monitoredTokens.size
                    });
                } else {
                    logger.info('No existing tokens found, background loading complete');
                }
            } catch (error) {
                logger.error('Error in background token loading', { error });
            }
        }, 1000);
    }

    private async loadTrackedTokens(): Promise<void> {
        try {
            logger.info('Loading tracked tokens from database...');

            // Check if we can access the TrackedToken model
            let TrackedTokenModel;
            try {
                const modelModule = await import('@/database/models/TrackedToken');
                TrackedTokenModel = modelModule.TrackedTokenModel;

                if (!TrackedTokenModel) {
                    logger.warn('TrackedTokenModel is undefined, skipping token loading');
                    return;
                }
            } catch (importError) {
                logger.warn('Could not import TrackedTokenModel, skipping token loading', {
                    error: importError instanceof Error ? importError.message : String(importError)
                });
                return;
            }

            // Try to query the database
            try {
                const trackedTokens = await TrackedTokenModel.find({
                    isActive: true,
                    pairAddress: { $exists: true, $ne: null }
                });

                logger.info('Found tracked tokens in database', { count: trackedTokens.length });

                for (const token of trackedTokens) {
                    try {
                        await this.addTokenToMonitoring(token.tokenAddress, token.pairAddress, token.tokenSymbol, token.pairedToken);
                    } catch (error) {
                        logger.error('Error adding token to monitoring during load', {
                            error,
                            tokenAddress: token.tokenAddress
                        });
                    }
                }
                logger.info('Loaded tracked tokens', { count: this.monitoredTokens.size });
            } catch (dbError) {
                logger.warn('Database query failed, continuing without existing tokens', {
                    error: dbError instanceof Error ? dbError.message : String(dbError)
                });
            }
        } catch (error) {
            logger.error('Error in loadTrackedTokens method', {
                error,
                message: error instanceof Error ? error.message : String(error)
            });
            // Don't throw the error, just log it and continue
        }
    }

    async addTokenToMonitoring(tokenAddress: string, pairAddress: string, symbol?: string, pairedToken?: string): Promise<void> {
        if (!this.provider) {
            logger.warn('WebSocket provider not available, skipping token monitoring setup');
            return;
        }

        const tokenKey = tokenAddress.toLowerCase();
        if (this.monitoredTokens.has(tokenKey)) {
            logger.info('Token already being monitored', { tokenAddress });
            return;
        }

        try {
            // Try to get token0 address, attempting V3 first, then V2
            let token0Address: string;
            let poolContract = new ethers.Contract(pairAddress, V3_POOL_ABI, this.provider);

            try {
                token0Address = await poolContract.token0();
                logger.debug('Successfully detected pool token0 (V3 or V2)', { pairAddress, token0Address });
            } catch (error) {
                // If V3 fails, try V2
                poolContract = new ethers.Contract(pairAddress, PAIR_ABI, this.provider);
                token0Address = await poolContract.token0();
                logger.debug('Successfully detected pool token0 (V2 fallback)', { pairAddress, token0Address });
            }

            const isToken0 = token0Address.toLowerCase() === tokenAddress.toLowerCase();

            // Construct temporary MonitoredToken for price fetching
            const tempToken: MonitoredToken = {
                tokenAddress: tokenAddress.toLowerCase(),
                pairAddress: pairAddress.toLowerCase(),
                symbol: symbol || 'Unknown',
                lastPrice: '0',
                isToken0,
                pairedToken: pairedToken || 'WBNB'
            };

            const initialPrice = await this.getCurrentPriceFromPool(tempToken);

            const monitoredToken: MonitoredToken = {
                ...tempToken,
                tokenAddress: tokenKey,
                lastPrice: initialPrice
            };

            this.monitoredTokens.set(tokenKey, monitoredToken);
            await this.setupPairEventListener(pairAddress);

            logger.info('Added token to monitoring', {
                tokenAddress,
                pairAddress,
                symbol,
                initialPrice
            });
        } catch (error) {
            logger.error('Error adding token to monitoring', { error, tokenAddress, pairAddress });
        }
    }

    async removeTokenFromMonitoring(tokenAddress: string): Promise<void> {
        const tokenKey = tokenAddress.toLowerCase();
        const monitoredToken = this.monitoredTokens.get(tokenKey);

        if (!monitoredToken || !this.provider) {
            return;
        }

        try {
            // Check if other tokens use the same pair
            const otherTokensWithSamePair = Array.from(this.monitoredTokens.values())
                .filter(t => t.pairAddress === monitoredToken.pairAddress && t.tokenAddress !== tokenKey);

            // If no other tokens use this pair, remove the event listener
            if (otherTokensWithSamePair.length === 0) {
                // Try both V3 and V2 contracts to remove listeners
                try {
                    const v3Contract = new ethers.Contract(monitoredToken.pairAddress, V3_POOL_ABI, this.provider);
                    v3Contract.removeAllListeners('Swap');
                } catch (error) {
                    // Ignore errors, might not be V3
                }

                try {
                    const v2Contract = new ethers.Contract(monitoredToken.pairAddress, PAIR_ABI, this.provider);
                    v2Contract.removeAllListeners('Swap');
                } catch (error) {
                    // Ignore errors, might not be V2
                }

                logger.info('Removed Swap event listeners for pair', { pairAddress: monitoredToken.pairAddress });
            }

            this.monitoredTokens.delete(tokenKey);
            logger.info('Removed token from monitoring', { tokenAddress });
        } catch (error) {
            logger.error('Error removing token from monitoring', { error, tokenAddress });
        }
    }

    private async setupExistingListeners(): Promise<void> {
        if (!this.provider) return;

        try {
            // Get unique pairs
            const uniquePairs = new Set(
                Array.from(this.monitoredTokens.values()).map(t => t.pairAddress)
            );

            for (const pairAddress of uniquePairs) {
                const tokensForPair = Array.from(this.monitoredTokens.values())
                    .filter(t => t.pairAddress === pairAddress);
                if (tokensForPair.length > 0) {
                    await this.setupPairEventListener(pairAddress);
                }
            }
        } catch (error) {
            logger.error('Error setting up existing listeners', { error });
        }
    }

    private async setupPairEventListener(pairAddress: string): Promise<void> {
        if (!this.provider) return;

        try {
            // Try V3 pool first
            let poolContract = new ethers.Contract(pairAddress, V3_POOL_ABI, this.provider);
            let isV3Pool = false;

            try {
                // Test if it's a V3 pool by calling slot0()
                await poolContract.slot0();
                isV3Pool = true;
                logger.debug('Setting up V3 pool event listener', { pairAddress });
            } catch (error) {
                // Not a V3 pool, try V2
                poolContract = new ethers.Contract(pairAddress, PAIR_ABI, this.provider);
                logger.debug('Setting up V2 pool event listener', { pairAddress });
            }

            // Remove existing listeners for this pair to avoid duplicates
            poolContract.removeAllListeners('Swap');

            if (isV3Pool) {
                // V3 Swap event: (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)
                poolContract.on('Swap', async (_sender, _recipient, _amount0, _amount1, _sqrtPriceX96, _liquidity, _tick, _event) => {
                    try {
                        logger.info('V3 Swap event detected - checking prices', { pairAddress });
                        await this.checkPriceChangeForPair(pairAddress);
                    } catch (error) {
                        logger.error('Error processing V3 swap event', { error, pairAddress });
                    }
                });
            } else {
                // V2 Swap event: (sender, amount0In, amount1In, amount0Out, amount1Out, to)
                poolContract.on('Swap', async (_sender, _amount0In, _amount1In, _amount0Out, _amount1Out, _to, _event) => {
                    try {
                        logger.info('V2 Swap event detected - checking prices', { pairAddress });
                        await this.checkPriceChangeForPair(pairAddress);
                    } catch (error) {
                        logger.error('Error processing V2 swap event', { error, pairAddress });
                    }
                });
            }

            logger.info('Set up swap event listener', { pairAddress, poolType: isV3Pool ? 'V3' : 'V2' });
        } catch (error) {
            logger.error('Error setting up pair event listener', { error, pairAddress });
        }
    }

    private async checkPriceChangeForPair(pairAddress: string): Promise<void> {
        try {
            const tokensForPair = Array.from(this.monitoredTokens.values())
                .filter(t => t.pairAddress === pairAddress.toLowerCase());

            for (const token of tokensForPair) {
                await this.checkTokenPriceChange(token);
            }
        } catch (error) {
            logger.error('Error checking price change for pair', { error, pairAddress });
        }
    }

    private async checkTokenPriceChange(token: MonitoredToken): Promise<void> {
        try {
            const currentPrice = await this.getCurrentPriceFromPool(token);

            logger.debug('Price check for token', {
                symbol: token.symbol,
                tokenAddress: token.tokenAddress,
                lastPrice: token.lastPrice,
                currentPrice,
                pairAddress: token.pairAddress
            });

            if (currentPrice === '0' || token.lastPrice === '0' || !currentPrice || !token.lastPrice) {
                logger.warn('Skipping price check - invalid price data', {
                    symbol: token.symbol,
                    currentPrice,
                    lastPrice: token.lastPrice
                });
                return;
            }

            const lastPriceNum = parseFloat(token.lastPrice);
            const newPriceNum = parseFloat(currentPrice);

            if (isNaN(lastPriceNum) || isNaN(newPriceNum) || lastPriceNum === 0) {
                logger.warn('Skipping price check - NaN or zero values', {
                    symbol: token.symbol,
                    lastPriceNum,
                    newPriceNum
                });
                return; // Avoid division by zero or NaN errors
            }

            const priceChangePercent = ((newPriceNum - lastPriceNum) / lastPriceNum) * 100;

            logger.info('Price change calculation', {
                symbol: token.symbol,
                tokenAddress: token.tokenAddress,
                lastPrice: token.lastPrice,
                currentPrice,
                changePercent: priceChangePercent.toFixed(6),
                threshold: 5,
                exceedsThreshold: Math.abs(priceChangePercent) >= 5
            });

            // Check if price change is significant (5% or more)
            if (Math.abs(priceChangePercent) >= 5) {
                // Rate limiting: only send notifications every 30 seconds per token
                const now = Date.now();
                const lastNotification = token.lastNotificationTime || 0;
                const timeSinceLastNotification = now - lastNotification;
                const minNotificationInterval = 30000; // 30 seconds

                if (timeSinceLastNotification >= minNotificationInterval) {
                    logger.info('Significant price change detected - sending alert', {
                        tokenAddress: token.tokenAddress,
                        symbol: token.symbol,
                        lastPrice: token.lastPrice,
                        currentPrice,
                        changePercent: priceChangePercent.toFixed(6)
                    });

                    // Update the last price and notification time
                    token.lastPrice = currentPrice;
                    token.lastNotificationTime = now;

                    // Send alert to users
                    const { TokenTrackingService } = await import('./tokenTracking');
                    await TokenTrackingService.sendPriceAlert(
                        token.tokenAddress,
                        priceChangePercent,
                        currentPrice
                    );
                } else {
                    logger.info('Price change detected but notification rate limited', {
                        symbol: token.symbol,
                        changePercent: priceChangePercent.toFixed(6),
                        timeSinceLastNotification: Math.round(timeSinceLastNotification / 1000),
                        minInterval: Math.round(minNotificationInterval / 1000)
                    });
                }
            } else {
                logger.debug('Price change below threshold', {
                    symbol: token.symbol,
                    changePercent: priceChangePercent.toFixed(6),
                    threshold: 0.1
                });
            }

            // Check auto-trade rules after price check (always check regardless of notification threshold)
            await this.checkAutoTradeRules(token, currentPrice, newPriceNum);

        } catch (error) {
            logger.error('Error checking token price change', { error, tokenAddress: token.tokenAddress });
        }
    }

    /**
     * Check and execute auto-trade rules for a token
     */
    private async checkAutoTradeRules(token: MonitoredToken, currentPrice: string, currentPriceNum: number): Promise<void> {
        try {
            // Import models and services
            const { TrackedTokenModel } = await import('@/database/models/TrackedToken');

            // Find all active auto-trade rules for this token
            const autoTradeRules = await TrackedTokenModel.find({
                tokenAddress: token.tokenAddress.toLowerCase(),
                isAutoTradeActive: true,
                isActive: true
            });

            if (autoTradeRules.length === 0) {
                return; // No auto-trade rules for this token
            }

            logger.debug('Checking auto-trade rules', {
                tokenAddress: token.tokenAddress,
                symbol: token.symbol,
                currentPrice,
                rulesCount: autoTradeRules.length
            });

            for (const rule of autoTradeRules) {
                try {
                    await this.processAutoTradeRule(rule, currentPrice, currentPriceNum, token);
                } catch (ruleError) {
                    logger.error('Error processing auto-trade rule', {
                        error: ruleError,
                        userId: rule.telegramId,
                        tokenAddress: token.tokenAddress
                    });
                }
            }

        } catch (error) {
            logger.error('Error checking auto-trade rules', {
                error,
                tokenAddress: token.tokenAddress
            });
        }
    }

    /**
     * Process a single auto-trade rule
     */
    private async processAutoTradeRule(rule: any, currentPrice: string, currentPriceNum: number, token: MonitoredToken): Promise<void> {
        const currentMarketCap = await this.calculateCurrentMarketCap(token, currentPriceNum);

        logger.debug('Processing auto-trade rule', {
            userId: rule.telegramId,
            tokenAddress: rule.tokenAddress,
            symbol: token.symbol,
            status: rule.autoTradeStatus,
            currentPrice,
            currentMarketCap,
            entryTarget: rule.marketCapEntryTarget,
            takeProfitPrice: rule.takeProfitPrice,
            stopLossPrice: rule.stopLossPrice
        });

        // Check entry conditions
        const entryAmount = rule.entryAmountBNB || rule.entryAmountUSD;

        // Check price-based entry rules first, then fall back to market cap rules for backwards compatibility
        const hasValidEntryTarget = (rule.priceEntryTarget && entryAmount) || (rule.marketCapEntryTarget && entryAmount);

        if (rule.autoTradeStatus === 'pending_entry' && hasValidEntryTarget) {
            let entryConditionMet = false;
            let logData: any = {};

            if (rule.priceEntryTarget) {
                // Price-based entry logic
                // If target price is higher than current, wait for price to reach or exceed target
                // If target price is lower than current, wait for price to drop to or below target
                if (rule.priceEntryTarget >= currentPriceNum) {
                    // Target is higher or equal - wait for price to rise
                    entryConditionMet = currentPriceNum >= rule.priceEntryTarget;
                } else {
                    // Target is lower - wait for price to drop (buy the dip)
                    entryConditionMet = currentPriceNum <= rule.priceEntryTarget;
                }

                logData = {
                    currentPrice: currentPriceNum,
                    targetPrice: rule.priceEntryTarget,
                    type: 'price-based',
                    condition: rule.priceEntryTarget >= currentPriceNum ? 'wait-for-rise' : 'wait-for-dip'
                };
            } else if (rule.marketCapEntryTarget) {
                // Market cap-based entry logic (backwards compatibility)
                entryConditionMet = currentMarketCap >= rule.marketCapEntryTarget;
                logData = {
                    currentMarketCap,
                    targetMarketCap: rule.marketCapEntryTarget,
                    type: 'market-cap-based'
                };
            }

            if (entryConditionMet) {
                // Create unique key for this specific auto-trade rule
                const autoTradeKey = `${rule.telegramId}_${rule.tokenAddress}_buy`;

                // Check if this auto-trade is already executing
                if (this.executingAutoTrades.has(autoTradeKey)) {
                    logger.info('Auto-buy already executing for this rule, skipping', {
                        userId: rule.telegramId,
                        tokenAddress: rule.tokenAddress,
                        symbol: token.symbol
                    });
                    return;
                }

                logger.info('Auto-trade entry condition met', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    ...logData,
                    entryAmountBNB: rule.entryAmountBNB,
                    entryAmountUSD: rule.entryAmountUSD
                });

                // Mark as executing and update status immediately
                this.executingAutoTrades.add(autoTradeKey);

                // Update rule status to prevent duplicate executions
                rule.autoTradeStatus = 'executing_entry';
                await rule.save();

                try {
                    await this.executeAutoBuy(rule, token, currentPrice);
                } finally {
                    // Always remove the execution lock, regardless of success/failure
                    this.executingAutoTrades.delete(autoTradeKey);
                }
                return; // Exit after processing entry
            }
        }

        // Check exit conditions (take profit or stop loss)
        if (rule.autoTradeStatus === 'position_open') {
            let shouldSell = false;
            let sellReason = '';

            if (rule.takeProfitPrice && currentPriceNum >= rule.takeProfitPrice) {
                shouldSell = true;
                sellReason = 'take_profit';
                logger.info('Auto-trade take profit condition met', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    currentPrice: currentPriceNum,
                    takeProfitPrice: rule.takeProfitPrice
                });
            } else if (rule.stopLossPrice && currentPriceNum <= rule.stopLossPrice) {
                shouldSell = true;
                sellReason = 'stop_loss';
                logger.info('Auto-trade stop loss condition met', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    currentPrice: currentPriceNum,
                    stopLossPrice: rule.stopLossPrice
                });
            }

            if (shouldSell) {
                // Create unique key for this specific auto-trade rule
                const autoTradeKey = `${rule.telegramId}_${rule.tokenAddress}_sell`;

                // Check if this auto-trade is already executing
                if (this.executingAutoTrades.has(autoTradeKey)) {
                    logger.info('Auto-sell already executing for this rule, skipping', {
                        userId: rule.telegramId,
                        tokenAddress: rule.tokenAddress,
                        symbol: token.symbol,
                        reason: sellReason
                    });
                    return;
                }

                // Mark as executing
                this.executingAutoTrades.add(autoTradeKey);

                try {
                    await this.executeAutoSell(rule, token, currentPrice, sellReason);
                } finally {
                    // Always remove the execution lock
                    this.executingAutoTrades.delete(autoTradeKey);
                }
            }
        }
    }

    /**
     * Execute automated buy order
     */
    private async executeAutoBuy(rule: any, token: MonitoredToken, currentPrice: string): Promise<void> {
        try {
            logger.info('Executing auto-buy order', {
                userId: rule.telegramId,
                tokenAddress: rule.tokenAddress,
                symbol: token.symbol,
                entryAmountBNB: rule.entryAmountBNB,
                entryAmountUSD: rule.entryAmountUSD
            });

            // Import trading service
            const { TradingService } = await import('./trading');

            // Determine BNB amount to use
            let bnbAmount: string;
            if (rule.entryAmountBNB) {
                // Use BNB amount directly
                bnbAmount = rule.entryAmountBNB.toString();
            } else if (rule.entryAmountUSD) {
                // Convert USD amount to BNB amount (rough approximation, the trading service will handle exact conversion)
                const bnbPrice = 300; // Approximate BNB price in USD - trading service will get exact price
                bnbAmount = (rule.entryAmountUSD / bnbPrice).toFixed(4);
            } else {
                logger.error('No entry amount found for auto-buy', { userId: rule.telegramId, tokenAddress: rule.tokenAddress });
                return;
            }

            // Execute the buy order
            const tradingService = new TradingService();
            const result = await tradingService.executeAutoBuy(
                rule.telegramId,
                rule.tokenAddress,
                bnbAmount
            );

            if (result.success) {
                // Update rule status to position_open
                rule.autoTradeStatus = 'position_open';
                await rule.save();

                // Send notification to user
                const tokensReceivedText = result.tokensReceived ? ` (${result.tokensReceived} ${token.symbol})` : '';
                const amountText = rule.entryAmountBNB
                    ? `${rule.entryAmountBNB} BNB${tokensReceivedText}`
                    : `$${rule.entryAmountUSD} worth of ${token.symbol}${tokensReceivedText}`;

                const attemptText = result.attempt && result.attempt > 1
                    ? ` (succeeded on attempt ${result.attempt})`
                    : '';

                const bscscanLink = result.txHash
                    ? `\n\n🔗 [View on BSCScan](https://bscscan.com/tx/${result.txHash})`
                    : '';

                await this.sendAutoTradeNotification(
                    rule.telegramId,
                    'buy',
                    token.symbol,
                    rule.tokenAddress,
                    currentPrice,
                    `✅ Auto-buy executed: ${amountText}${attemptText}${bscscanLink}`
                );

                logger.info('Auto-buy order executed successfully', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol
                });
            } else {
                logger.error('Auto-buy order failed', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    error: result.error,
                    balance: result.balance,
                    required: result.required
                });

                // Create detailed error message
                let errorMessage = `❌ Auto-buy failed for ${token.symbol}.`;

                if (result.error === 'Insufficient trading wallet balance') {
                    errorMessage += `\n\n💰 **Trading Wallet Balance:** ${result.balance} BNB`;
                    errorMessage += `\n📋 **Required:** ${result.required} BNB`;
                    errorMessage += `\n\n💡 **Action needed:** Transfer at least ${result.required} BNB to your trading wallet to enable auto-trading.`;
                    errorMessage += `\n\n🔄 Use: Main Menu → Wallet Info → Transfer → To Trading Wallet`;
                } else if (result.error) {
                    errorMessage += `\n\n🔍 **Error:** ${result.error}`;
                }

                // Reset status back to pending_entry so it can retry later
                rule.autoTradeStatus = 'pending_entry';
                await rule.save();

                // Send failure notification
                await this.sendAutoTradeNotification(
                    rule.telegramId,
                    'error',
                    token.symbol,
                    rule.tokenAddress,
                    currentPrice,
                    errorMessage
                );
            }

        } catch (error) {
            logger.error('Error executing auto-buy', {
                error,
                userId: rule.telegramId,
                tokenAddress: rule.tokenAddress
            });

            // Reset status back to pending_entry so it can retry later
            rule.autoTradeStatus = 'pending_entry';
            await rule.save();

            // Send error notification
            await this.sendAutoTradeNotification(
                rule.telegramId,
                'error',
                token.symbol,
                rule.tokenAddress,
                currentPrice,
                `❌ Auto-buy error for ${token.symbol}. Please check your settings.`
            );
        }
    }

    /**
     * Execute automated sell order
     */
    private async executeAutoSell(rule: any, token: MonitoredToken, currentPrice: string, reason: string): Promise<void> {
        try {
            logger.info('Executing auto-sell order', {
                userId: rule.telegramId,
                tokenAddress: rule.tokenAddress,
                symbol: token.symbol,
                reason
            });

            // Import trading service
            const { TradingService } = await import('./trading');

            // Execute the sell order (100% of holdings)
            const tradingService = new TradingService();
            const result = await tradingService.executeAutoSell(
                rule.telegramId,
                rule.tokenAddress,
                100 // Sell 100% of holdings
            );

            if (result.success) {
                // Update rule status to completed and deactivate
                rule.autoTradeStatus = 'completed';
                rule.isAutoTradeActive = false;
                await rule.save();

                // Send notification to user
                const reasonText = reason === 'take_profit' ? 'Take Profit' : 'Stop Loss';
                const bscscanLink = result.txHash
                    ? `\n\n🔗 [View on BSCScan](https://bscscan.com/tx/${result.txHash})`
                    : '';

                const bnbReceivedText = result.tokensReceived ? ` for ${result.tokensReceived} BNB` : '';
                await this.sendAutoTradeNotification(
                    rule.telegramId,
                    'sell',
                    token.symbol,
                    rule.tokenAddress,
                    currentPrice,
                    `${reasonText} executed: Sold all ${token.symbol} holdings${bnbReceivedText}${bscscanLink}`
                );

                logger.info('Auto-sell order executed successfully', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    reason
                });
            } else {
                logger.error('Auto-sell order failed', {
                    userId: rule.telegramId,
                    tokenAddress: rule.tokenAddress,
                    symbol: token.symbol,
                    reason
                });

                // Send failure notification with more detailed error message
                const reasonText = reason === 'take_profit' ? 'Take Profit' : 'Stop Loss';
                await this.sendAutoTradeNotification(
                    rule.telegramId,
                    'error',
                    token.symbol,
                    rule.tokenAddress,
                    currentPrice,
                    `❌ Auto-sell (${reasonText}) failed for ${token.symbol} after multiple attempts.\n\n` +
                    `💡 **Action needed:** Please check your trading wallet and try selling manually.\n\n` +
                    `🔄 The auto-trade rule remains active and will retry when conditions are met again.`
                );
            }

        } catch (error) {
            logger.error('Error executing auto-sell', {
                error,
                userId: rule.telegramId,
                tokenAddress: rule.tokenAddress,
                reason
            });

            // Send error notification
            await this.sendAutoTradeNotification(
                rule.telegramId,
                'error',
                token.symbol,
                rule.tokenAddress,
                currentPrice,
                `❌ Auto-sell error for ${token.symbol}. Please check your settings.`
            );
        }
    }

    /**
     * Calculate current market cap for a token
     */
    private async calculateCurrentMarketCap(token: MonitoredToken, currentPriceNum: number): Promise<number> {
        try {
            const { TrackedTokenModel } = await import('@/database/models/TrackedToken');

            // Get total supply from database
            const tokenData = await TrackedTokenModel.findOne({
                tokenAddress: token.tokenAddress.toLowerCase(),
                isActive: true
            });

            if (tokenData?.totalSupply) {
                const totalSupply = parseFloat(tokenData.totalSupply);
                return currentPriceNum * totalSupply;
            }

            // If no total supply in database, return 0
            return 0;

        } catch (error) {
            logger.error('Error calculating market cap', {
                error,
                tokenAddress: token.tokenAddress
            });
            return 0;
        }
    }

    /**
     * Send auto-trade notification to user
     */
    private async sendAutoTradeNotification(
        telegramId: number,
        type: 'buy' | 'sell' | 'error',
        symbol: string,
        tokenAddress: string,
        currentPrice: string,
        message: string
    ): Promise<void> {
        try {
            const bot = (globalThis as any).botExport;
            if (!bot) return;

            const emoji = type === 'buy' ? '🤖💰' : type === 'sell' ? '🤖📈' : '🤖❌';
            const title = type === 'buy' ? 'Auto-Buy Executed' : type === 'sell' ? 'Auto-Sell Executed' : 'Auto-Trade Error';

            const fullMessage = `${emoji} **${title}**\n\n` +
                `${message}\n\n` +
                `**Token:** ${symbol}\n` +
                `**Price:** $${parseFloat(currentPrice).toPrecision(6)}\n` +
                `**Contract:** \`${tokenAddress}\``;

            await bot.telegram.sendMessage(telegramId, fullMessage, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });

        } catch (error) {
            logger.error('Error sending auto-trade notification', {
                error,
                telegramId,
                type,
                symbol
            });
        }
    }

    /**
     * Robust price detection function that handles both V2 and V3 pools
     * Final corrected version with dual-direction calculation and sanity checks
     */
    private async getCurrentPriceFromPool(token: MonitoredToken): Promise<string> {
        if (!this.provider) return '0';

        const poolAddress = token.pairAddress;

        try {
            // Try V3 first
            const v3PoolContract = new ethers.Contract(poolAddress, V3_POOL_ABI, this.provider);
            const slot0 = await v3PoolContract.slot0();


            const [token0Address, token1Address] = await Promise.all([
                v3PoolContract.token0(),
                v3PoolContract.token1()
            ]);

            const [token0Details, token1Details] = await Promise.all([
                this.getTokenDetails(token0Address),
                this.getTokenDetails(token1Address)
            ]);

            const sqrtPriceX96 = slot0.sqrtPriceX96;
            if (sqrtPriceX96 === 0n) return '0';

            // Calculate the price ratio from sqrtPriceX96  
            const rawPrice = (Number(sqrtPriceX96) / Math.pow(2, 96)) ** 2;
            // CORRECTED: priceRatio represents "1 token0 can exchange for this many token1"
            // Fix decimal adjustment: should be token1.decimals - token0.decimals
            const priceRatio = rawPrice * Math.pow(10, (token1Details.decimals - token0Details.decimals));

            const targetIsToken0 = token.tokenAddress.toLowerCase() === token0Details.address;


            let finalPriceInUSD: number;

            if (targetIsToken0) {
                // We want to calculate token0's price in USD
                // Quote currency is token1 (WBNB)
                const quotePriceUSD = token1Details.isStablecoin ? 1.0 : await getBNBPrice();
                if (quotePriceUSD === 0) {
                    logger.warn('Invalid quote price for token0 calculation', { quotePriceUSD });
                    throw new Error("V3 quote token price unknown, try V2 fallback");
                }

                // CORRECTED FORMULA: Price(token0)_USD = (1 token0 exchanges for priceRatio token1) * Price(token1)_USD
                // Example: 1 Moolah = 0.0000129 WBNB, WBNB = $617.17
                // Moolah price = 0.0000129 * 617.17 = ~$0.008
                finalPriceInUSD = priceRatio * quotePriceUSD;


            } else {
                // We want to calculate token1's price in USD  
                // Quote currency is token0
                const quotePriceUSD = token0Details.isStablecoin ? 1.0 : await getBNBPrice();
                if (quotePriceUSD === 0 || priceRatio === 0) {
                    logger.warn('Invalid quote price for token1 calculation', { quotePriceUSD, priceRatio });
                    throw new Error("V3 quote token price unknown, try V2 fallback");
                }

                // CORRECTED FORMULA: Price(token1)_USD = Price(token0)_USD / (1 token0 exchanges for priceRatio token1)
                // If 1 token0 = priceRatio token1, then 1 token1 = (1/priceRatio) token0
                finalPriceInUSD = quotePriceUSD / priceRatio;

            }


            // Sanity check: If price is still unreasonable, something is wrong
            if (finalPriceInUSD > 1_000_000 || finalPriceInUSD < 0.0000000001) {
                logger.warn('Calculated V3 price is out of reasonable bounds, returning 0', {
                    finalPriceInUSD,
                    symbol: token.symbol
                });
                return '0';
            }

            return finalPriceInUSD.toString();

        } catch (error: any) {
            // If slot0() fails, it's likely a V2 pool, or if quote token price unknown
            if (error.code === 'CALL_EXCEPTION' || error.message?.includes('slot0') || error.message?.includes("V3 quote token price unknown")) {
                logger.debug('V3 call failed, trying V2 Pool', { pairAddress: poolAddress });

                // Fall back to V2 logic with same robust approach
                try {
                    const v2PoolContract = new ethers.Contract(poolAddress, PAIR_ABI, this.provider);

                    const [token0Address, token1Address, reserves] = await Promise.all([
                        v2PoolContract.token0(),
                        v2PoolContract.token1(),
                        v2PoolContract.getReserves()
                    ]);

                    const [token0Details, token1Details] = await Promise.all([
                        this.getTokenDetails(token0Address),
                        this.getTokenDetails(token1Address)
                    ]);

                    const reserve0 = BigInt(reserves[0]);
                    const reserve1 = BigInt(reserves[1]);

                    if (reserve0 === 0n || reserve1 === 0n) return '0';

                    // Determine which token is our target
                    const targetIsToken0 = token.tokenAddress.toLowerCase() === token0Details.address;
                    const [tokenReserve, pairedTokenReserve] = targetIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0];

                    // Calculate price: pairedTokenReserve / tokenReserve
                    const price = (pairedTokenReserve * BigInt(1e18)) / tokenReserve;
                    let priceInPairedToken = parseFloat(ethers.formatEther(price));

                    // Determine quote token USD price
                    let quoteTokenPriceUSD = 0;
                    if (targetIsToken0) {
                        quoteTokenPriceUSD = token1Details.isStablecoin ? 1.0 : (token1Details.usdPrice > 0 ? token1Details.usdPrice : await getBNBPrice());
                    } else {
                        quoteTokenPriceUSD = token0Details.isStablecoin ? 1.0 : (token0Details.usdPrice > 0 ? token0Details.usdPrice : await getBNBPrice());
                    }

                    const finalPriceInUSD = priceInPairedToken * quoteTokenPriceUSD;


                    return finalPriceInUSD.toString();
                } catch (v2Error) {
                    logger.error('Error getting price from V2 pool', { error: v2Error, pairAddress: poolAddress });
                    return '0';
                }
            }

            // Other unknown errors
            logger.error('Error getting current price from pool', { error, pairAddress: poolAddress, tokenAddress: token.tokenAddress });
            return '0';
        }
    }

    /**
     * Get token details including decimals, stablecoin status, and USD price
     */
    private async getTokenDetails(address: string): Promise<{
        address: string;
        decimals: number;
        isStablecoin: boolean;
        usdPrice: number
    }> {
        const stablecoins = [
            '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
            '0x55d398326f99059ff775485246999027b3197955', // USDT
            '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
            '0x1af3f329e8be154074d26654075ac426c1bca4a2', // DAI
            '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d'  // USD1
        ];

        const normalizedAddress = address.toLowerCase();
        const isStablecoin = stablecoins.includes(normalizedAddress);
        const isWBNB = normalizedAddress === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

        // Get token decimals
        let decimals = 18; // Default for most BSC tokens
        try {
            if (this.provider) {
                const contract = new ethers.Contract(address, ['function decimals() view returns (uint8)'], this.provider);
                decimals = Number(await contract.decimals());
            }
        } catch (error) {
            logger.warn('Failed to get token decimals, using default 18', { address, error });
        }

        // Get USD price
        let usdPrice = 0;
        if (isStablecoin) {
            usdPrice = 1.0;
        } else if (isWBNB) {
            try {
                usdPrice = await getBNBPrice();
            } catch (error) {
                logger.warn('Failed to get BNB price, using fallback', { error });
                usdPrice = 300; // Fallback BNB price
            }
        }

        const result = {
            address: normalizedAddress,
            decimals,
            isStablecoin,
            usdPrice
        };


        return result;
    }

    private startPriceMonitoring(): void {
        // Clear existing interval if any
        if (this.priceCheckInterval) {
            clearInterval(this.priceCheckInterval);
        }

        // Check prices every 60 seconds as backup to WebSocket events
        this.priceCheckInterval = setInterval(async () => {
            logger.info('Running periodic price check', { monitoredTokenCount: this.monitoredTokens.size });
            for (const token of this.monitoredTokens.values()) {
                logger.info('Checking token in periodic check', {
                    symbol: token.symbol,
                    tokenAddress: token.tokenAddress
                });
                await this.checkTokenPriceChange(token);
            }
        }, 60000); // 60 seconds

        logger.info('Started periodic price monitoring');
    }

    async stop(): Promise<void> {
        if (this.priceCheckInterval) {
            clearInterval(this.priceCheckInterval);
            this.priceCheckInterval = null;
        }

        if (this.provider) {
            try {
                await this.provider.destroy();
            } catch (error) {
                logger.warn('Error destroying WebSocket provider', { error });
            }
        }

        this.monitoredTokens.clear();
        this.isInitialized = false;
        logger.info('Token price monitor stopped');
    }

    // Getter for monitoring status
    getMonitoringStatus(): { isInitialized: boolean; tokenCount: number; tokens: string[] } {
        return {
            isInitialized: this.isInitialized,
            tokenCount: this.monitoredTokens.size,
            tokens: Array.from(this.monitoredTokens.keys())
        };
    }
}

export const tokenPriceMonitor = TokenPriceMonitor.getInstance();