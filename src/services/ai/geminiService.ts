import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { getWalletTokensWithPrices, formatTokenBalance } from '@/services/wallet/scannerUtils';
import { TokenPriceModel } from '@/database/models/TokenPrice';
import { formatUSDValue } from '@/services/wallet/balance';
import { getDeFiPositions } from '@/services/defi';
import { detectStakingPositions } from '@/services/staking';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { ChatHistoryModel } from '@/database/models/ChatHistory';
import { UserModel } from '@/database/models/User';
import { createLogger } from '@/utils/logger';
import { getUserLanguage } from '@/i18n';
import { sentimentService } from '@/services/sentiment';

const logger = createLogger('ai.gemini');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY!);

// Helper function to check if user has debug mode enabled
async function isDebugModeEnabled(userId: string | number): Promise<boolean> {
  try {
    const numericUserId = Number(userId);
    const user = await UserModel.findOne({ telegramId: numericUserId });
    return user?.debugMode || false;
  } catch (error) {
    logger.error('Error checking debug mode', { error, userId });
    return false;
  }
}

// Token limits
const MAX_CONTEXT_TOKENS = 100000; // 100k token rolling window
const APPROX_CHARS_PER_TOKEN = 4; // Rough estimate for token counting

// Chat history management
const CHAT_SESSION_TIMEOUT_HOURS = 2; // Only load messages from the last 2 hours
const MAX_HISTORY_MESSAGES = 15; // Maximum number of messages to load

const tools: any[] = [
  {
    functionDeclarations: [
      {
        name: 'getPortfolio',
        description: 'MANDATORY for BNB Chain: Get user wallet portfolio on BNB Chain mainnet. Use this ONLY when the user\'s selected chain is BNB Chain and they ask about portfolio, balance, holdings, or tokens. NEVER use this for opBNB queries.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletType: {
              type: SchemaType.STRING,
              description: 'Wallet to query: "main" (connected wallet), "trading" (bot trading wallet, (Default that you should select)), "both" (combined), or a specific wallet address',
              enum: ['main', 'trading', 'both']
            }
          },
          required: []
        }
      },
      {
        name: 'getYieldInfo',
        description: 'Get user DeFi positions and yield farming information only. This will also provide the current yield opportunities in the market, not just the user\'s holdings. Use this whenever user asks about yield farming, staking, or DeFi positions.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletType: {
              type: SchemaType.STRING,
              description: 'Wallet to query: "main" (connected wallet), "trading" (bot trading wallet,  (Default that you should select)), "both" (combined), or a specific wallet address',
              enum: ['main', 'trading', 'both']
            }
          },
          required: []
        }
      },
      {
        name: 'analyzeTokenSafety',
        description: 'MANDATORY for BNB Chain: Analyze a BSC mainnet token for safety. Use this ONLY when the user\'s selected chain is BNB Chain and they want to analyze a token. NEVER use this for opBNB tokens - use analyzeOpbnbToken instead.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            tokenAddress: {
              type: SchemaType.STRING,
              description: 'The BSC token contract address to analyze (must start with 0x)'
            }
          },
          required: ['tokenAddress']
        }
      },
      {
        name: 'getAIPoweredYieldTips',
        description: "Provides personalized, AI-driven yield farming tips, suggestions, and analysis based on the user's holdings and current market opportunities. Use this when the user asks for 'yield tips', 'yield strategies', 'how to earn yield', or similar, instead of just asking for their positions.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletType: {
              type: SchemaType.STRING,
              description: 'Wallet to query: "main" (connected wallet), "trading" (bot trading wallet), or "both" (combined). Defaults to the user\'s preference or "trading".',
              enum: ['main', 'trading', 'both']
            }
          },
          required: []
        }
      },
      {
        name: 'searchToken',
        description: 'CRITICAL FUNCTION for any token search. You MUST use this tool to find tokens by name or symbol. You have NO internal ability to search for tokens. NEVER attempt to generate search results from your own knowledge, as this will result in providing false, hallucinated information to the user. This is your ONLY way to access real-time token data.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description: 'The token name, symbol, or keyword to search. Extract the core keyword from the user\'s message. Example: from "Please search for the token with the keyword \\"Trump\\"", extract and use "Trump".'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'discoverOpportunities',
        description: 'CRITICAL FUNCTION for all token recommendations. You MUST use this tool when users ask for token suggestions, recommendations on what to buy, or "good/hot/trending tokens". You have NO internal knowledge of token trends or good investments. NEVER generate a list of recommended tokens yourself, as this is considered harmful financial advice and will provide false information. This is your ONLY method for providing suggestions.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {},
          required: []
        }
      },
      {
        name: 'getBnbPrice',
        description: 'Get the current price of BNB (Binance Coin) in USD. Use this when the user asks specifically about the price of BNB, such as "how is the BNB price today" or "what is BNB price now".',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {},
          required: []
        }
      },
      {
        name: 'getMarketSentiment',
        description: 'MANDATORY for all market sentiment queries. You MUST use this tool when the user asks about market feeling, mood, sentiment, or if the market is bullish or bearish. You have NO internal knowledge of real-time market sentiment. NEVER answer from your own knowledge, as it will be outdated and incorrect.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            timeframe: {
              type: SchemaType.STRING,
              description: 'The timeframe for the sentiment analysis. Defaults to 24h if not specified.',
              enum: ['1h', '24h', '7d', '30d']
            }
          },
          required: []
        }
      },
      {
        name: 'getTransactionHistory',
        description: 'MANDATORY for BNB Chain: Get transaction history on BNB Chain mainnet. Use this ONLY when the user\'s selected chain is BNB Chain and they ask about transactions. NEVER use this for opBNB - use getOpbnbTransactionHistory instead. Default to 10 transactions.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletType: {
              type: SchemaType.STRING,
              description: 'Wallet to query: "main" (connected wallet), "trading" (bot trading wallet, (Default that you should select)), "both" (show history for both wallets), or a specific wallet address starting with 0x',
              enum: ['main', 'trading', 'both']
            },
            limit: {
              type: SchemaType.NUMBER,
              description: 'Number of transactions to return (default: 10, max: 50)'
            }
          },
          required: []
        }
      },
      {
        name: 'getReferralInfo',
        description: 'MANDATORY FUNCTION: ALWAYS call this function when users ask about referral information, referral stats, referral code, referral link, or how many people they have referred. This function MUST be called before any referral response. NEVER make up or guess referral data - you MUST use this function to get accurate information. If you respond to referral queries without calling this function, you will be providing false information.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {},
          required: []
        }
      },
      {
        name: 'enterReferralCode',
        description: 'Guide user to enter a referral code. Use this when users want to enter, redeem, or use someone else\'s referral code. Trigger this for phrases like "I want to enter a referral code", "enter referral code", "redeem referral code", "use referral code", "input referral code", or any variation where the user wants to enter/redeem a code.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {},
          required: []
        }
      },
      {
        name: 'switchChain',
        description: 'Switch the AI assistant chain context between BNB Chain and opBNB. Use this when users say things like "switch to opBNB", "use opBNB chain", "change to BNB chain", "switch chain", etc.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            chain: {
              type: SchemaType.STRING,
              description: 'The chain to switch to',
              enum: ['bnb', 'opbnb']
            }
          },
          required: ['chain']
        }
      },
      {
        name: 'getOpbnbPortfolio',
        description: 'MANDATORY for opBNB chain: Get opBNB Layer 2 wallet portfolio, holdings, balance, tokens. Use this ONLY when the user\'s selected chain is opBNB and they ask about portfolio, balance, holdings, or tokens.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletAddress: {
              type: SchemaType.STRING,
              description: 'Optional specific wallet address to check. If not provided, will use the user\'s connected main wallet.'
            }
          },
          required: []
        }
      },
      {
        name: 'getOpbnbTransactionHistory',
        description: 'MANDATORY for opBNB chain: Get opBNB Layer 2 transaction history. Use this ONLY when the user\'s selected chain is opBNB and they ask about transactions or transaction history. Default to 10 transactions if not specified.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            walletAddress: {
              type: SchemaType.STRING,
              description: 'Optional specific wallet address to check. If not provided, will use the user\'s connected main wallet.'
            },
            limit: {
              type: SchemaType.NUMBER,
              description: 'Number of transactions to return (default: 10, max: 50)'
            }
          },
          required: []
        }
      },
      {
        name: 'analyzeOpbnbToken',
        description: 'MANDATORY for opBNB chain: Analyze an opBNB Layer 2 token for safety. Use this ONLY when the user\'s selected chain is opBNB and they want to analyze a token. NEVER use analyzeTokenSafety for opBNB tokens.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            tokenAddress: {
              type: SchemaType.STRING,
              description: 'The opBNB token contract address to analyze (must start with 0x)'
            }
          },
          required: ['tokenAddress']
        }
      },
      {
        name: 'getOpbnbWhaleTracker',
        description: 'Get whale holder analysis for an opBNB token. Shows top holders, concentration metrics, and distribution analysis. Use when users ask about whales, top holders, holder distribution, or concentration for opBNB tokens.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            tokenAddress: {
              type: SchemaType.STRING,
              description: 'The opBNB token contract address to analyze whale holders (must start with 0x)'
            },
            limit: {
              type: SchemaType.NUMBER,
              description: 'Number of top holders to return (default: 20, max: 50)'
            }
          },
          required: ['tokenAddress']
        }
      },
      {
        name: 'getOpbnbHotTokens',
        description: 'Get trending/hot tokens on opBNB network ranked by transfer activity. Use when users ask about trending tokens, hot tokens, popular tokens, or what tokens are active on opBNB.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            limit: {
              type: SchemaType.NUMBER,
              description: 'Number of hot tokens to return (default: 20, max: 50)'
            }
          }
        }
      },
      {
        name: 'getOpbnbTokenHealth',
        description: 'Perform comprehensive health check on an opBNB token including holder metrics, concentration analysis, activity levels, and risk assessment. Use when users ask about token health, safety, risk analysis, or detailed token metrics on opBNB.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            tokenAddress: {
              type: SchemaType.STRING,
              description: 'The opBNB token contract address to perform health check (must start with 0x)'
            }
          },
          required: ['tokenAddress']
        }
      },
    ]
  }
];

function formatWalletAddress(address: string): string {
  // Return full address for AI responses
  return address;
}


async function getMarketSentiment(timeframe: '1h' | '24h' | '7d' | '30d' = '24h') {
  try {
    const lang = 'en'; // Default to English for AI analysis
    const sentimentData = await sentimentService.analyzeBSCSentiment(timeframe, lang);

    if (!sentimentData) {
      return {
        error: 'Analysis failed',
        message: 'Unable to retrieve market sentiment data at the moment.'
      };
    }

    // Format data for AI consumption
    return {
      timeframe: timeframe,
      overallScore: sentimentData.overall.score,
      overallLabel: sentimentData.overall.label,
      confidence: sentimentData.overall.confidence,
      newsScore: sentimentData.sources.news.score,
      newsArticles: sentimentData.sources.news.articles,
      topHeadlines: sentimentData.sources.news.topHeadlines,
      socialScore: sentimentData.sources.social.score,
      socialMentions: sentimentData.sources.social.mentions,
      socialTrending: sentimentData.sources.social.trending,
      priceChange24h: sentimentData.sources.market.priceChange24h,
      volumeChange24h: sentimentData.sources.market.volumeChange24h,
      dominance: sentimentData.sources.market.dominance,
      insights: sentimentData.insights
    };
  } catch (error) {
    logger.error('Error fetching market sentiment for AI', { timeframe, error });
    return {
      error: 'API Error',
      message: 'An error occurred while fetching market sentiment.'
    };
  }
}

// AI-powered yield tips function  
async function getAIPoweredYieldTips(userId: string, _walletType?: string) {
  const lang = await getUserLanguage(Number(userId));

  // Import the same data collection function used by the yield tips button
  const yieldTipsModule = await import('@/telegram/handlers/yieldTips');
  const data = await yieldTipsModule.collectYieldData(Number(userId));

  if (!data) {
    return {
      error: 'No wallet connected',
      message: 'Please connect a wallet to get personalized yield tips.'
    };
  }

  if (data.userHoldings.length === 0) {
    return {
      error: 'No holdings found',
      message: 'No token holdings were found in the selected wallets.'
    };
  }

  const analysis = await geminiAI.analyzeYieldData(data, lang);

  // Return the complete analysis as a single string
  return {
    analysis: analysis
  };
}

async function getPortfolio(userId: string, walletType?: string) {
  const numericUserId = Number(userId);
  const session = global.userSessions.get(numericUserId);

  logger.info('getPortfolio called', {
    userId,
    numericUserId,
    hasSession: !!session,
    sessionAddress: session?.address,
    walletType
  });

  const { UserService } = await import('../user');

  // Determine which wallet(s) to query
  let walletsToQuery: { address: string; type: string }[] = [];

  // Use session's selected wallet if no walletType specified
  // Default to 'trading' as per the system instruction
  const effectiveWalletType = walletType || session?.selectedWallet || 'trading';

  // Handle wallet selection
  if (effectiveWalletType === 'main') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
  } else if (effectiveWalletType === 'trading') {
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    if (!tradingWallet) {
      return {
        error: 'No trading wallet found',
        message: 'Trading wallet has not been set up yet'
      };
    }
    walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
  } else if (effectiveWalletType === 'both') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
    if (tradingWallet) {
      walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
    }
  } else if (effectiveWalletType.startsWith('0x')) {
    // Specific wallet address provided
    walletsToQuery.push({ address: effectiveWalletType, type: 'Custom Wallet' });
  }

  try {
    // Fetch data for all wallets in parallel
    const portfolioPromises = walletsToQuery.map(async (wallet) => {
      const walletAddress = wallet.address;
      const tokensData = await getWalletTokensWithPrices(walletAddress);

      let tokens: any[] = [];
      if (Array.isArray(tokensData)) {
        tokens = tokensData;
      } else if (Array.isArray((tokensData as any).result)) {
        tokens = (tokensData as any).result;
      } else {
        tokens = [];
      }

      const tokenDetails = await Promise.all(
        tokens.map(async (token: any) => {
          const tokenAddress = token.token_address || token.address;
          const priceData = await TokenPriceModel.findOne({
            tokenAddress: tokenAddress.toLowerCase()
          }).sort({ lastUpdated: -1 });

          const balance = formatTokenBalance(token.balance, token.decimals || 18);
          const priceUSD = token.usd_price || priceData?.price || 0;
          const valueUSD = token.usd_value || 0;

          return {
            name: token.name || 'Unknown Token',
            symbol: token.symbol || 'UNKNOWN',
            balance: balance,
            address: tokenAddress,
            priceUSD: priceUSD,
            valueUSD: valueUSD,
            logo: token.logo || token.thumbnail
          };
        })
      );

      // Fetch DeFi positions
      let defiPositions: any[] = [];
      let stakingPositions: any[] = [];
      let totalDefiValue = 0;
      let totalStakingValue = 0;

      try {
        // Check cache first
        const cachedPosition = await DeFiPosition.findOne({
          userId: Number(userId),
          walletAddress: walletAddress.toLowerCase()
        });

        const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
        const shouldRefresh = !cachedPosition ||
          (Date.now() - cachedPosition.lastRefreshAt.getTime()) > CACHE_DURATION_MS;

        if (shouldRefresh) {
          // Fetch fresh data
          stakingPositions = await detectStakingPositions(walletAddress);
          defiPositions = await getDeFiPositions(walletAddress);

          totalStakingValue = stakingPositions.reduce((sum, pos) => sum + (pos.usdValue || 0), 0);
          totalDefiValue = defiPositions.reduce((sum, protocol) => {
            const positionValue = protocol.position.balance_usd || 0;
            const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
            return sum + positionValue + unclaimedValue;
          }, 0);
        } else {
          // Use cached data
          stakingPositions = cachedPosition.stakingPositions || [];
          defiPositions = cachedPosition.defiPositions || [];
          totalStakingValue = cachedPosition.totalStakingValue || 0;
          totalDefiValue = cachedPosition.totalDefiValue || 0;
        }
      } catch (error) {
        logger.error('Error fetching DeFi positions', error);
      }

      const totalTokenValue = tokenDetails.reduce((sum, token) => sum + token.valueUSD, 0);
      const totalPortfolioValue = totalTokenValue + totalDefiValue + totalStakingValue;

      // Find BNB in the token list
      const bnbToken = tokenDetails.find(token =>
        token.symbol === 'BNB' ||
        token.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      );

      return {
        walletType: wallet.type,
        walletAddress: walletAddress,
        shortWalletAddress: formatWalletAddress(walletAddress),
        totalPortfolioValue: totalPortfolioValue,
        totalTokenValue: totalTokenValue,
        totalDefiValue: totalDefiValue + totalStakingValue,
        bnbBalance: bnbToken ? {
          value: bnbToken.balance,
          valueUSD: bnbToken.valueUSD
        } : null,
        tokens: tokenDetails,
        tokenCount: tokenDetails.length,
        defiPositions: defiPositions,
        stakingPositions: stakingPositions,
        hasDefiPositions: defiPositions.length > 0 || stakingPositions.length > 0
      };
    });

    // Wait for all portfolios to complete
    const portfolios = await Promise.all(portfolioPromises);

    // If single wallet, return it directly
    if (portfolios.length === 1) {
      const portfolio = portfolios[0];
      return {
        ...portfolio,
        totalPortfolioValue: formatUSDValue(portfolio.totalPortfolioValue),
        totalTokenValue: formatUSDValue(portfolio.totalTokenValue),
        totalDefiValue: formatUSDValue(portfolio.totalDefiValue),
        bnbBalance: portfolio.bnbBalance ? {
          value: portfolio.bnbBalance.value,
          valueUSD: formatUSDValue(portfolio.bnbBalance.valueUSD)
        } : null,
        tokens: portfolio.tokens.map(token => ({
          ...token,
          valueUSD: formatUSDValue(token.valueUSD),
          priceUSD: formatUSDValue(token.priceUSD)
        }))
      };
    }

    // Combine multiple wallets
    const combinedTokens = new Map();
    let totalPortfolioValue = 0;
    let totalTokenValue = 0;
    let totalDefiValue = 0;
    let totalBnbValue = 0;
    let totalBnbBalance = 0;
    const allDefiPositions: any[] = [];
    const allStakingPositions: any[] = [];

    // Aggregate data from all wallets
    for (const portfolio of portfolios) {
      totalPortfolioValue += portfolio.totalPortfolioValue;
      totalTokenValue += portfolio.totalTokenValue;
      totalDefiValue += portfolio.totalDefiValue;

      // Aggregate tokens
      for (const token of portfolio.tokens) {
        const key = token.address.toLowerCase();
        if (combinedTokens.has(key)) {
          const existing = combinedTokens.get(key);
          existing.balance = (parseFloat(existing.balance) + parseFloat(token.balance)).toString();
          existing.valueUSD += token.valueUSD;
          existing.wallets = [...(existing.wallets || []), portfolio.walletType];
        } else {
          combinedTokens.set(key, {
            ...token,
            wallets: [portfolio.walletType]
          });
        }
      }

      // Aggregate BNB
      if (portfolio.bnbBalance) {
        totalBnbBalance += parseFloat(portfolio.bnbBalance.value);
        totalBnbValue += portfolio.bnbBalance.valueUSD;
      }

      // Aggregate DeFi positions
      allDefiPositions.push(...portfolio.defiPositions.map((pos: any) => ({
        ...pos,
        walletType: portfolio.walletType
      })));
      allStakingPositions.push(...portfolio.stakingPositions.map((pos: any) => ({
        ...pos,
        walletType: portfolio.walletType
      })));
    }

    // Convert combined tokens map to array
    const combinedTokenArray = Array.from(combinedTokens.values())
      .sort((a, b) => b.valueUSD - a.valueUSD);

    return {
      walletType: 'Combined',
      wallets: walletsToQuery.map(w => ({
        type: w.type,
        address: formatWalletAddress(w.address)
      })),
      totalPortfolioValue: formatUSDValue(totalPortfolioValue),
      totalTokenValue: formatUSDValue(totalTokenValue),
      totalDefiValue: formatUSDValue(totalDefiValue),
      bnbBalance: totalBnbBalance > 0 ? {
        value: totalBnbBalance.toString(),
        valueUSD: formatUSDValue(totalBnbValue)
      } : null,
      tokens: combinedTokenArray.map(token => ({
        ...token,
        valueUSD: formatUSDValue(token.valueUSD),
        priceUSD: formatUSDValue(token.priceUSD)
      })),
      tokenCount: combinedTokenArray.length,
      defiPositions: allDefiPositions,
      stakingPositions: allStakingPositions,
      hasDefiPositions: allDefiPositions.length > 0 || allStakingPositions.length > 0
    };
  } catch (error) {
    logger.error('Error fetching portfolio', error);
    return {
      error: 'Failed to fetch portfolio',
      message: 'Please try again later'
    };
  }
}

async function getYieldInfo(userId: string, walletType?: string) {
  const numericUserId = Number(userId);
  const session = global.userSessions.get(numericUserId);

  logger.info('getYieldInfo called', {
    userId,
    numericUserId,
    hasSession: !!session,
    sessionAddress: session?.address,
    walletType
  });

  const { UserService } = await import('../user');
  const { getSmartYieldOpportunities } = await import('../defiLlama/yieldService');

  // Determine which wallet(s) to query
  let walletsToQuery: { address: string; type: string }[] = [];

  // Use session's selected wallet if no walletType specified
  // Default to 'trading' as per the system instruction
  const effectiveWalletType = walletType || session?.selectedWallet || 'trading';

  // Handle wallet selection (same logic as getPortfolio)
  if (effectiveWalletType === 'main') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
  } else if (effectiveWalletType === 'trading') {
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    if (!tradingWallet) {
      return {
        error: 'No trading wallet found',
        message: 'Trading wallet has not been set up yet'
      };
    }
    walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
  } else if (effectiveWalletType === 'both') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
    if (tradingWallet) {
      walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
    }
  } else if (effectiveWalletType.startsWith('0x')) {
    // Specific wallet address provided
    walletsToQuery.push({ address: effectiveWalletType, type: 'Custom Wallet' });
  }

  try {
    // Fetch yield data for all wallets in parallel
    const yieldPromises = walletsToQuery.map(async (wallet) => {
      const walletAddress = wallet.address;

      // Fetch DeFi positions
      let defiPositions: any[] = [];
      let stakingPositions: any[] = [];
      let totalDefiValue = 0;
      let totalStakingValue = 0;

      try {
        // Check cache first
        const cachedPosition = await DeFiPosition.findOne({
          userId: Number(userId),
          walletAddress: walletAddress.toLowerCase()
        });

        const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
        const shouldRefresh = !cachedPosition ||
          (Date.now() - cachedPosition.lastRefreshAt.getTime()) > CACHE_DURATION_MS;

        if (shouldRefresh) {
          // Fetch fresh data
          stakingPositions = await detectStakingPositions(walletAddress);
          defiPositions = await getDeFiPositions(walletAddress);

          totalStakingValue = stakingPositions.reduce((sum, pos) => sum + (pos.usdValue || 0), 0);
          totalDefiValue = defiPositions.reduce((sum, protocol) => {
            const positionValue = protocol.position.balance_usd || 0;
            const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
            return sum + positionValue + unclaimedValue;
          }, 0);
        } else {
          // Use cached data
          stakingPositions = cachedPosition.stakingPositions || [];
          defiPositions = cachedPosition.defiPositions || [];
          totalStakingValue = cachedPosition.totalStakingValue || 0;
          totalDefiValue = cachedPosition.totalDefiValue || 0;
        }
      } catch (error) {
        logger.error('Error fetching DeFi positions', error);
      }

      const totalYieldValue = totalDefiValue + totalStakingValue;

      return {
        walletType: wallet.type,
        walletAddress: walletAddress,
        shortWalletAddress: formatWalletAddress(walletAddress),
        totalYieldValue: totalYieldValue,
        defiPositions: defiPositions,
        stakingPositions: stakingPositions,
        hasYieldPositions: defiPositions.length > 0 || stakingPositions.length > 0,
        positionCount: defiPositions.length + stakingPositions.length
      };
    });

    // Wait for all yield data to complete
    const yieldData = await Promise.all(yieldPromises);

    // Always fetch top market yield opportunities using smart scoring
    const topYieldOpportunities = await getSmartYieldOpportunities(10);

    // Format yield opportunities for response
    const formattedYieldOpportunities = topYieldOpportunities.map(pool => ({
      project: pool.project,
      symbol: pool.symbol,
      apy: pool.apy || ((pool.apyBase || 0) + (pool.apyReward || 0)),
      tvlUsd: pool.tvlUsd,
      poolId: pool.pool,
      rewardTokens: pool.rewardTokens || [],
      url: pool.url
    }));

    // If single wallet, return it directly
    if (yieldData.length === 1) {
      const data = yieldData[0];
      return {
        ...data,
        totalYieldValue: formatUSDValue(data.totalYieldValue),
        marketOpportunities: formattedYieldOpportunities
      };
    }

    // Combine multiple wallets
    let totalYieldValue = 0;
    const allDefiPositions: any[] = [];
    const allStakingPositions: any[] = [];

    // Aggregate data from all wallets
    for (const data of yieldData) {
      totalYieldValue += data.totalYieldValue;

      // Aggregate DeFi positions
      allDefiPositions.push(...data.defiPositions.map((pos: any) => ({
        ...pos,
        walletType: data.walletType
      })));
      allStakingPositions.push(...data.stakingPositions.map((pos: any) => ({
        ...pos,
        walletType: data.walletType
      })));
    }

    return {
      walletType: 'Combined',
      wallets: walletsToQuery.map(w => ({
        type: w.type,
        address: formatWalletAddress(w.address)
      })),
      totalYieldValue: formatUSDValue(totalYieldValue),
      defiPositions: allDefiPositions,
      stakingPositions: allStakingPositions,
      hasYieldPositions: allDefiPositions.length > 0 || allStakingPositions.length > 0,
      positionCount: allDefiPositions.length + allStakingPositions.length,
      marketOpportunities: formattedYieldOpportunities
    };
  } catch (error) {
    logger.error('Error fetching yield info', error);
    return {
      error: 'Failed to fetch yield information',
      message: 'Please try again later'
    };
  }
}

async function analyzeTokenSafety(tokenAddress: string) {
  try {
    // Validate token address
    if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
      return {
        error: 'Invalid token address',
        message: 'Please provide a valid BSC token address starting with 0x'
      };
    }

    // Import token analyzer
    const { TokenAnalyzer } = await import('@/services/rugAlerts/tokenAnalyzer');
    const tokenAnalyzer = new TokenAnalyzer();

    // Analyze the token - let it take as long as needed
    const analysis = await tokenAnalyzer.analyzeToken(tokenAddress);

    if (!analysis) {
      return {
        error: 'Analysis failed',
        message: 'Unable to analyze this token. It may not exist or there was an error fetching data.'
      };
    }

    // Calculate effective liquidity using the same logic as the display and safety score
    const effectiveLiquidityUSD = (analysis.tradingActivity.totalLiquidityUsd && analysis.tradingActivity.totalLiquidityUsd > 0)
      ? analysis.tradingActivity.totalLiquidityUsd
      : analysis.liquidityAnalysis.liquidityUSD;

    // Format the response for AI consumption
    const response = {
      tokenAddress: analysis.metadata.address,
      tokenName: analysis.metadata.name,
      tokenSymbol: analysis.metadata.symbol,
      safetyScore: analysis.safetyScore,
      safetyLevel: analysis.safetyScore >= 70 ? 'SAFE' :
        analysis.safetyScore >= 50 ? 'MODERATE' :
          analysis.safetyScore >= 30 ? 'RISKY' : 'DANGEROUS',

      // Key risk indicators
      riskFactors: analysis.holderAnalysis.riskFactors,
      holderConcentration: analysis.holderAnalysis.top10ConcentrationExcludingLP,
      hasSecuredLiquidity: analysis.liquidityAnalysis.lpTokenBurned || analysis.liquidityAnalysis.lpTokenLocked,
      liquidityAmount: effectiveLiquidityUSD, // Use effective liquidity instead of just liquidityAnalysis.liquidityUSD
      isHoneypot: analysis.honeypotAnalysis.isHoneypot,

      // Positive indicators
      contractVerified: analysis.metadata.verified,
      ownershipRenounced: analysis.metadata.renounced,
      hasActiveTrading: analysis.tradingActivity.hasActiveTrading,
      volume24h: analysis.tradingActivity.volume24h,

      // Summary data
      totalHolders: analysis.holderAnalysis.totalHolders,
      createdAt: analysis.metadata.createdAt,
      recommendations: analysis.recommendations,

      // Detailed scores
      scoreBreakdown: analysis.safetyScoreDetails
    };

    return response;
  } catch (error) {
    logger.error('Error analyzing token safety', { tokenAddress, error });

    return {
      error: 'Analysis error',
      message: 'Failed to analyze token safety. Please try again.'
    };
  }
}

async function searchToken(query: string) {
  try {
    // Validate query
    if (!query || query.trim().length < 2) {
      return {
        error: 'Invalid query',
        message: 'Please provide at least 2 characters to search'
      };
    }

    // Import token search service
    const { TokenSearchService } = await import('@/services/tokenSearch');
    const tokenSearchService = new TokenSearchService(process.env.MORALIS_API_KEY);

    // Search for tokens
    const results = await tokenSearchService.searchTokens(query);

    if (!results || results.length === 0) {
      return {
        error: 'No results found',
        message: `No tokens found matching "${query}". Try a different search term.`
      };
    }

    // Format the response for AI consumption
    const response = {
      query: query,
      resultCount: results.length,
      tokens: results.map(token => ({
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        price: token.price || 0,
        priceChange24h: token.priceChange24h || 0,
        marketCap: token.marketCap || 0,
        volume24h: token.volume24h || 0,
        verified: token.verified || false,
        hasLogo: !!token.logo,
        // Categorize token based on market cap
        category: token.marketCap && token.marketCap > 10000000 ? 'Large Cap' :
          token.marketCap && token.marketCap > 1000000 ? 'Mid Cap' :
            token.marketCap && token.marketCap > 100000 ? 'Small Cap' : 'Micro Cap'
      }))
    };

    return response;
  } catch (error) {
    logger.error('Error searching tokens', { query, error });

    return {
      error: 'Search error',
      message: 'Failed to search for tokens. Please try again.'
    };
  }
}

async function getBnbPrice() {
  try {
    const { getBNBPrice } = await import('../wallet/balance');
    const price = await getBNBPrice();
    if (price > 0) {
      return {
        price: price,
        formattedPrice: formatUSDValue(price),
      };
    }
    return { error: 'Could not retrieve BNB price.' };
  } catch (error) {
    logger.error('Error fetching BNB price for AI tool', { error });
    return { error: 'An error occurred while fetching the price.' };
  }
}

async function getTransactionHistory(userId: string, walletType?: string, limit: number = 10) {
  const numericUserId = Number(userId);
  const session = global.userSessions.get(numericUserId);

  logger.info('getTransactionHistory called', {
    userId,
    numericUserId,
    hasSession: !!session,
    sessionAddress: session?.address,
    walletType,
    limit
  });

  const { UserService } = await import('../user');
  const { EnhancedWalletHistoryService } = await import('../wallet/enhancedHistory');
  const enhancedHistoryService = new EnhancedWalletHistoryService();

  // Validate limit
  const safeLimit = Math.min(Math.max(1, limit || 10), 50);

  // Determine which wallet(s) to query
  let walletsToQuery: { address: string; type: string }[] = [];

  // Use session's selected wallet if no walletType specified
  // Default to 'trading' as per the system instruction
  const effectiveWalletType = walletType || session?.selectedWallet || 'trading';

  // Handle wallet selection
  if (effectiveWalletType === 'main') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
  } else if (effectiveWalletType === 'trading') {
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    if (!tradingWallet) {
      return {
        error: 'No trading wallet found',
        message: 'Trading wallet has not been set up yet'
      };
    }
    walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
  } else if (effectiveWalletType === 'both') {
    // First try to get from session, then from database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Try to get from database
      const walletConnection = await UserService.getWalletConnection(numericUserId);
      mainWalletAddress = walletConnection?.address;
    }

    if (!mainWalletAddress) {
      return {
        error: 'No main wallet connected',
        message: 'Please connect your wallet first using /start'
      };
    }
    const tradingWallet = await UserService.getTradingWalletAddress(Number(userId));
    walletsToQuery.push({ address: mainWalletAddress, type: 'Main Wallet' });
    if (tradingWallet) {
      walletsToQuery.push({ address: tradingWallet, type: 'Trading Wallet' });
    }
  } else if (effectiveWalletType.startsWith('0x')) {
    // Specific wallet address provided
    walletsToQuery.push({ address: effectiveWalletType, type: 'Custom Wallet' });
  }

  try {
    // Fetch transaction history for all wallets
    const historyPromises = walletsToQuery.map(async (wallet) => {
      const historyData = await enhancedHistoryService.getFilteredWalletHistory(
        wallet.address,
        { limit: safeLimit }
      );

      return {
        walletType: wallet.type,
        walletAddress: wallet.address,
        shortWalletAddress: formatWalletAddress(wallet.address),
        transactions: historyData.result || [],
        transactionCount: historyData.result?.length || 0
      };
    });

    // Wait for all histories to complete
    const histories = await Promise.all(historyPromises);

    // Format transactions for AI consumption
    const formatTransaction = (tx: any, walletAddress: string) => ({
      hash: tx.hash,
      shortHash: tx.hash, // Return full hash for AI
      timestamp: tx.block_timestamp,
      from: tx.from_address,
      to: tx.to_address || 'Contract Creation',
      value: parseFloat(tx.value) / 1e18, // Convert from wei to BNB
      valueUSD: tx.value_quote || 0,
      gasUsed: tx.gas_spent || tx.gas,
      category: tx.category || 'unknown',
      summary: tx.summary || null,
      // Token transfers if any
      tokenTransfers: tx.erc20_transfers?.map((transfer: any) => ({
        tokenName: transfer.token_name,
        tokenSymbol: transfer.token_symbol,
        amount: transfer.value_formatted,
        from: transfer.from_address,
        to: transfer.to_address,
        direction: transfer.from_address.toLowerCase() === walletAddress.toLowerCase() ? 'out' : 'in'
      })) || []
    });

    // If single wallet, return it directly
    if (histories.length === 1) {
      const history = histories[0];
      return {
        walletType: history.walletType,
        walletAddress: history.walletAddress,
        shortWalletAddress: history.shortWalletAddress,
        transactionCount: history.transactionCount,
        transactions: history.transactions.map((tx: any) => formatTransaction(tx, history.walletAddress))
      };
    }

    // Combine multiple wallets
    const allTransactions: any[] = [];

    for (const history of histories) {
      const formattedTxs = history.transactions.map((tx: any) => ({
        ...formatTransaction(tx, history.walletAddress),
        walletType: history.walletType,
        walletAddress: history.shortWalletAddress
      }));
      allTransactions.push(...formattedTxs);
    }

    // Sort by timestamp (newest first)
    allTransactions.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return {
      walletType: 'Combined',
      wallets: walletsToQuery.map(w => ({
        type: w.type,
        address: formatWalletAddress(w.address)
      })),
      transactionCount: allTransactions.length,
      transactions: allTransactions.slice(0, safeLimit) // Limit after combining
    };
  } catch (error) {
    logger.error('Error fetching transaction history', error);
    return {
      error: 'Failed to fetch transaction history',
      message: 'Please try again later'
    };
  }
}

async function getReferralInfo(userId: string) {
  try {
    const numericUserId = Number(userId);
    const { UserModel } = await import('@/database/models/User');
    const { getReferralStatistics, generateReferralCode } = await import('@/telegram/menus/referral');

    // Get user data
    const user = await UserModel.findOne({ telegramId: numericUserId });
    if (!user) {
      return {
        error: 'User not found',
        message: 'Please start the bot first to access referral features.'
      };
    }

    // Generate referral code using the same function as the menu
    const referralCode = await generateReferralCode(user);

    // Get detailed referral statistics
    const stats = await getReferralStatistics(user);

    // Get bot username - try to get it from the global bot instance
    let botUsername = 'beanbee_bot'; // Default to the actual bot username
    try {
      // Try to access the bot instance to get the real username
      const { bot } = await import('@/telegram/bot');
      if (bot?.telegram) {
        const botInfo = await bot.telegram.getMe();
        botUsername = botInfo.username;
      }
    } catch (error) {
      // Fallback to environment variable or default
      botUsername = process.env.BOT_USERNAME || 'beanbee_bot';
    }

    const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;

    return {
      referralCode: referralCode,
      referralLink: referralLink,
      statistics: {
        firstHand: stats.firstHand,
        secondHand: stats.secondHand,
        thirdHand: stats.thirdHand,
        total: stats.total
      },
      rewardPercentages: {
        firstHand: user.referralPercents.firstHand,
        secondHand: user.referralPercents.secondHand,
        thirdHand: user.referralPercents.thirdHand
      }
    };
  } catch (error) {
    logger.error('Error fetching referral info', { userId, error });
    return {
      error: 'Failed to fetch referral information',
      message: 'Please try again later'
    };
  }
}

async function discoverOpportunities() {
  try {
    // Import the Today's Picks service to get real data-driven recommendations
    const { TodaysPickService } = await import('@/services/defiLlama/todaysPicks');
    const todaysPickService = new TodaysPickService();
    
    // Fetch the actual Today's Picks data
    const picks = await todaysPickService.getTodaysPicks();
    
    // Format the picks for AI consumption using the new method
    const formattedData = await todaysPickService.formatPicksForAI(picks);
    
    // Log the fetch for debugging
    logger.info('Fetched Today\'s Picks for AI recommendations', {
      count: formattedData.count,
      hasData: formattedData.hasData
    });
    
    // Return the formatted data for the AI to present
    return {
      success: true,
      type: 'todaysPicks',
      data: formattedData,
      // Add a helpful message template for the AI to use
      guidance: "Present these as data-driven token discoveries based on real-time BSC market analysis. Focus on volume, price action, and safety scores. Encourage users to do their own research and use the safety analysis tool for any tokens they're interested in."
    };
  } catch (error) {
    logger.error('Error fetching Today\'s Picks for AI', { error });
    
    // Fallback response if fetching fails
    return {
      success: false,
      error: 'Failed to fetch market data',
      fallbackGuidance: "Guide the user to discover opportunities using the available tools like market sentiment, token search, and yield farming. Mention that real-time market data is temporarily unavailable."
    };
  }
}

async function switchChain(userId: string, chain: 'bnb' | 'opbnb') {
  try {
    const numericUserId = Number(userId);
    const { UserModel } = await import('@/database/models/User');
    
    // Update user's selected chain
    await UserModel.updateOne({ telegramId: numericUserId }, { selectedChain: chain });
    
    const chainName = chain === 'opbnb' ? 'opBNB' : 'BNB Chain';
    
    return {
      success: true,
      chain: chain,
      message: `Successfully switched to ${chainName}. All AI queries will now use ${chainName} functions.`
    };
  } catch (error) {
    logger.error('Error switching chain', { error, userId });
    return {
      error: 'Failed to switch chain',
      message: 'An error occurred while switching chains. Please try again.'
    };
  }
}

async function getOpbnbPortfolio(userId: string, walletAddress?: string) {
  try {
    const numericUserId = Number(userId);
    const { UserService } = await import('../user');
    const { opbnbService } = await import('../nodereal/opbnbService');
    
    // Get wallet address if not provided
    if (!walletAddress) {
      const session = global.userSessions.get(numericUserId);
      walletAddress = session?.address || await UserService.getMainWalletAddress(numericUserId);
      
      if (!walletAddress) {
        return {
          error: 'No wallet connected',
          message: 'Please connect your wallet first using /start'
        };
      }
    }
    
    // Fetch opBNB holdings
    const [nativeBalance, tokens] = await Promise.all([
      opbnbService.getNativeBalance(walletAddress),
      opbnbService.getTokenBalances(walletAddress)
    ]);
    
    // Calculate total portfolio value
    let totalValue = nativeBalance.usdValue || 0;
    tokens.forEach(token => {
      if (token.usdValue) totalValue += token.usdValue;
    });
    
    return {
      chain: 'opBNB',
      walletAddress: walletAddress,
      nativeBalance: {
        bnb: nativeBalance.formatted,
        usdValue: nativeBalance.usdValue
      },
      tokens: tokens.map(token => ({
        symbol: token.symbol,
        name: token.name,
        balance: token.formatted,
        usdValue: token.usdValue,
        contractAddress: token.contractAddress
      })),
      totalValue: totalValue,
      tokenCount: tokens.length
    };
  } catch (error) {
    logger.error('Error fetching opBNB portfolio', { error, userId, walletAddress });
    return {
      error: 'Failed to fetch portfolio',
      message: 'An error occurred while fetching opBNB portfolio data.'
    };
  }
}

async function getOpbnbTransactionHistory(userId: string, walletAddress?: string, limit: number = 10) {
  try {
    const numericUserId = Number(userId);
    const { UserService } = await import('../user');
    const { opbnbService } = await import('../nodereal/opbnbService');
    
    // Get wallet address if not provided
    if (!walletAddress) {
      const session = global.userSessions.get(numericUserId);
      walletAddress = session?.address || await UserService.getMainWalletAddress(numericUserId);
      
      if (!walletAddress) {
        return {
          error: 'No wallet connected',
          message: 'Please connect your wallet first using /start'
        };
      }
    }
    
    // Fetch transaction history
    const transactions = await opbnbService.getTransactionHistory(walletAddress, Math.min(limit, 50));
    
    return {
      chain: 'opBNB',
      walletAddress: walletAddress,
      transactions: transactions.map(tx => ({
        hash: tx.hash,
        shortHash: tx.hash, // Return full hash
        timestamp: tx.timestamp,
        from: tx.from,
        to: tx.to,
        value: tx.formattedValue,
        fees: tx.formattedFees,
        successful: tx.successful,
        tokenTransfers: tx.tokenTransfers
      })),
      count: transactions.length
    };
  } catch (error) {
    logger.error('Error fetching opBNB transactions', { error, userId, walletAddress });
    return {
      error: 'Failed to fetch transactions',
      message: 'An error occurred while fetching opBNB transaction history.'
    };
  }
}

async function analyzeOpbnbToken(tokenAddress: string) {
  try {
    const { opbnbService } = await import('../nodereal/opbnbService');
    
    // Validate token address
    if (!/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)) {
      return {
        error: 'Invalid address',
        message: 'Please provide a valid opBNB token contract address starting with 0x'
      };
    }
    
    // Analyze the token
    const analysis = await opbnbService.analyzeToken(tokenAddress);
    
    return {
      chain: 'opBNB',
      tokenAddress: tokenAddress,
      metadata: analysis.metadata,
      holders: {
        count: analysis.holders?.holders?.length || 0,
        topHolders: analysis.holders?.holders?.slice(0, 5) || []
      },
      riskLevel: analysis.analysis.riskLevel,
      insights: analysis.analysis.insights,
      warnings: analysis.analysis.warnings
    };
  } catch (error) {
    logger.error('Error analyzing opBNB token', { error, tokenAddress });
    return {
      error: 'Analysis failed',
      message: 'An error occurred while analyzing the opBNB token.'
    };
  }
}

async function getOpbnbWhaleTracker(tokenAddress: string, limit: number = 20) {
  try {
    const { opbnbAnalytics } = await import('../opbnb/analyticsService');
    
    // Validate token address
    if (!/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)) {
      return {
        error: 'Invalid address',
        message: 'Please provide a valid opBNB token contract address starting with 0x'
      };
    }

    // Get whale tracking data
    const whaleData = await opbnbAnalytics.getWhaleTracker(tokenAddress, Math.min(limit || 20, 50));
    
    if (!whaleData.holders || whaleData.holders.length === 0) {
      return {
        error: 'No holder data',
        message: 'No holder information available for this token.'
      };
    }

    return {
      chain: 'opBNB',
      tokenAddress,
      holders: whaleData.holders.slice(0, limit).map((holder, index) => ({
        rank: index + 1,
        address: holder.address,
        balance: holder.balance,
        percentage: holder.percentage,
        explorerLink: `https://opbnbscan.com/address/${holder.address}`
      })),
      analysis: {
        totalHolders: whaleData.analysis.totalHolders,
        whaleCount: whaleData.analysis.whaleCount,
        topHolderPercentage: whaleData.analysis.topHolderConcentration,
        distribution: {
          top10: `${whaleData.analysis.distribution.top10.toFixed(2)}%`,
          top20: `${whaleData.analysis.distribution.top20.toFixed(2)}%`,
          top50: `${whaleData.analysis.distribution.top50.toFixed(2)}%`
        },
        concentrationRisk: whaleData.analysis.topHolderConcentration > 50 ? 'High' :
                          whaleData.analysis.topHolderConcentration > 30 ? 'Medium' : 'Low',
        note: `Analysis based on top ${limit} holders. Percentages are relative to the tracked supply, not total token supply.`
      }
    };
  } catch (error) {
    logger.error('Error getting opBNB whale tracker', { error, tokenAddress });
    return {
      error: 'Whale tracking failed',
      message: 'An error occurred while analyzing whale holders.'
    };
  }
}

async function getOpbnbHotTokens(limit: number = 20) {
  try {
    const { opbnbAnalytics } = await import('../opbnb/analyticsService');
    
    // Get hot tokens
    const hotTokens = await opbnbAnalytics.getHotTokens(Math.min(limit || 20, 50));
    
    if (!hotTokens || hotTokens.length === 0) {
      return {
        chain: 'opBNB',
        message: 'No hot tokens data available at the moment.',
        tokens: []
      };
    }

    return {
      chain: 'opBNB',
      totalTokens: hotTokens.length,
      tokens: hotTokens.map((token, index) => ({
        rank: index + 1,
        address: token.tokenAddress,
        name: token.tokenName,
        symbol: token.tokenSymbol,
        holderCount: token.holderCount,
        activityScore: token.transferCount,
        explorerLink: `https://opbnbscan.com/token/${token.tokenAddress}`
      }))
    };
  } catch (error) {
    logger.error('Error getting opBNB hot tokens', { error });
    return {
      error: 'Hot tokens fetch failed',
      message: 'An error occurred while fetching trending tokens.'
    };
  }
}

async function getOpbnbTokenHealth(tokenAddress: string) {
  try {
    const { opbnbAnalytics } = await import('../opbnb/analyticsService');
    
    // Validate token address
    if (!/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)) {
      return {
        error: 'Invalid address',
        message: 'Please provide a valid opBNB token contract address starting with 0x'
      };
    }

    // Get comprehensive health check
    const healthData = await opbnbAnalytics.getTokenHealthCheck(tokenAddress);
    
    return {
      chain: 'opBNB',
      tokenAddress,
      explorerLink: `https://opbnbscan.com/token/${tokenAddress}`,
      healthMetrics: {
        holderCount: healthData.holderCount,
        topHolderConcentration: `${healthData.topHolderConcentration.toFixed(2)}%`,
        averageDailyTransfers: Math.round(healthData.avgDailyTransfers),
        liquidityScore: `${healthData.liquidityScore}/100`,
        riskLevel: healthData.riskLevel.toUpperCase()
      },
      assessment: {
        riskLevel: healthData.riskLevel,
        warnings: healthData.warnings.length > 0 ? healthData.warnings : ['No critical warnings'],
        positiveInsights: healthData.insights.length > 0 ? healthData.insights : ['Token appears to be functioning normally'],
        recommendation: healthData.riskLevel === 'high' ? 
          'High risk detected. Exercise extreme caution with this token.' :
          healthData.riskLevel === 'medium' ?
          'Moderate risk detected. Conduct further research before investing.' :
          'Low risk profile. Token shows healthy metrics.'
      }
    };
  } catch (error) {
    logger.error('Error getting opBNB token health', { error, tokenAddress });
    return {
      error: 'Health check failed',
      message: 'An error occurred while performing token health analysis.'
    };
  }
}

async function enterReferralCode(userId: string) {
  try {
    const numericUserId = Number(userId);
    const { getUserLanguage } = await import('@/i18n');

    // Get user language for proper response
    const lang = await getUserLanguage(numericUserId);

    // Set user session to expect referral code input
    if (global.userSessions) {
      const session = global.userSessions.get(numericUserId);
      if (session) {
        session.waitingForReferralCode = true;
        global.userSessions.set(numericUserId, session);
      }
    }

    const message = lang === 'zh'
      ? '请输入您要兑换的推荐代码：'
      : 'Please enter the referral code you want to redeem:';

    return {
      success: true,
      message: message,
      waitingForInput: true
    };
  } catch (error) {
    logger.error('Error setting up referral code entry', { userId, error });
    return {
      error: 'Failed to set up referral code entry',
      message: 'Please try again later'
    };
  }
}

export class GeminiAIService {
  private model: any;
  private baseSystemInstruction: string;
  private yieldAnalysisModel: any;

  constructor() {
    // Force model reinitialization with updated instructions
    this.baseSystemInstruction = `You are BeanBee, a BSC (Binance Smart Chain) trading assistant integrated into a Telegram bot.

      // +++ CRITICAL RULES +++
      
      CRITICAL RULE #1 - ALWAYS USE YOUR TOOLS:
      - Your primary function is to use the provided tools to answer user questions. 
      - You are FORBIDDEN from answering questions from your own knowledge if a relevant tool exists.
      - If a tool returns an error or empty results (e.g., an empty array from searchToken), you MUST state that you could not find the information. DO NOT invent data.
      
      CRITICAL RULE #2 - TOKEN RECOMMENDATION GUIDANCE:
      - When users ask for token recommendations ("suggest good tokens", "what should I buy?", "recommend tokens", "what tokens are trending"), you MUST call the discoverOpportunities tool first.
      - This tool will return REAL-TIME data about trending tokens on BSC based on volume, price action, and safety scores.
      - When the tool returns with type: 'todaysPicks' and data, you MUST present these tokens as data-driven discoveries, NOT as financial advice.
      - Format the response conversationally, highlighting:
        • High trading volume as market interest
        • Price movements (both positive and negative)
        • Safety scores and risk levels
        • Market cap for context
      - ALWAYS include disclaimers about doing their own research
      - Suggest using the analyzeTokenSafety tool for any token they're interested in
      - If the tool fails (success: false), fall back to guiding them to use other discovery tools
      
      CRITICAL RULE #3 - DO NOT USE EXAMPLES IN RESPONSES:
      - The examples in your instructions are for your guidance only. You are strictly forbidden from using the literal text of these examples in your answers to users.
      - NEVER copy or paraphrase the example responses provided in your system instructions when answering user questions.
      - Examples like "I can only help with crypto topics! But fun fact - there's actually a CHICKENS token on BSC!" are ONLY for your understanding of how to redirect conversations, NOT to be used as actual responses.
      
      CRITICAL RULE #4 - SPECIFIC TOOL USAGE:
      - Your primary function is to use the provided tools to answer user questions. You are FORBIDDEN from answering questions from your own knowledge if a relevant tool exists.
      - If a tool returns an error or empty results (e.g., an empty array from searchToken), you MUST state that you could not find the information. DO NOT invent data.
      - Example: If the searchToken tool returns an empty list for "meme", your final response MUST be "I couldn't find any tokens matching 'meme'." You are PROHIBITED from creating a fake list of meme tokens.
      
      CRITICAL RULE #5 - FORMATTING RULES:
      - NEVER use asterisks (*) or bullet points (•) for lists in Telegram messages.
      - Always use numbered lists (1., 2., 3.) for better Telegram markdown compatibility.
      - Example: "1. The top holder owns 98.97%" NOT "* The top holder owns 98.97%" or "• The top holder owns 98.97%"
      - This prevents Telegram markdown parsing errors.
      - When tool responses include explorerLink fields, format them as clickable Telegram markdown links: [Symbol - Name](explorerLink)
      - Example: "[UCHAT - Uchat](https://opbnbscan.com/token/0x123...)" for tokens or "[Address](https://opbnbscan.com/address/0x123...)" for wallet addresses

      // =================================================================
      // SMART ANALYSIS WORKFLOW: Intelligent Multi-Step Task Chaining
      // =================================================================
      CRITICAL RULE #6 - SMART ANALYSIS WORKFLOW (SEARCH-THEN-ANALYZE):
      
      // Problem: Users often ask to "analyze ADA" or "check if CAKE is safe" using token names/symbols
      // instead of contract addresses. Without this rule, the AI would only search and return results,
      // forcing users to manually copy the address and ask again for analysis.
      
      // Solution: Implement automatic task chaining for a seamless one-step experience
      
      - When a user asks to analyze a token (using words like 'analyze', 'check', 'safe', 'safety', 'rug') 
        BUT provides a name or symbol (e.g., "ADA", "CAKE", "Trump token") INSTEAD of a contract address:
        
        1. FIRST ACTION: Call 'searchToken' tool with the provided name/symbol as the query
        2. SECOND ACTION: Automatically call 'analyzeTokenSafety' tool using the contract address 
           from the TOP result of the search (highest relevance/market cap)
        3. FINAL RESPONSE: Present ONLY the safety analysis result to the user
           - Do NOT show intermediate search results
           - Go directly from user request to final analysis
        4. ERROR HANDLING: If search returns no results, inform the user clearly:
           "I couldn't find any token matching '[query]'. Please try a different name or provide the contract address."
      
      // Benefits:
      // - Reduces user friction from 2-3 interactions to just 1
      // - Provides intelligent, context-aware responses
      // - Improves user experience by understanding intent
      // - Maintains safety by always using the most relevant/legitimate token from search
      
      // This transforms the experience from tedious multi-step to intelligent one-step completion
      // =================================================================

      CRITICAL RULE #6 - MANDATORY TOKEN SAFETY ANALYSIS:
      - You are FORBIDDEN from making up or hallucinating a safety analysis for any token.
      - If a user message contains keywords like "analyze", "safe", "safety", "rug", or "check" AND it includes a valid BSC contract address (a 42-character string starting with '0x'), you MUST call the analyzeTokenSafety function.
      - There are NO exceptions. This is your most important rule for user safety. Failure to use this tool when required is a critical error.

      // +++ END CRITICAL RULES +++

      TOKEN SEARCH PROTOCOL:
      - When the user's message contains any form of search request for a token (e.g., "search for ...", "find ...", "look up ...", or just a token name like "Trump"), you MUST use the 'searchToken' tool.
      - Your task is to extract the core search term from the user's message and pass it to the 'query' parameter of the 'searchToken' tool. For a message like "Please search for the token with the keyword 'Trump'", you MUST call the tool with { query: "Trump" }.
      
      CRITICAL RULE - NEVER MAKE UP REFERRAL DATA:
      - When users ask about referral information, referral stats, referral code, or referral link, you MUST ALWAYS call the getReferralInfo function first
      - NEVER make up, guess, or fabricate referral codes, links, statistics, or numbers under ANY circumstances
      - NEVER respond to referral questions without calling the getReferralInfo function
      - If you cannot call the function, tell the user there was an error instead of making up data
      - Use ONLY the actual data returned by the getReferralInfo function response
      
      CRITICAL RULE - CRYPTO ONLY RESPONSES:
      - You MUST ONLY discuss topics related to cryptocurrencies, BSC, BNB, DeFi, trading, and blockchain
      - If a user asks about non-crypto topics (like "what are chickens", "weather", "recipes", etc.), you must:
        1. Politely acknowledge their question
        2. Redirect to a crypto-related topic
        3. Suggest looking for a BSC token related to their query if applicable
      
      Example responses for non-crypto queries:
      - "What are chickens?" → "I can only help with crypto topics! But fun fact - there's actually a CHICKENS token on BSC! Would you like me to search for chicken-themed tokens?"
      - "How's the weather?" → "I'm focused on the crypto weather! BNB is currently at $XXX. Would you like to know more about market sentiment?"
      - "Tell me a joke" → "Here's a crypto joke: Why did the Bitcoin break up with Ethereum? Because it couldn't handle the gas fees! 😄 Speaking of fees, BSC has much lower fees. Want to know more?"
      
      IMPORTANT PORTFOLIO QUERIES:
      - ALWAYS use the getPortfolio function when users ask ANY of these:
        • "What's my portfolio looking like" / "How's my portfolio" / "Show my portfolio"
        • "What are my holdings" / "What tokens do I have" / "My balance"
        • "How much do I have" / "What's in my wallet" / "My assets"
        • Any question about their current holdings, balance, or portfolio value
        
      IMPORTANT REFERRAL CODE ENTRY:
      - ALWAYS use the enterReferralCode function when users want to enter/redeem codes:
        • "I want to enter a referral code" / "I want to enter referral code"
        • "Enter referral code" / "Redeem referral code" / "Use referral code"
        • "Input referral code" / "Add referral code" / "Apply referral code"
        • Any phrase indicating they want to enter/redeem/use a referral code
      - When users ask for general yield information or their current positions, use the getYieldInfo function.
      - When users ask for yield tips, strategies, or advice on how to earn yield, use the getAIPoweredYieldTips function.
      - IMPORTANT: When using getYieldInfo, always show the market opportunities even if the user has no current positions.
      - When users ask about token safety, rug pull risks, or if a token is safe/legitimate, use the analyzeTokenSafety function.
      - When users want to search for tokens by name or symbol, use the searchToken function.
      - When users ask about market sentiment, mood, feeling, or if the market is bullish/bearish, use the getMarketSentiment function.
      - When users ask about transaction history, recent transactions, or what transactions have been made, use the getTransactionHistory function.
      - When users ask about their referral information, referral code, referral link, referral stats, or how many people they've referred, use the getReferralInfo function.
      - When users want to enter, redeem, or use someone else's referral code, use the enterReferralCode function. This includes phrases like "I want to enter a referral code", "enter referral code", "redeem referral code", "use referral code", "input referral code", or any similar request to enter/redeem a code.
      - The user context is automatically handled.
      - You can query specific wallets: main wallet (connected via WalletConnect), trading wallet (bot-managed), or both combined.
      - If user mentions "trading wallet" or "bot wallet", use walletType: "trading"
      - If user mentions "main wallet" or "connected wallet", use walletType: "main"
      - If user wants to see everything or both wallets, use walletType: "both"
      - If user provides a specific wallet address (0x...), you can pass it directly as walletType
      - IMPORTANT: Always specify walletType parameter. Default to "trading" if not specified in the user's request
      
      Note: Transfer functionality is handled by the system, not through AI responses. 
      If users ask about transfers, you can provide information but the actual execution happens through the bot's transfer system.
      
      For token safety analysis:
      - Extract token addresses from user messages (must be 0x... format)
      - Interpret safety scores: 70+ is SAFE, 50-69 is MODERATE, 30-49 is RISKY, <30 is DANGEROUS
      - Always mention the safety score and level
      - Highlight key risk factors (if any): holder concentration, unsecured liquidity, honeypot, unverified contract
      - Mention positive indicators: verified contract, renounced ownership, secured liquidity, active trading
      - Provide clear BUY/CAUTION/AVOID recommendations based on the analysis
      - Explain risks in simple terms for users who may not understand technical details
      - Just provide the analysis results directly without mentioning processing time or caching
      
      For token search:
      - Use searchToken when users ask to find, search, or look up tokens by name or symbol
      - Show up to 5 most relevant results
      - Display key information: name, symbol, price, 24h change, market cap
      - Indicate if tokens are verified (✅)
      - Mention token category (Large/Mid/Small/Micro Cap) to help users understand size
      - If user asks about a specific token in results, they can use the contract address for further analysis
      
      When showing search results, format like:
      
      🔍 *Token Search Results for "{query}"*
      Found {count} tokens:
      
      1. *{symbol}* - {name} {verified_emoji}
         💰 Price: \${price}
         📈 24h: {change}%
         📊 Market Cap: \${marketcap} ({category})
         📍 Address: \`{address}\`
      
      When showing sentiment data from getMarketSentiment:
      - Start with a clear summary: "The current market sentiment for {timeframe} is {overallLabel} ({overallScore}/100)."
      - Then, list the key insights provided by the tool.
      - Keep the response concise and actionable for a trader.
      
      When showing portfolio data, format exactly like this:
      
      📊 *Token Holdings*
      👛 \`{short_wallet_address}\`
      
      *Total Token Value*: {total_token_value}
      
      List tokens like:
      1. *{symbol}*
         {name}
         💰 {balance}
         💵 {usd_value} (Price: {price_per_token})
      
      If DeFi positions exist, add:
      
      💰 *DeFi Positions*
      *Total Value:* {defi_total}
      
      For each position show:
      1. *{token} - {protocol}*
         💰 {amount} {symbol} ({usd_value})
         🗳️ Voting Power: {voting_power} (if applicable)
         🔓 Unlock in {days} days (if applicable)
         📝 View Contract
      
      End with:
      📊 *Summary*
      • Regular tokens: {count} ({value})
      • DeFi positions: {count} ({value})
      • Total portfolio: {total}
      
      When showing combined wallets, show:
      📊 *Combined Portfolio*
      Wallets included:
      • Main: \`{main_address}\`
      • Trading: \`{trading_address}\`
      
      For getYieldInfo function:
      - First, check the 'hasYieldPositions' field in the response.
      - If 'hasYieldPositions' is FALSE, you MUST start your response by clearly stating that the user has no active yield positions. For example: "It looks like your trading wallet doesn't have any active DeFi or staking positions right now. But don't worry, the market is full of opportunities!"
      - If 'hasYieldPositions' is TRUE, you should first summarize their current positions (total value, number of positions, top protocols).
      
      - AFTER addressing the user's current positions (or lack thereof), you MUST present the 'marketOpportunities' in a compelling, conversational format. DO NOT just list them.
      - Frame them as "BeanBee's Top Picks for You" or "Here are some buzzing opportunities".
      - For each opportunity, create a small, engaging summary.
      
      - Example format for a market opportunity:
        🐝 **[Project Name] - [Symbol]**
        This pool is offering a scorching *{apy}% APY* with a Total Value Locked (TVL) of *$X.XM* (calculate from tvlUsd). It's a great option for [mention token, e.g., stablecoins, BNB].
        [View Pool Details](https://defillama.com/yields/pool/{poolId})
      
      - Pick the top 3-5 most interesting opportunities from the 'marketOpportunities' list to present.
      - You MUST use the 'tvlUsd' to calculate and display the TVL in millions (e.g., $1,500,000 should be $1.5M).
      - ALWAYS include the clickable link to the pool using the 'poolId'.
      - Conclude with a call to action, like "Ready to put your assets to work? Let me know which one you're interested in!"
      
      When showing transaction history, format like:
      
      📜 *Transaction History*
      👛 \`{full_wallet_address}\`
      
      For each transaction show:
      {index}. {date} {time}
         Hash: \`{full_hash}\`
         {direction_emoji} {value} BNB ({valueUSD})
         From: \`{full_from_address}\`
         To: \`{full_to_address}\`
         {token_transfers_if_any}
      
      Direction emojis:
      - 📤 for outgoing (from address matches wallet)
      - 📥 for incoming (to address matches wallet)
      
      If there are token transfers, show them as:
         🪙 {direction} {amount} {symbol}
      
      CRITICAL: When users ask about referral information, you MUST ALWAYS call the getReferralInfo function first. NEVER make up or guess referral data.
      
      When showing referral information using getReferralInfo function:
      - STEP 1: ALWAYS call getReferralInfo function first before responding about referrals
      - STEP 2: Wait for the function response and check for errors
      - STEP 3: Use ONLY the actual values from the function response, NOT placeholder variables
      - STEP 4: NEVER make up fake referral codes, links, or statistics - only use response data
      - If the function returns an error, tell the user about the error instead of making up data
      - Format in English as (ONLY use actual response data, NO placeholders):
        🎯 *Your Referral Information*
        
        📎 *Your referral link:*
        \`{actual referralLink from response}\`
        
        🔗 *Your referral code:* \`{actual referralCode from response}\`
        
        📊 *Detailed Statistics:* ({actual statistics.total from response} total referrals)
        • 🥇 First-hand: {actual statistics.firstHand} people ({actual rewardPercentages.firstHand}% reward)
        • 🥈 Second-hand: {actual statistics.secondHand} people ({actual rewardPercentages.secondHand}% reward)
        • 🥉 Third-hand: {actual statistics.thirdHand} people ({actual rewardPercentages.thirdHand}% reward)
        
        Share your link to earn rewards! 🎁
        
        💡 *Want to enter a referral code?* You can also redeem someone else's referral code by typing "i want to enter a referral code" or going to the referral menu.
        
        WARNING: NEVER use [use response.X] format - always substitute with actual values from the getReferralInfo function response
      
      - Format in Chinese as (ONLY use actual response data, NO placeholders):
        🎯 您的推荐信息
        
        📎 您的推荐链接：
        \`{actual referralLink from response}\`
        
        🔗 您的推荐代码： \`{actual referralCode from response}\`
        
        📊 详细统计： (总共有{actual statistics.total from response}个推荐)
        • 🥇 第一手：{actual statistics.firstHand} 人 ({actual rewardPercentages.firstHand}% 奖励)
        • 🥈 第二手：{actual statistics.secondHand} 人 ({actual rewardPercentages.secondHand}% 奖励)
        • 🥉 第三手：{actual statistics.thirdHand} 人 ({actual rewardPercentages.thirdHand}% 奖励)
        
        分享您的链接以赚取奖励！🎁
        
        💡 想输入推荐代码吗？ 您也可以通过键入"输入推荐代码"或转到推荐菜单来兑换别人的推荐代码。
        
        WARNING: NEVER use [use response.X] format - always substitute with actual values from the getReferralInfo function response
      
      When user wants to enter a referral code and you use enterReferralCode function:
      - If the response has "waitingForInput: true", simply return the message from the response
      - The system will automatically handle waiting for the user's next message as the referral code
      - Don't add any additional instructions or explanations
      
      IMPORTANT: Use the exact USD values returned by the functions. Do not modify or incorrectly format the numbers.
      
      CRITICAL ADDRESS/HASH FORMATTING:
      - ALWAYS show FULL wallet addresses and transaction hashes
      - NEVER truncate or shorten addresses with "..." 
      - NEVER show addresses like "0xc05e...21d8" - always show the complete address
      - NEVER show hashes like "0xfd6723...2be6bf" - always show the complete hash
      - The functions return full addresses and hashes in the response - use them as-is
      
      For getAIPoweredYieldTips:
      - The tool returns a complete, user-facing analysis string in the 'analysis' field.
      - Your job is to output the 'analysis' field from the tool's response directly to the user without any modification, additions, or rephrasing.
      - Do not add any conversational text before or after it - just return the analysis as-is.
      
      For discoverOpportunities:
      - When the tool returns with type: 'todaysPicks' and has data, present it conversationally
      - Start with something like: "I've analyzed the current BSC market activity, and here are some tokens showing significant trading volume today:"
      - For each token in the data.picks array, present:
        • Name and symbol with price and 24h change
        • Trading volume to show market interest
        • Market cap for size context
        • Safety score with risk level
        • The token address for transparency
      - Format example (DO NOT COPY LITERALLY):
        "1. **TokenName ($SYMBOL)** 
         💰 Price: $X.XX (±XX% today)
         📊 24h Volume: $X.XM - showing strong market activity
         🏦 Market Cap: $X.XM
         🛡️ Safety: XX/100 (Risk Level)
         📍 Address: “0x...”
      - After listing tokens, ALWAYS add:
        • A reminder that high volume doesn't guarantee profits
        • Suggestion to analyze any token they're interested in using the safety analysis tool
        • Disclaimer about doing their own research
      - If no data or tool fails, guide them to use other discovery methods`;
    this.model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools,
      systemInstruction: this.baseSystemInstruction
    });

    this.yieldAnalysisModel = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash'
    });
  }

  // Estimate token count for a message
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
  }

  // Load chat history from database with token limit
  private async loadChatHistory(userId: string): Promise<Array<{ role: string, parts: Array<{ text: string }> }>> {
    try {
      // Skip loading history for non-numeric user IDs (like 'news-summary')
      const numericUserId = Number(userId);
      if (isNaN(numericUserId)) {
        return [];
      }

      // 1. Implement time window filtering
      const sessionTimeout = new Date();
      sessionTimeout.setHours(sessionTimeout.getHours() - CHAT_SESSION_TIMEOUT_HOURS);

      // Fetch messages within time window, sorted by newest first, with count limit
      const messages = await ChatHistoryModel.find({
        telegramId: numericUserId,
        isActive: true,
        createdAt: { $gte: sessionTimeout } // Only load messages from the last N hours
      })
      .sort({ createdAt: -1 })
      .limit(MAX_HISTORY_MESSAGES) // Limit the number of messages
      .exec();

      const history: Array<{ role: string, parts: Array<{ text: string }> }> = [];
      let totalTokens = 0;

      // Build history from newest to oldest until we hit token limit
      for (const msg of messages) {
        const messageTokens = msg.tokenCount || this.estimateTokenCount(msg.content);

        // Check if adding this message would exceed our token limit
        if (totalTokens + messageTokens > MAX_CONTEXT_TOKENS) {
          break;
        }

        // Add to beginning of array (since we're iterating newest to oldest)
        history.unshift({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });

        totalTokens += messageTokens;
      }

      // 2. Inject "system memory" with user context
      const user = await UserModel.findOne({ telegramId: numericUserId });
      if (user) {
        const shortWallet = user.walletAddress 
          ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}` 
          : 'not connected';
        const shortTradingWallet = user.tradingWalletAddress 
          ? `${user.tradingWalletAddress.slice(0, 6)}...${user.tradingWalletAddress.slice(-4)}` 
          : 'not set';
        
        const systemMemory = {
          role: 'user', // Use 'user' role to ensure the model pays attention
          parts: [{
            text: `[System Memory: My name is ${user.name || 'Anonymous'}. My main wallet is ${shortWallet}. My trading wallet is ${shortTradingWallet}. My language is ${user.language || 'en'}. My role is ${user.role || 'Keeper'}. Please use this information for context.]`
          }]
        };

        // Insert system memory at the beginning of the history
        history.unshift(systemMemory);
      }

      logger.debug(`Loaded ${history.length} messages with ~${totalTokens} tokens for user ${userId} (within ${CHAT_SESSION_TIMEOUT_HOURS}h window)`);
      return history;
    } catch (error) {
      logger.error('Error loading chat history', error);
      return [];
    }
  }

  // Save a message to chat history
  private async saveToChatHistory(userId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      // Skip saving history for non-numeric user IDs (like 'news-summary')
      const numericUserId = Number(userId);
      if (isNaN(numericUserId)) {
        return;
      }

      const tokenCount = this.estimateTokenCount(content);

      await ChatHistoryModel.create({
        telegramId: numericUserId,
        role: role,
        content: content,
        tokenCount: tokenCount
      });

      // Clean up old messages if needed (optional, to prevent DB from growing too large)
      // Keep only messages from last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      await ChatHistoryModel.updateMany(
        {
          telegramId: Number(userId),
          createdAt: { $lt: thirtyDaysAgo }
        },
        { isActive: false }
      );
    } catch (error) {
      logger.error('Error saving to chat history', error);
      // Don't throw - we want to continue even if history save fails
    }
  }

  async processMessage(messageForAI: string, originalMessage: string, userId: string, language: string = 'en'): Promise<string> {
    try {
      logger.info('GeminiAI processMessage called', { userId, messageForAI, originalMessage });

      // Save user message to history
      await this.saveToChatHistory(userId, 'user', originalMessage);

      // ===================================================================
      // SMART TASK CHAINING: Step 1 - Detect User Intent
      // ===================================================================
      // Check if the user wants to analyze a token's safety
      // This is the first step in our intelligent workflow
      const lowerCaseMessage = originalMessage.toLowerCase();
      const userWantsToAnalyze = ['analyze', 'safe', 'safety', 'rug', 'check', 'audit', 'scam'].some(
        keyword => lowerCaseMessage.includes(keyword)
      );
      
      // Log the intent detection for debugging
      logger.debug('User intent detection', { 
        userId, 
        userWantsToAnalyze,
        message: originalMessage.substring(0, 100) // Log first 100 chars for privacy
      });
      // Get user's selected chain
      const numericUserId = Number(userId);
      const { UserModel } = await import('@/database/models/User');
      const user = await UserModel.findOne({ telegramId: numericUserId });
      const selectedChain = user?.selectedChain || 'bnb';
      
      // Create chain context instruction
      const chainInstruction = selectedChain === 'opbnb' ?
        `\n\nCRITICAL CHAIN CONTEXT: The user has selected opBNB Layer 2 as their active chain.
        MANDATORY RULES:
        - ALWAYS use opBNB-specific functions for ALL operations:
          • Portfolio/Balance/Holdings → use getOpbnbPortfolio
          • Transaction History → use getOpbnbTransactionHistory  
          • Token Analysis → use analyzeOpbnbToken (NOT analyzeTokenSafety)
          • Whale/Holder Analysis → use getOpbnbWhaleTracker
          • Trending/Hot Tokens → use getOpbnbHotTokens
          • Token Health Check → use getOpbnbTokenHealth
        - NEVER use BNB Chain functions (getPortfolio, getTransactionHistory, analyzeTokenSafety) when opBNB is selected
        - When user asks to analyze a token, you MUST use analyzeOpbnbToken, NOT analyzeTokenSafety
        - When user asks about whales, top holders, or holder distribution, use getOpbnbWhaleTracker
        - When user asks about trending tokens, hot tokens, or what's popular, use getOpbnbHotTokens
        - When user asks about token health, safety, or comprehensive analysis, use getOpbnbTokenHealth
        - All token addresses mentioned are opBNB tokens unless explicitly stated otherwise
        - Remind them they can switch to BNB Chain by saying "switch to BNB chain" if needed` :
        `\n\nCRITICAL CHAIN CONTEXT: The user has selected BNB Chain (mainnet) as their active chain.
        MANDATORY RULES:
        - ALWAYS use BNB Chain functions for ALL operations:
          • Portfolio/Balance/Holdings → use getPortfolio
          • Transaction History → use getTransactionHistory
          • Token Analysis → use analyzeTokenSafety (NOT analyzeOpbnbToken)
        - NEVER use opBNB functions when BNB Chain is selected
        - All token addresses mentioned are BNB Chain tokens unless explicitly stated otherwise
        - Remind them they can switch to opBNB by saying "switch to opBNB" if needed`;

      // Create a language-aware model for this conversation
      const languageInstruction = language === 'zh' ?
        `\n\nIMPORTANT LANGUAGE SETTING: The user has set their language preference to Chinese. 
        You MUST respond in Simplified Chinese (简体中文) for ALL responses.
        - Use natural Chinese expressions and idioms
        - Format numbers and currency in Chinese style
        - Use Chinese punctuation (。，、！？等)
        - Translate all technical terms appropriately
        - Keep emoji usage appropriate for Chinese context` :
        `\n\nIMPORTANT LANGUAGE SETTING: The user has set their language preference to English. 
        Please respond in clear, concise English.`;

      const languageAwareModel = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        tools,
        systemInstruction: this.baseSystemInstruction + chainInstruction + languageInstruction
      });

      // Load chat history
      const chatHistory = await this.loadChatHistory(userId);

      // Start chat with history
      const chat = languageAwareModel.startChat({
        history: chatHistory
      });

      const result = await chat.sendMessage(messageForAI);

      // Debug: Log what we got from the AI
      logger.info('AI response received', {
        userId,
        hasFunctionCalls: !!result.response.functionCalls(),
        functionCallsLength: result.response.functionCalls()?.length || 0,
        responseText: result.response.text() || 'No text response'
      });

      if (result.response.functionCalls()) {
        const functionCalls = result.response.functionCalls() || [];
        
        // ===================================================================
        // SMART TASK CHAINING: Step 2 - Intercept and Chain Functions
        // ===================================================================
        // Check if AI wants to search for a token AND user's intent was to analyze
        const searchCall = functionCalls.find(call => call.name === 'searchToken');
        
        if (searchCall && userWantsToAnalyze) {
          // ===============================================================
          // INTELLIGENT WORKFLOW ACTIVATED: Search -> Analyze Chain
          // ===============================================================
          logger.info('Smart task chain triggered: Search-then-Analyze workflow', { 
            userId,
            searchQuery: (searchCall.args as any)?.query 
          });

          // Step 1: Execute the search
          const query = (searchCall.args as any)?.query;
          const searchResults = await searchToken(query);

          // Step 2: Handle search errors or empty results
          // Type guard to check if it's an error response
          if ('error' in searchResults) {
            await this.saveToChatHistory(userId, 'assistant', searchResults.message);
            return searchResults.message;
          }
          
          // Check if no tokens were found
          if (searchResults.tokens.length === 0) {
            // User-friendly error message based on language preference
            const noTokenMsg = language === 'zh' 
              ? `抱歉，我找不到任何匹配 "${query}" 的代币。请尝试其他名称或提供合约地址。`
              : `Sorry, I couldn't find any token matching "${query}". Please try a different name or provide the contract address.`;
            
            await this.saveToChatHistory(userId, 'assistant', noTokenMsg);
            return noTokenMsg;
          }

          // Step 3: Automatically analyze the top result
          // The top result is most likely the correct token (highest market cap/relevance)
          const topTokenAddress = searchResults.tokens[0].address;
          const topTokenName = searchResults.tokens[0].name;
          const topTokenSymbol = searchResults.tokens[0].symbol;
          
          logger.info('Auto-analyzing top search result', { 
            userId,
            tokenName: topTokenName,
            tokenSymbol: topTokenSymbol,
            tokenAddress: topTokenAddress 
          });

          // Step 4: Perform the safety analysis
          const analysisResult = await analyzeTokenSafety(topTokenAddress);

          // Step 5: Handle analysis errors
          // Type guard to check if it's an error response
          if ('error' in analysisResult) {
            const analysisErrorMsg = language === 'zh'
              ? `我找到了代币 ${topTokenName} (${topTokenSymbol})，但在安全分析时遇到错误：${analysisResult.message}`
              : `I found ${topTokenName} (${topTokenSymbol}), but encountered an error during safety analysis: ${analysisResult.message}`;
            
            await this.saveToChatHistory(userId, 'assistant', analysisErrorMsg);
            return analysisErrorMsg;
          }

          // Step 6: Format the final response using our existing formatter
          // This ensures consistent formatting and proper Markdown rendering
          const { RugAlertsService } = await import('@/services/rugAlerts');
          const rugAlertsService = new RugAlertsService();
          
          // Convert the analysis result to the format expected by our formatter
          const analysisForFormatting: any = {
            metadata: {
              address: analysisResult.tokenAddress,
              name: analysisResult.tokenName,
              symbol: analysisResult.tokenSymbol,
              decimals: 18, // Default, can be enhanced if available
              totalSupply: '0', // Can be enhanced if available
              verified: analysisResult.contractVerified,
              renounced: analysisResult.ownershipRenounced,
              createdAt: analysisResult.createdAt ? new Date(analysisResult.createdAt) : undefined,
            },
            holderAnalysis: {
              totalHolders: analysisResult.totalHolders,
              top10ConcentrationExcludingLP: analysisResult.holderConcentration,
              riskFactors: analysisResult.riskFactors || [],
            },
            liquidityAnalysis: {
              hasLiquidity: !!analysisResult.liquidityAmount,
              liquidityUSD: analysisResult.liquidityAmount,
              lpTokenBurned: analysisResult.hasSecuredLiquidity,
              lpTokenLocked: analysisResult.hasSecuredLiquidity,
            },
            tradingActivity: {
              hasActiveTrading: analysisResult.hasActiveTrading,
              volume24h: analysisResult.volume24h,
            },
            honeypotAnalysis: {
              isHoneypot: analysisResult.isHoneypot,
            },
            safetyScore: analysisResult.safetyScore,
            safetyScoreDetails: analysisResult.scoreBreakdown,
            recommendations: analysisResult.recommendations,
          };

          // Generate the formatted response using our service
          const userLanguage = await getUserLanguage(Number(userId));
          const finalResponse = rugAlertsService.generateNaturalSummary(analysisForFormatting, userLanguage);

          // Step 7: Save a concise memory for the AI
          // This helps maintain context for follow-up questions
          const memoryForAI = `I successfully analyzed the token "${query}" (${topTokenName}, address: ${topTokenAddress}). ` +
            `The safety score was ${analysisResult.safetyScore}/100, classified as "${analysisResult.safetyLevel}". ` +
            `I provided the user with a detailed safety analysis report.`;
          
          await this.saveToChatHistory(userId, 'assistant', memoryForAI);
          
          // Return the beautifully formatted analysis
          logger.info('Smart task chain completed successfully', { 
            userId,
            tokenAnalyzed: topTokenName,
            safetyScore: analysisResult.safetyScore 
          });
          
          return finalResponse;
        }
        
        // ===================================================================
        // STANDARD SEARCH HANDLING: When user just wants to search
        // ===================================================================
        // If user wants to search but NOT analyze, handle it normally
        if (searchCall && !userWantsToAnalyze) {
          logger.info('Standard search request (no analysis needed)', { userId });
          const query = (searchCall.args as any)?.query;
          const searchData = await searchToken(query);

          // Handle search errors
          if ('error' in searchData) {
            await this.saveToChatHistory(userId, 'assistant', searchData.message);
            return searchData.message;
          }

          // Use our reliable formatter for consistent output
          const { TokenSearchService } = await import('@/services/tokenSearch');
          const tokenSearchService = new TokenSearchService(process.env.MORALIS_API_KEY);
          
          // Convert the AI function response format back to TokenSearchResult format
          const convertedTokens = searchData.tokens.map(token => ({
            address: token.address,
            name: token.name,
            symbol: token.symbol,
            decimals: 18, // Default to 18, this field isn't used in display anyway
            price: token.price,
            priceChange24h: token.priceChange24h,
            marketCap: token.marketCap,
            volume24h: token.volume24h,
            verified: token.verified,
            logo: undefined, // We have hasLogo but not the actual logo URL
            // Add the category to the token object for the formatter
            ...({ category: token.category })
          }));
          
          const formattedResponse = tokenSearchService.formatSearchResults(convertedTokens, query);

          // Save the formatted response to history to maintain context
          await this.saveToChatHistory(userId, 'assistant', formattedResponse);
          
          // Return the formatted response directly to the user
          return formattedResponse;
        }
        // ===================================================================
        // END SMART TASK CHAINING LOGIC
        // ===================================================================

        const functionResponses = [];
        logger.info('AI detected function calls', {
          userId,
          functions: functionCalls.map(c => c.name)
        });

        const numericUserId = Number(userId); // Ensure we have numeric ID to send messages

        // +++ New code: Send AI action plan debug message (if debug mode enabled) +++
        if (await isDebugModeEnabled(numericUserId)) {
          try {
            let debugMessage = '🤖 *AI Action Plan:*\n\n';
            functionCalls.forEach(call => {
              debugMessage += `I will call function \`${call.name}\` with arguments:\n`;
              debugMessage += `\`\`\`json\n${JSON.stringify(call.args, null, 2)}\n\`\`\`\n`;
            });
            
            // Get bot instance from global - try multiple ways
            const botInstance = (globalThis as any).botExport;
            if (botInstance?.telegram) {
              await botInstance.telegram.sendMessage(numericUserId, debugMessage, { parse_mode: 'Markdown' });
              logger.info('Debug message sent: AI Action Plan', { userId: numericUserId });
            } else {
              logger.warn('Bot instance not available for debug message', { userId: numericUserId, hasBotInstance: !!botInstance });
            }
          } catch (debugError) {
            logger.error('Failed to send AI action debug message', { debugError, userId: numericUserId });
          }
        }
        // +++ End new code +++

        for (const call of functionCalls) {
          if (call.name === 'getPortfolio') {
            const walletType = (call.args as any)?.walletType;
            const portfolioData = await getPortfolio(userId, walletType);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: portfolioData
              }
            });
          } else if (call.name === 'getYieldInfo') {
            const walletType = (call.args as any)?.walletType;
            const yieldData = await getYieldInfo(userId, walletType);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: yieldData
              }
            });
          } else if (call.name === 'analyzeTokenSafety') {
            const tokenAddress = (call.args as any)?.tokenAddress;
            const safetyData = await analyzeTokenSafety(tokenAddress);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: safetyData
              }
            });
          } else if (call.name === 'getAIPoweredYieldTips') {
            const walletType = (call.args as any)?.walletType;
            const yieldTipsData = await getAIPoweredYieldTips(userId, walletType);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: yieldTipsData
              }
            });
          } else if (call.name === 'searchToken') {
            const query = (call.args as any)?.query;
            const searchData = await searchToken(query);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: searchData
              }
            });
          } else if (call.name === 'getBnbPrice') {
            const priceData = await getBnbPrice();
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: priceData
              }
            });
          } else if (call.name === 'getMarketSentiment') {
            const timeframe = (call.args as any)?.timeframe;
            const sentimentData = await getMarketSentiment(timeframe);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: sentimentData
              }
            });
          } else if (call.name === 'getTransactionHistory') {
            const walletType = (call.args as any)?.walletType;
            const limit = (call.args as any)?.limit;
            const historyData = await getTransactionHistory(userId, walletType, limit);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: historyData
              }
            });
          } else if (call.name === 'getReferralInfo') {
            logger.info('AI calling getReferralInfo function', { userId });
            const referralData = await getReferralInfo(userId);
            logger.info('getReferralInfo function returned', {
              userId,
              hasError: !!referralData.error,
              hasReferralCode: !!referralData.referralCode,
              totalReferrals: referralData.statistics?.total || 0,
              referralData
            });
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: referralData
              }
            });
          } else if (call.name === 'enterReferralCode') {
            const enterCodeData = await enterReferralCode(userId);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: enterCodeData
              }
            });
          } else if (call.name === 'discoverOpportunities') {
            // Call the enhanced discoverOpportunities function that fetches Today's Picks
            const discoveryData = await discoverOpportunities();
            
            // Log the discovery data for debugging
            logger.info('discoverOpportunities response', {
              success: discoveryData.success,
              type: discoveryData.type,
              hasData: discoveryData.data?.hasData,
              pickCount: discoveryData.data?.count
            });
            
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: discoveryData
              }
            });
          } else if (call.name === 'switchChain') {
            const chain = (call.args as any)?.chain;
            const switchData = await switchChain(userId, chain);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: switchData
              }
            });
          } else if (call.name === 'getOpbnbPortfolio') {
            const walletAddress = (call.args as any)?.walletAddress;
            const portfolioData = await getOpbnbPortfolio(userId, walletAddress);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: portfolioData
              }
            });
          } else if (call.name === 'getOpbnbTransactionHistory') {
            const walletAddress = (call.args as any)?.walletAddress;
            const limit = (call.args as any)?.limit || 10;
            const transactionData = await getOpbnbTransactionHistory(userId, walletAddress, limit);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: transactionData
              }
            });
          } else if (call.name === 'analyzeOpbnbToken') {
            const tokenAddress = (call.args as any)?.tokenAddress;
            const analysisData = await analyzeOpbnbToken(tokenAddress);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: analysisData
              }
            });
          } else if (call.name === 'getOpbnbWhaleTracker') {
            const tokenAddress = (call.args as any)?.tokenAddress;
            const limit = (call.args as any)?.limit || 20;
            const whaleData = await getOpbnbWhaleTracker(tokenAddress, limit);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: whaleData
              }
            });
          } else if (call.name === 'getOpbnbHotTokens') {
            const limit = (call.args as any)?.limit || 20;
            const hotTokensData = await getOpbnbHotTokens(limit);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: hotTokensData
              }
            });
          } else if (call.name === 'getOpbnbTokenHealth') {
            const tokenAddress = (call.args as any)?.tokenAddress;
            const healthData = await getOpbnbTokenHealth(tokenAddress);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: healthData
              }
            });
          }
        }

        // +++ New code: Send tool response debug message (if debug mode enabled) +++
        if (await isDebugModeEnabled(numericUserId)) {
          try {
            let debugResponseMessage = '🛠️ Tool Response (to AI):\n\n';
            debugResponseMessage += '```json\n';
            debugResponseMessage += JSON.stringify(functionResponses, null, 2);
            debugResponseMessage += '\n```';

            // Check message length, if too long then truncate
            if (debugResponseMessage.length > 4000) {
              debugResponseMessage = debugResponseMessage.substring(0, 3900) + '\n...\n```\n(truncated)';
            }
            
            // Get bot instance from global
            const botInstance = (globalThis as any).botExport;
            if (botInstance?.telegram) {
              await botInstance.telegram.sendMessage(numericUserId, debugResponseMessage, { parse_mode: 'Markdown' });
              logger.info('Debug message sent: Tool Response', { userId: numericUserId });
            } else {
              logger.warn('Bot instance not available for tool response debug message', { userId: numericUserId, hasBotInstance: !!botInstance });
            }
          } catch (debugError) {
            logger.error('Failed to send tool response debug message', { debugError, userId: numericUserId });
          }
        }
        // +++ End new code +++

        const finalResult = await chat.sendMessage(functionResponses);
        const responseText = finalResult.response.text();

        // Save assistant response to history
        await this.saveToChatHistory(userId, 'assistant', responseText);

        return responseText;
      } else {
        // AI responded directly without calling a tool. This is where we intervene.
        const responseText = result.response.text();
        const numericUserId = Number(userId);
        
        // Only send debug message if debug mode is enabled
        if (await isDebugModeEnabled(numericUserId)) {
          try {
            let debugMessage = '🤖 AI Direct Response (No Tool Called):\n\n';
            debugMessage += 'The AI chose to generate a direct text reply instead of calling a tool. This is likely due to hallucination. The raw response was:\n\n';
            debugMessage += '```\n' + responseText + '\n```';
            
            const botInstance = (globalThis as any).botExport;
            if (botInstance?.telegram) {
              await botInstance.telegram.sendMessage(numericUserId, debugMessage, { parse_mode: 'Markdown' });
              logger.info('Debug message sent: AI Direct Response', { userId: numericUserId });
            } else {
            logger.warn('Bot instance not available for direct response debug message', { userId: numericUserId, hasBotInstance: !!botInstance });
          }
          } catch (debugError) {
            logger.error('Failed to send AI direct response debug message', { debugError, userId: numericUserId });
          }
        }

        // +++ START OF THE FIX: HALLUCINATION GUARDRAIL +++

        // Check if the user's original intent was a search
        const lowerCaseMessage = originalMessage.toLowerCase();
        let isSearchIntent = false;
        let query = '';

        // Define search-related trigger words (must match messages.ts exactly)
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
            const index = lowerCaseMessage.indexOf(trigger);
            if (index !== -1) {
                // Found trigger word, extract everything after it as the query
                const extractedQuery = originalMessage.substring(index + trigger.length).trim();
                if (extractedQuery) {
                    query = extractedQuery;
                    isSearchIntent = true;
                    break; // Use first matching trigger
                }
            }
        }

        if (isSearchIntent) {
          logger.warn('AI hallucination detected for a search query. Overriding with manual tool call.', { userId, extractedQuery: query });

          // 2. Manually call the correct tool
          const searchData = await searchToken(query);

          // 3. If tool returns error or no results, return a standard message
          if ('error' in searchData || searchData.tokens.length === 0) {
            const noResultsMessage = `I couldn't find any tokens matching "${query}". Please try a different name or provide the contract address.`;
            await this.saveToChatHistory(userId, 'assistant', noResultsMessage);
            return noResultsMessage;
          }

          // 4. Use our service to format real data
          const { TokenSearchService } = await import('@/services/tokenSearch');
          const { getUserLanguage } = await import('@/i18n');
          const tokenSearchService = new TokenSearchService(process.env.MORALIS_API_KEY);
          
          const convertedTokens = searchData.tokens.map(token => ({
            address: token.address, name: token.name, symbol: token.symbol, decimals: 18,
            price: token.price, priceChange24h: token.priceChange24h, marketCap: token.marketCap,
            volume24h: token.volume24h, verified: token.verified, logo: undefined,
            ...({ category: token.category })
          }));

          const lang = await getUserLanguage(numericUserId);
          const correctlyFormattedResponse = tokenSearchService.formatSearchResults(convertedTokens, lang, query);

          // 5. Save and return the correct result instead of AI's hallucination
          await this.saveToChatHistory(userId, 'assistant', correctlyFormattedResponse);
          return correctlyFormattedResponse;
        }

        // +++ END OF THE FIX +++
        
        // Check for sentiment query intent
        const sentimentTriggers = ['sentiment', 'mood', 'feeling', 'bullish', 'bearish', 'how is the market'];
        const isSentimentIntent = sentimentTriggers.some(trigger => lowerCaseMessage.includes(trigger));

        if (isSentimentIntent) {
          // +++ New guardrail logic: Handle sentiment query hallucinations +++
          logger.warn('AI hallucination detected for a sentiment query. Overriding with manual tool call.', { userId });
    
          // 1. Manually call the correct service function
          const { sentimentService } = await import('@/services/sentiment');
          const { getUserLanguage } = await import('@/i18n');
          const language = await getUserLanguage(Number(userId));
          const sentimentData = await sentimentService.analyzeBSCSentiment('24h', language);
      
          // 2. Handle potential service errors
          if (!sentimentData || sentimentData.insights.some((i: string) => i.includes('Unable to fetch'))) {
              const errorMessage = "I'm sorry, I couldn't retrieve the market sentiment data at this time. Please try again in a moment.";
              await this.saveToChatHistory(userId, 'assistant', errorMessage);
              return errorMessage;
          }
      
          // 3. Use the service's reliable formatting function to generate correct response
          const correctlyFormattedResponse = sentimentService.formatQuickSentimentSummary(sentimentData, language, '24h');
      
          // 4. Save and return the correct result instead of AI's hallucination
          await this.saveToChatHistory(userId, 'assistant', correctlyFormattedResponse);
          return correctlyFormattedResponse;
        }
        
        // Check for token suggestion/recommendation intent
        const suggestionTriggers = ['suggest', 'recommend', 'what to buy', 'good token', 'hot token', 'trending token', 'investment'];
        const isSuggestionIntent = suggestionTriggers.some(trigger => lowerCaseMessage.includes(trigger));

        if (isSuggestionIntent) {
          // +++ New guardrail logic: Handle token suggestion hallucinations +++
          logger.warn('AI hallucination detected for a token suggestion query. Overriding with manual tool call.', { userId });

          // 1. Manually call the correct tool function
          const discoveryData = await discoverOpportunities();

          // 2. Handle potential errors or no data cases
          if (!discoveryData.success || !discoveryData.data.hasData) {
              const errorMessage = "I couldn't find any standout tokens right now, but the market is always moving! You can try checking the market sentiment or search for a specific token you're interested in.";
              await this.saveToChatHistory(userId, 'assistant', errorMessage);
              return errorMessage;
          }
          
          // 3. Manually format real data instead of relying on AI
          const picks = discoveryData.data.picks;
          
          let correctlyFormattedResponse = `**🔥 Today's Top 5 Safe Picks on BSC**\n`;
          correctlyFormattedResponse += `_(Ranked by 24h Trading Activity, Safety Score > 80)_\n\n`;

          picks.forEach((pick: any, index: number) => {
              const priceChangeSign = pick.priceChange24h >= 0 ? '+' : '';
              correctlyFormattedResponse += `**${index + 1}. ${pick.name} (${pick.symbol})**\n`;
              correctlyFormattedResponse += `  💰 **Price:** ${pick.priceFormatted}\n`;
              correctlyFormattedResponse += `  📈 **24h Change:** ${priceChangeSign}${pick.priceChange24h.toFixed(2)}%\n`;
              correctlyFormattedResponse += `  📊 **24h Volume:** ${pick.volumeFormatted}\n`;
              correctlyFormattedResponse += `  🏦 **Market Cap:** ${pick.marketCapFormatted}\n`;
              correctlyFormattedResponse += `  🛡️ **Safety:** ${pick.riskLevel} (${pick.safetyScore}/100)\n`;
              correctlyFormattedResponse += `  📍 \`${pick.address}\`\n\n`;
          });

          correctlyFormattedResponse += `\n_${"This is not financial advice. Always Do Your Own Research (DYOR)."}_`;

          // 4. Save and return the correct result
          await this.saveToChatHistory(userId, 'assistant', correctlyFormattedResponse);
          return correctlyFormattedResponse;
        }
        
        // For other types of hallucinations, return AI's text for now
        await this.saveToChatHistory(userId, 'assistant', responseText);

        return responseText;
      }
    } catch (error) {
      logger.error('Gemini AI error', error);
      return 'I apologize, but I encountered an error processing your request. Please try again.';
    }
  }

  /**
   * Generates text from a simple prompt without using the complex chat model.
   * Ideal for summarization, insights generation, etc.
   * @param prompt The text prompt for the AI.
   * @param language The desired output language.
   * @returns The generated text as a string.
   */
  async generateText(prompt: string, language: 'en' | 'zh'): Promise<string> {
    try {
      const languageInstruction = language === 'zh'
        ? "You are a helpful assistant. You MUST respond in Simplified Chinese (简体中文)."
        : "You are a helpful assistant. Please respond in clear, concise English.";

      const textModel = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: languageInstruction
      });

      // 👇👇👇 ADD LOGGING FOR DEBUGGING 👇👇👇
      logger.info('Generating text with prompt', { language, prompt: prompt.substring(0, 200) + '...' });

      const result = await textModel.generateContent(prompt);
      const response = result.response;
      const responseText = response.text();

      // 👇👇👇 ADD LOGGING FOR DEBUGGING 👇👇👇
      logger.info('Received text generation response', { language, responseText });

      return responseText;
    } catch (error) {
      logger.error('Gemini AI generateText error', { error, language });
      return language === 'zh' ? '抱歉，处理您的请求时遇到错误。' : 'I apologize, but I encountered an error processing your request.';
    }
  }

  async analyzeYieldData(data: any, lang: 'en' | 'zh'): Promise<string> {
    const englishPrompt = `
      You are BeanBee, a friendly DeFi analyst. Be specific but concise.

      Rules:
      1. Use EXACT numbers from data
      2. Give specific pool names with APY %
      3. Max 80 words total
      4. Include clickable links for recommended pools

      Format:
      Hey! Looking at your DeFi setup 🌾

      **Current:** [value] in [protocols], [APY]% APY - [brief assessment]

      **My picks:**
      • **[Token]:** [Specific pool name] ([APY]% APY) - [Pool link]
      • **Alternative:** [Another pool] ([APY]% APY) if available

      **Avoid:** [Specific dangerous pool] ([APY]% APY) - [brief risk] 🚨

      **Next step:** Try [specific %] in [specific pool name].

      [Short encouraging line]! 💪

      **Link Format:** [Pool Name](https://defillama.com/yields/pool/{poolId})

      **APY Calculation:**
      - If positionSummary.averageAPY is 0 or null, calculate from defiPositions/stakingPositions
      - Use weighted average based on position values
      - Show actual calculated APY, not 0%

      **Data Processing:**
      - Format TVL: $1,500,000 → $1.5M
      - Focus on highest value tokens from userHoldings
      - Include specific pool IDs for links

      User Data:
      \`\`\`json
      ${JSON.stringify(data, null, 2)}
      \`\`\`
    `;

    const chinesePrompt = `
      你是BeanBee，友善的DeFi分析师。具体但简洁。

      规则：
      1. 使用数据中的确切数字
      2. 给出具体池子名称和APY%
      3. 最多80字
      4. 为推荐池子包含可点击链接

      格式：
      嘿！看了你的DeFi布局 🌾

      **现状：** [价值] 在 [协议]，[APY]% APY - [简单评价]

      **我推荐：**
      • **[代币]：** [具体池子名称] ([APY]% APY) - [池子链接]
      • **备选：** [另一个池子] ([APY]% APY) 如果有

      **避开：** [具体危险池子] ([APY]% APY) - [简短风险] 🚨

      **下一步：** 试试[具体百分比]放到[具体池子名称]。

      [简短鼓励]！💪

      **链接格式：** [池子名称](https://defillama.com/yields/pool/{poolId})

      **APY计算：**
      - 如果positionSummary.averageAPY是0或空，从defiPositions/stakingPositions计算
      - 用基于持仓价值的加权平均
      - 显示实际计算的APY，不是0%

      **数据处理：**
      - 格式化TVL: $1,500,000 → $150万
      - 关注userHoldings中最高价值代币
      - 包含具体池子ID用于链接

      用户数据：
      \`\`\`json
      ${JSON.stringify(data, null, 2)}
      \`\`\`
    `;

    const prompt = lang === 'zh' ? chinesePrompt : englishPrompt;

    try {
      const result = await this.yieldAnalysisModel.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      logger.error('Error generating yield analysis from AI', { lang, error });
      return lang === 'zh'
        ? '抱歉，分析您的收益机会时出现错误。请稍后再试。'
        : 'Sorry, an error occurred while analyzing your yield opportunities. Please try again later.';
    }
  }

}

export const geminiAI = new GeminiAIService();