import { Context } from 'telegraf';
import { UserModel } from '@/database/models/User';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { getWalletTokensWithPrices } from '@/services/wallet/scannerUtils';
import {
  findYieldOpportunitiesForTokens,
  formatTokenYieldOpportunities,
  formatTokenYieldOpportunitiesWithRisk,
  findBetterYieldForPositions,
  getSmartYieldOpportunities,
  getYieldOpportunitiesForIdleTokens,
  getAPYsForDeFiPositions,
  calculateWeightedAverageAPY,
  formatYieldOpportunityWithRisk,
  getRiskIndicators
} from '@/services/defiLlama/yieldService';
import { getTranslation, t, interpolate, getUserLanguage } from '@/i18n';
import { Markup } from 'telegraf';
import { PositionAnalyzer } from '@/services/defi/positionAnalyzer';
import { DeFiProtocolPosition, StakingPosition } from '@/database/models/DeFiPosition';
import { getEnhancedAPYForPositions } from '@/services/defi/apyCalculator';
import { createLogger } from '@/utils/logger';
import { geminiAI } from '@/services/ai/geminiService';
import { isKnownDeadToken } from '@/services/wallet/scanner';

const logger = createLogger('telegram.yieldTips');

interface TokenHolding {
  symbol: string;
  name: string;
  token_address: string;
  balance: string;
  decimals: number;
  usd_value?: number;
  usd_price?: number;
}

interface YieldData {
  userHoldings: TokenHolding[];
  defiPositions: DeFiProtocolPosition[];
  stakingPositions: StakingPosition[];
  userYieldOpportunities: Map<string, any[]>;
  topBSCYieldOpportunities: any[];
  positionSummary: any;
  idleCapitalReport: any;
}

/**
 * Check if a token is viable for yield recommendations
 */
async function isTokenViableForYield(token: TokenHolding): Promise<boolean> {
  const tokenAddress = token.token_address || '';

  // Handle native BNB (with address 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    // Always consider native BNB as viable if it has meaningful value
    return !!token.usd_value && token.usd_value > 1; // Require at least $1 of BNB
  }

  // 1. Basic value check - must have some meaningful value
  if (!token.usd_value || token.usd_value < 0.50) { // Minimum $0.50 to be worth yield farming
    logger.debug(`Filtering out ${token.symbol}: Too small value (${token.usd_value})`);
    return false;
  }

  // 2. Check against the DeadToken database - this is the most important and efficient check
  if (tokenAddress && await isKnownDeadToken(tokenAddress)) {
    logger.debug(`Filtering out ${token.symbol}: Found in DeadTokenModel`);
    return false;
  }

  // 3. Whitelist for major, legitimate tokens - these can bypass some stricter heuristic checks
  const whitelistedSymbols = [
    'WBNB', 'ETH', 'BTCB', 'USDT', 'USDC', 'BUSD', 'DAI', 'CAKE', 'XVS', 'ALPACA', 'AUTO', 'BIFI'
  ];
  if (whitelistedSymbols.includes(token.symbol.toUpperCase())) {
    return true; // It's a well-known token with value, so it's viable
  }

  // 4. Heuristic checks for non-whitelisted tokens
  // Filter out tokens with suspicious names that might indicate scams
  const suspiciousPatterns = [/test/i, /fake/i, /scam/i, /rug/i, /honeypot/i, /safe/i, /moon/i];
  if (suspiciousPatterns.some(pattern => pattern.test(token.symbol) || pattern.test(token.name))) {
    logger.debug(`Filtering out ${token.symbol}: Suspicious name pattern`);
    return false;
  }

  // 5. Check price - extremely low price for a non-whitelisted token is a red flag
  if (!token.usd_price || token.usd_price < 0.000001) {
    logger.debug(`Filtering out ${token.symbol}: Extremely low unit price (${token.usd_price})`);
    return false;
  }

  return true;
}

/**
 * Collect all necessary data for yield analysis
 */
export async function collectYieldData(userId: number): Promise<YieldData | null> {
  // Check session first (for active connections), then database
  const session = global.userSessions.get(userId);
  let mainWalletAddress: string | undefined;
  let tradingWalletAddress: string | undefined;

  // Try to get wallet from session first
  if (session?.address) {
    mainWalletAddress = session.address;
  } else {
    // Fallback to database
    const user = await UserModel.findOne({ telegramId: userId });
    if (user?.walletAddress) {
      mainWalletAddress = user.walletAddress;
    }
  }

  if (!mainWalletAddress) {
    return null;
  }

  // Get trading wallet address
  const user = await UserModel.findOne({ telegramId: userId });
  tradingWalletAddress = user?.tradingWalletAddress;

  const holdings = await getUserHoldings(userId, mainWalletAddress, tradingWalletAddress);
  const { defiPositions, stakingPositions } = await getUserDeFiPositions(userId, mainWalletAddress, tradingWalletAddress);
  const analyzer = new PositionAnalyzer();
  const idleCapitalReport = analyzer.analyzeIdleCapital(
    holdings.map(h => ({
      symbol: h.symbol,
      balance: parseFloat(h.balance),
      usdValue: h.usd_value || 0,
      address: h.token_address
    })),
    defiPositions,
    stakingPositions
  );

  const [userYieldOpportunities, topBSCYieldOpportunities] = await Promise.all([
    findYieldOpportunitiesForTokens(holdings),
    getSmartYieldOpportunities(10)
  ]);

  const positionSummary = analyzer.generatePositionSummary(defiPositions, stakingPositions);

  return {
    userHoldings: holdings,
    defiPositions,
    stakingPositions,
    userYieldOpportunities,
    topBSCYieldOpportunities,
    positionSummary,
    idleCapitalReport
  };
}

/**
 * Format the raw, detailed yield data message (the old format)
 */
function formatRawYieldData(data: YieldData, lang: 'en' | 'zh'): string {
  let message = t(lang, 'yieldTips.title') + '\n\n';

  // Show DeFi position summary
  if (data.positionSummary.totalValueLocked > 0) {
    message += '📊 *Your DeFi Position Summary*\n';
    message += `• Total Value Locked: ${data.positionSummary.totalValueLocked.toFixed(2)}\n`;
    message += `• Average APY: ${data.positionSummary.averageAPY.toFixed(1)}%\n`;
    message += `• Active Protocols: ${data.positionSummary.protocolCount}\n\n`;
  }

  // Show idle capital analysis
  if (data.idleCapitalReport.totalIdleUsd > 10) {
    message += '💸 *Idle Capital Alert*\n';
    data.idleCapitalReport.suggestions.forEach((suggestion: string) => {
      message += `${suggestion}\n`;
    });
    message += '\n';
  }

  // Show yield opportunities for top holdings
  const topHoldings = data.userHoldings
    .filter(h => h.usd_value && h.usd_value > 0.01)
    .sort((a, b) => (b.usd_value || 0) - (a.usd_value || 0))
    .slice(0, 5);

  for (const holding of topHoldings) {
    const opportunities = data.userYieldOpportunities.get(holding.symbol) || [];
    if (opportunities.length > 0) {
      message += formatTokenYieldOpportunitiesWithRisk(holding.symbol, opportunities, lang);
    }
  }

  // Add top BSC yield opportunities
  message += '\n' + t(lang, 'yieldTips.topBSCYield') + '\n\n';
  data.topBSCYieldOpportunities.forEach((pool, index) => {
    message += `${index + 1}. ${formatYieldOpportunityWithRisk(pool)}\n`;
  });

  message += t(lang, 'yieldTips.disclaimer');
  return message;
}

/**
 * Handle yield tips command - NEW AI-DRIVEN FLOW
 */
export async function handleYieldTips(ctx: Context, isRefresh = false) {
  const userId = ctx.from!.id;
  const lang = await getUserLanguage(userId);

  try {
    if (!isRefresh) {
      await ctx.reply(t(lang, 'yieldTips.analyzingHoldings'));
    }

    const data = await collectYieldData(userId);

    if (!data) {
      const backButtonText = await getTranslation(ctx, 'common.back');
      await ctx.reply(t(lang, 'yieldTips.noWalletConnected'), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: backButtonText, callback_data: 'start_edit' }]
          ]
        }
      });
      return;
    }

    if (data.userHoldings.length === 0) {
      const backButtonText = await getTranslation(ctx, 'common.back');
      const refreshButtonText = await getTranslation(ctx, 'yieldTips.refresh');
      await ctx.reply(t(lang, 'yieldTips.noHoldingsFound'), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: refreshButtonText, callback_data: 'yield_refresh' },
              { text: backButtonText, callback_data: 'start_edit' }
            ]
          ]
        }
      });
      return;
    }

    // Pass data to Gemini for conversational analysis
    const aiAnalysis = await geminiAI.analyzeYieldData(data, lang);

    const keyboard = {
      inline_keyboard: [
        [
          { text: t(lang, 'yieldTips.viewRawData'), callback_data: 'yield_raw_data' },
          { text: t(lang, 'yieldTips.refresh'), callback_data: 'yield_refresh' }
        ],
        [{ text: t(lang, 'yieldTips.backToMenu'), callback_data: 'start' }]
      ]
    };

    if (isRefresh && ctx.callbackQuery?.message) {
      await ctx.editMessageText(aiAnalysis, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true }
      });
    } else {
      await ctx.reply(aiAnalysis, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true }
      });
    }

  } catch (error) {
    logger.error('Error in handleYieldTips', { userId, error: error instanceof Error ? error.message : String(error) });
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(
      '❌ An error occurred while fetching yield opportunities.\n\n' +
      'Please try again later.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: backButtonText, callback_data: 'start_edit' }]
          ]
        }
      }
    );
  }
}

/**
 * Get user's token holdings from wallet and cache
 */
async function getUserHoldings(
  userId: number,
  walletAddress: string,
  tradingWalletAddress?: string
): Promise<TokenHolding[]> {
  const allHoldings: TokenHolding[] = [];
  const processedTokens = new Set<string>(); // To avoid duplicates

  // First, check cached DeFi positions for token holdings info
  const walletAddresses = [walletAddress];
  if (tradingWalletAddress) {
    walletAddresses.push(tradingWalletAddress);
  }

  for (const address of walletAddresses) {
    try {
      // Get tokens from wallet
      const tokensData = await getWalletTokensWithPrices(address);
      let tokens: any[] = [];

      if (Array.isArray(tokensData)) {
        tokens = tokensData;
      } else if (Array.isArray((tokensData as any).result)) {
        tokens = (tokensData as any).result;
      }

      // Process tokens asynchronously with the new filter
      const processingPromises = tokens.map(async (token: any) => {
        // Basic validation first
        if (!token.symbol || typeof token.symbol !== 'string' || token.symbol.trim().length === 0) {
          return null;
        }

        const symbol = token.symbol.trim().toUpperCase();
        if (symbol.includes('NULL') || symbol.includes('UNDEFINED')) {
          return null;
        }

        const tokenAddress = token.token_address || token.address || '';
        const tokenKey = `${symbol}_${tokenAddress.toLowerCase()}`;
        if (processedTokens.has(tokenKey)) {
          return null;
        }

        const holding: TokenHolding = {
          symbol: symbol,
          name: token.name || 'Unknown Token',
          token_address: tokenAddress,
          balance: token.balance || '0',
          decimals: token.decimals || 18,
          usd_value: token.usd_value || 0,
          usd_price: token.usd_price || 0,
        };

        // Apply the new, stricter filter
        if (await isTokenViableForYield(holding)) {
          processedTokens.add(tokenKey);
          return holding;
        }

        return null;
      });

      const viableHoldings = (await Promise.all(processingPromises)).filter(h => h !== null) as TokenHolding[];
      allHoldings.push(...viableHoldings);

      // Also check cached DeFi positions for additional tokens
      const cachedPosition = await DeFiPosition.findOne({
        userId: userId,
        walletAddress: address.toLowerCase()
      });

      if (cachedPosition && cachedPosition.defiPositions) {
        const defiTokenPromises: Promise<TokenHolding | null>[] = [];

        for (const protocol of cachedPosition.defiPositions) {
          if (protocol.tokens) {
            for (const token of protocol.tokens) {
              if (token.token_type === 'supplied' && token.usd_value && token.usd_value > 0.01) {
                // Basic validation first
                if (!token.symbol || typeof token.symbol !== 'string') continue;

                const symbol = token.symbol.trim().toUpperCase();
                if (symbol.length === 0 || symbol.includes('NULL') || symbol.includes('UNDEFINED')) continue;

                const tokenAddress = token.token_address || '';
                const tokenKey = `${symbol}_${tokenAddress.toLowerCase()}`;
                if (processedTokens.has(tokenKey)) continue;

                // Create a promise to process this DeFi token
                defiTokenPromises.push((async () => {
                  const holding: TokenHolding = {
                    symbol: symbol,
                    name: token.symbol, // Using symbol as name since name is not in TokenDetail
                    token_address: tokenAddress,
                    balance: token.balance_formatted,
                    decimals: 18, // Default decimals
                    usd_value: token.usd_value,
                    usd_price: 0 // Price not available in TokenDetail - may be filtered out
                  };

                  // Apply the same strict filtering to DeFi tokens
                  if (await isTokenViableForYield(holding)) {
                    processedTokens.add(tokenKey);
                    return holding;
                  }

                  return null;
                })());
              }
            }
          }
        }

        // Process all DeFi tokens and add viable ones
        const viableDefiHoldings = (await Promise.all(defiTokenPromises)).filter(h => h !== null) as TokenHolding[];
        allHoldings.push(...viableDefiHoldings);
      }
    } catch (error) {
      logger.error('Error fetching holdings', { address, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Sort by USD value descending
  return allHoldings.sort((a, b) => (b.usd_value || 0) - (a.usd_value || 0));
}

/**
 * Get user's DeFi positions from cache
 */
async function getUserDeFiPositions(
  userId: number,
  walletAddress: string,
  tradingWalletAddress?: string
): Promise<{ defiPositions: DeFiProtocolPosition[], stakingPositions: StakingPosition[] }> {
  const defiPositions: DeFiProtocolPosition[] = [];
  const stakingPositions: StakingPosition[] = [];

  const walletAddresses = [walletAddress];
  if (tradingWalletAddress) {
    walletAddresses.push(tradingWalletAddress);
  }

  for (const address of walletAddresses) {
    try {
      const cachedPosition = await DeFiPosition.findOne({
        userId: userId,
        walletAddress: address.toLowerCase()
      });

      if (cachedPosition) {
        if (cachedPosition.defiPositions && cachedPosition.defiPositions.length > 0) {
          defiPositions.push(...cachedPosition.defiPositions);
        }

        if (cachedPosition.stakingPositions && cachedPosition.stakingPositions.length > 0) {
          stakingPositions.push(...cachedPosition.stakingPositions);
        }
      }
    } catch (error) {
      logger.error('Error fetching DeFi positions', { address, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { defiPositions, stakingPositions };
}

/**
 * Handle showing the raw yield data
 */
export async function handleYieldRawDataCallback(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLanguage(userId);
  await ctx.answerCbQuery();
  await ctx.editMessageText('Loading raw data...');

  const data = await collectYieldData(userId);
  if (!data) {
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.editMessageText(t(lang, 'yieldTips.noWalletConnected'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
    return;
  }

  const rawMessage = formatRawYieldData(data, lang);

  const keyboard = {
    inline_keyboard: [
      [
        { text: t(lang, 'yieldTips.viewAIAnalysis'), callback_data: 'yield_ai_analysis' },
        { text: t(lang, 'yieldTips.refresh'), callback_data: 'yield_refresh_raw' }
      ],
      [{ text: t(lang, 'yieldTips.backToMenu'), callback_data: 'start' }]
    ]
  };

  // Split message if too long
  if (rawMessage.length > 4096) {
    const parts = [];
    for (let i = 0; i < rawMessage.length; i += 4096) {
      parts.push(rawMessage.substring(i, i + 4096));
    }
    await ctx.editMessageText(parts[0], {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });
    for (let i = 1; i < parts.length; i++) {
      const finalPart = i === parts.length - 1;
      await ctx.reply(parts[i], {
        parse_mode: 'Markdown',
        reply_markup: finalPart ? keyboard : undefined,
        link_preview_options: { is_disabled: true }
      });
    }
  } else {
    await ctx.editMessageText(rawMessage, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true }
    });
  }
}

/**
 * Handle yield refresh callback
 */
export async function handleYieldRefresh(ctx: Context) {
  await ctx.answerCbQuery('Refreshing yield opportunities...');
  await handleYieldTips(ctx, true);
}