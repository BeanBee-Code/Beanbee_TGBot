import { Context } from 'telegraf';
import { ethers } from 'ethers';
import { TokenSearchService, TokenSearchResult } from '../../services/tokenSearch';
import { createLogger } from '../../utils/logger';
import { getTranslation, getUserLanguage } from '@/i18n';

const logger = createLogger('menu.tokenSearch');

// Initialize with optional API key from environment
const tokenSearchService = new TokenSearchService(
  process.env.MORALIS_API_KEY
);

/**
 * Show the token search menu
 */
export async function handleTokenSearchMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const title = await getTranslation(ctx, 'tokenSearch.title');
  const description = await getTranslation(ctx, 'tokenSearch.description');
  const examples = await getTranslation(ctx, 'tokenSearch.examples');
  const searchBySymbol = await getTranslation(ctx, 'tokenSearch.searchBySymbol');
  const searchByName = await getTranslation(ctx, 'tokenSearch.searchByName');
  const searchByAddress = await getTranslation(ctx, 'tokenSearch.searchByAddress');
  const typeQuery = await getTranslation(ctx, 'tokenSearch.typeQuery');
  const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');

  const message = `${title}

${description}

${examples}
${searchBySymbol}
${searchByName}
${searchByAddress}

${typeQuery}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: backButton, callback_data: 'start' }]
    ]
  };

  // Set session state to wait for token search input
  const session = global.userSessions.get(userId);
  if (session) {
    // Clear all other waiting states to avoid conflicts
    delete session.waitingForWalletInput;
    delete session.waitingForWalletAddress;
    delete session.waitingForTokenAddress;
    if (session.trading) {
      delete session.trading.waitingForTokenInput;
      delete session.trading.waitingForAmountInput;
    }
    if (session.rugAlerts) {
      delete session.rugAlerts.waitingForTokenInput;
    }
    if (session.transfer) {
      delete session.transfer.waitingForAmountInput;
    }
    if (session.autoTradeSetup) {
      delete session.autoTradeSetup.waitingForInput;
    }
    
    // Set the correct waiting state
    session.waitingForTokenSearchInput = true;
    global.userSessions.set(userId, session);
  }

  await ctx.reply(message, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

/**
 * Handle token search input from user
 */
export async function handleTokenSearchInput(ctx: Context, query: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Show searching message
  const searchingText = await getTranslation(ctx, 'tokenSearch.searching');
  const searchingMsg = await ctx.reply(searchingText);

  try {
    // Search for tokens
    const results = await tokenSearchService.searchTokens(query);

    // Delete searching message
    await ctx.deleteMessage(searchingMsg.message_id).catch(() => {});

    if (results.length === 0) {
      const noTokensFound = await getTranslation(ctx, 'tokenSearch.noTokensFound');
      const checkSpelling = await getTranslation(ctx, 'tokenSearch.checkSpelling');
      const searchAgain = await getTranslation(ctx, 'tokenSearch.searchAgain');
      const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
      
      await ctx.reply(
        `${noTokensFound.replace('{query}', query)}\n\n${checkSpelling}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: searchAgain, callback_data: 'token_search' }],
              [{ text: backButton, callback_data: 'start' }]
            ]
          }
        }
      );
      return;
    }

    // Show search results
    await showSearchResults(ctx, results, query);

  } catch (error) {
    logger.error('Error searching tokens', { error, userId, query });
    await ctx.deleteMessage(searchingMsg.message_id).catch(() => {});
    
    const errorText = await getTranslation(ctx, 'tokenSearch.errorSearching');
    const tryAgain = await getTranslation(ctx, 'tokenSearch.tryAgain');
    const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
    
    await ctx.reply(
      errorText,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: tryAgain, callback_data: 'token_search' }],
            [{ text: backButton, callback_data: 'start' }]
          ]
        }
      }
    );
  }

  // Clear session state
  const session = global.userSessions.get(userId);
  if (session) {
    session.waitingForTokenSearchInput = false;
    global.userSessions.set(userId, session);
  }
}

/**
 * Show token search results
 */
async function showSearchResults(ctx: Context, results: TokenSearchResult[], query: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  const lang = await getUserLanguage(userId);
  const message = tokenSearchService.formatSearchResults(results, lang, query);

  // Create inline keyboard with token options
  const keyboard = {
    inline_keyboard: results.slice(0, 10).map((token, index) => {
      const price = token.price ? ` ($${token.price.toFixed(4)})` : '';
      const verified = token.verified ? ' ✅' : '';
      // Use address for callback
      const callbackId = token.address || `unknown_${index}`;
      return [{
        text: `${index + 1}. ${token.symbol}${price}${verified}`,
        callback_data: `token_details_${callbackId}`
      }];
    })
  };

  // Add navigation buttons
  const newSearch = await getTranslation(ctx, 'tokenSearch.newSearch');
  const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
  
  keyboard.inline_keyboard.push(
    [{ text: newSearch, callback_data: 'token_search' }],
    [{ text: backButton, callback_data: 'start' }]
  );

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

/**
 * Show detailed information for a specific token
 */
export async function handleTokenDetails(ctx: Context, tokenIdOrAddress: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Show loading message
  await ctx.answerCbQuery();
  const loadingText = await getTranslation(ctx, 'tokenSearch.loadingDetails');
  await ctx.editMessageText(loadingText);

  try {
    let token: TokenSearchResult | null = null;
    
    // Check if it's a valid address
    const isAddress = ethers.isAddress(tokenIdOrAddress);
    const isUnknown = tokenIdOrAddress.startsWith('unknown_');
    
    if (isAddress) {
      // It's an address, get token info by address
      token = await tokenSearchService.getTokenByAddress(tokenIdOrAddress);
    }
    
    if (!token) {
      const couldNotLoad = await getTranslation(ctx, 'tokenSearch.couldNotLoad');
      const searchAgain = await getTranslation(ctx, 'tokenSearch.searchAgain');
      const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
      
      await ctx.editMessageText(
        couldNotLoad,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: searchAgain, callback_data: 'token_search' }],
              [{ text: backButton, callback_data: 'start' }]
            ]
          }
        }
      );
      return;
    }

    // Format and show token details
    const lang = await getUserLanguage(userId);
    const message = tokenSearchService.formatTokenDetails(token, lang);

    // Check if user has trading wallet to show trade buttons
    const { UserService } = await import('../../services/user');
    const hasTradingWallet = await UserService.getTradingWalletAddress(userId) !== null;

    const buyText = await getTranslation(ctx, 'tokenSearch.buy');
    const sellText = await getTranslation(ctx, 'tokenSearch.sell');
    const analyzeText = await getTranslation(ctx, 'tokenSearch.analyzeToken');
    const refreshText = await getTranslation(ctx, 'tokenSearch.refresh');
    const newSearchText = await getTranslation(ctx, 'tokenSearch.newSearch');
    const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
    
    const keyboard = {
      inline_keyboard: [
        // Trade buttons (only if user has trading wallet and token has address)
        ...(hasTradingWallet && token.address ? [[
          { text: buyText, callback_data: `token_buy_${token.address}` },
          { text: sellText, callback_data: `token_sell_${token.address}` }
        ]] : []),
        // Analysis button (only if token has address)
        ...(token.address ? [[{ text: analyzeText, callback_data: `analyze_token_${token.address}` }]] : []),
        // Refresh button
        [{ text: refreshText, callback_data: `token_details_${tokenIdOrAddress}` }],
        // Navigation
        [{ text: newSearchText, callback_data: 'token_search' }],
        [{ text: backButton, callback_data: 'start' }]
      ]
    };

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });

  } catch (error) {
    logger.error('Error showing token details', { error, userId, tokenIdOrAddress });
    
    const errorText = await getTranslation(ctx, 'tokenSearch.errorLoadingDetails');
    const searchAgain = await getTranslation(ctx, 'tokenSearch.searchAgain');
    const backButton = await getTranslation(ctx, 'tokenSearch.backToMainMenu');
    
    await ctx.editMessageText(
      errorText,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: searchAgain, callback_data: 'token_search' }],
            [{ text: backButton, callback_data: 'start' }]
          ]
        }
      }
    );
  }
}