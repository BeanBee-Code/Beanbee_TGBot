import { Context } from 'telegraf';
import { ethers } from 'ethers';
import SignClient from '@walletconnect/sign-client';
import { getTranslation } from '@/i18n';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { createLogger } from '@/utils/logger';
import { COMMON_TOKENS, TokenInfo, isNativeBNB, getTokenByAddress } from '@/config/commonTokens';
import {
  getTokenBalance,
  getTokenMetadata,
  encodeTransferData,
  formatTokenBalance,
  isValidTokenAddress,
  getMultipleTokenBalances,
  executeERC20Transfer
} from './erc20Transfer';

const logger = createLogger('wallet.transfer');

export class TransferService {
  /**
   * Handle token transfer from main wallet to trading wallet
   * Supports both WalletConnect and web frontend connections
   * Supports both native BNB and ERC20 tokens
   */
  async handleTransferToTrading(ctx: Context, amount: string, backCallback?: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    const finalBackCallback = backCallback || session?.transfer?.backCallback || 'wallet_info';

    // Get selected token from session (defaults to BNB if not set)
    const selectedToken = session?.transfer?.selectedToken || COMMON_TOKENS.BNB;

    // Check if user has an active WalletConnect session
    if (session?.client && session?.address) {
      // Execute WalletConnect flow
      await this.handleWalletConnectTransfer(ctx, amount, session, finalBackCallback, selectedToken);
    } else {
      // Execute web frontend flow - generate task link
      await this.handleWebFrontendTransfer(ctx, amount, finalBackCallback, selectedToken);
    }
  }

  /**
   * Handle transfer via WalletConnect session
   */
  private async handleWalletConnectTransfer(ctx: Context, amount: string, session: any, backCallback: string, tokenInfo: TokenInfo) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer via WalletConnect session', { userId, token: tokenInfo.symbol });

    // Import UserService
    const { UserService } = await import('../user');
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

    if (!tradingWalletAddress) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Trading wallet not found');
      } else {
        await ctx.reply('❌ Trading wallet not found');
      }
      return;
    }

    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery();
      }

      // Create transaction request
      let tx: any;

      if (isNativeBNB(tokenInfo.address)) {
        // Native BNB transfer
        tx = {
          from: session.address,
          to: tradingWalletAddress,
          value: ethers.toQuantity(ethers.parseEther(amount)),
          data: '0x'
        };
      } else {
        // ERC20 token transfer
        const transferData = encodeTransferData(tradingWalletAddress, amount, tokenInfo.decimals);
        tx = {
          from: session.address,
          to: tokenInfo.address, // Contract address
          value: '0x0', // No BNB value for token transfer
          data: transferData
        };
      }

      // Get WalletConnect session from database
      const walletConnection = await UserService.getWalletConnection(userId);
      
      if (!walletConnection?.topic || !walletConnection?.session) {
        await ctx.reply('❌ WalletConnect session not found. Please reconnect your wallet.');
        return;
      }
      
      // Send transaction request via WalletConnect
      const client = session.client as SignClient;
      
      // Validate that the session is still active
      try {
        const activeSessions = client.session.getAll();
        const activeSession = activeSessions.find(s => s.topic === walletConnection.topic);
        
        if (!activeSession) {
          // Session expired - trigger reconnection
          await ctx.reply('❌ Your wallet session has expired. Generating new connection...');
          
          // Clean up old session data
          await UserService.disconnectWallet(userId);
          
          // Generate new connection using global instance
          const { getWalletService } = await import('./index');
          const walletService = getWalletService();
          await walletService.handleReconnect(ctx, userId);
          return;
        }
      } catch (error) {
        logger.warn('Session validation error, proceeding with transaction', { error });
      }

      const processingMessage =
        `📤 *Transfer ${tokenInfo.symbol} to Trading Wallet*\n\n` +
        `Amount: ${amount} ${tokenInfo.symbol}\n` +
        `From: \`${session.address.slice(0, 6)}...${session.address.slice(-4)}\`\n` +
        `To: \`${tradingWalletAddress.slice(0, 6)}...${tradingWalletAddress.slice(-4)}\`\n\n` +
        `⏳ Please confirm the transaction in your wallet...`;

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
      }

      const result = await client.request({
        topic: walletConnection.topic,
        chainId: 'eip155:56', // BSC mainnet
        request: {
          method: 'eth_sendTransaction',
          params: [tx]
        }
      });

      // Invalidate DeFi cache for both wallets after successful transfer
      await DeFiPosition.updateMany(
        {
          userId: userId,
          walletAddress: { $in: [session.address.toLowerCase(), tradingWalletAddress.toLowerCase()] }
        },
        {
          $set: { lastRefreshAt: new Date(0) } // Set to epoch to force refresh
        }
      );
      logger.info('Invalidated DeFi cache after transfer', { userId });

      // Show success message
      const successTitle = await getTranslation(ctx, 'transfer.success');
      const transferredMsg = await getTranslation(ctx, 'transfer.transferredToTrading');
      const txHashLabel = await getTranslation(ctx, 'transfer.transactionHash');
      const viewOnBscScan = await getTranslation(ctx, 'wallet.viewOnBscScan');
      // Determine button text based on where user came from
      const backButtonText = backCallback === 'honey_recharge'
        ? '🍯 Back to Buy Honey'
        : await getTranslation(ctx, 'transfer.backToWalletInfo');

      const successMessage =
        `${successTitle}\n\n` +
        `${transferredMsg.replace('{amount}', `${amount} ${tokenInfo.symbol}`)}\n\n` +
        `${txHashLabel}:\n\`${result}\`\n\n` +
        `[${viewOnBscScan}](https://bscscan.com/tx/${result})`;

      const successKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      } else {
        await ctx.reply(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      }

    } catch (error: any) {
      logger.error('Transfer error', { userId, error: error instanceof Error ? error.message : String(error) });
      
      let errorMessage = await getTranslation(ctx, 'transfer.transferFailed');
      if (error.message?.includes('rejected')) {
        errorMessage = await getTranslation(ctx, 'transfer.transactionRejected');
      } else if (error.message?.includes('insufficient')) {
        errorMessage = await getTranslation(ctx, 'transfer.insufficientBalance');
      } else if (error.message?.includes('session topic doesn\'t exist') || 
                 error.message?.includes('No matching key') ||
                 error.message?.includes('Session not found')) {
        // Session expired - handle reconnection more gracefully
        logger.info('Wallet session expired, triggering reconnection', { userId });
        
        // Clean up old session data first
        const { UserService } = await import('../user');
        await UserService.disconnectWallet(userId);
        global.userSessions.delete(userId);
        
        // Show reconnection message
        const sessionExpiredMsg = await getTranslation(ctx, 'transfer.sessionExpired');
        const reconnectMsg = await ctx.reply(
          sessionExpiredMsg,
          { parse_mode: 'Markdown' }
        );
        
        // Generate new connection using global instance
        const { getWalletService } = await import('./index');
        const walletService = getWalletService();
        
        // Initialize new session
        await walletService.initializeConnection(userId);
        
        // Show connect UI
        await walletService.handleConnect(ctx);
        
        // Delete the reconnect message after showing QR
        try {
          await ctx.telegram.deleteMessage(reconnectMsg.chat.id, reconnectMsg.message_id);
        } catch (e) {
          // Ignore deletion errors
        }
        
        return;
      } else if (error.message?.includes('User disapproved requested chains')) {
        errorMessage = await getTranslation(ctx, 'transfer.wrongNetwork');
      }
      
      const backButtonText = await getTranslation(ctx, 'common.back');
      const errorKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'Markdown',
          reply_markup: errorKeyboard
        });
      } else {
        await ctx.reply(errorMessage, {
          parse_mode: 'Markdown',
          reply_markup: errorKeyboard
        });
      }
    }
  }

  /**
   * Handle transfer for web-connected users by generating task link
   */
  private async handleWebFrontendTransfer(ctx: Context, amount: string, backCallback: string, tokenInfo: TokenInfo) {
    const userId = ctx.from!.id;
    logger.info('Generating transfer task link for web-connected user', { userId, token: tokenInfo.symbol });

    const { UserService } = await import('../user');
    const { getUserLanguage } = await import('@/i18n');

    const mainWalletAddress = await UserService.getMainWalletAddress(userId);
    if (!mainWalletAddress) {
      const errorMsg = 'Error: Your main wallet address is not registered. Please reconnect via the web page.';
      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return;
    }

    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      const errorMsg = 'Error: Trading wallet not found.';
      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return;
    }

    // Import the generateTransferLink function
    const { generateTransferLink } = await import('../../api/server');

    // Generate secure task link
    const taskUrl = generateTransferLink(userId, tradingWalletAddress, amount, tokenInfo.symbol, backCallback);

    // Get user language for localized messages
    const lang = await getUserLanguage(userId);
    const message = lang === 'zh'
      ? `➡️ **确认转账**\n\n请点击下方按钮，在您的网页钱包中确认将 **${amount} ${tokenInfo.symbol}** 从您的主钱包转入交易钱包。`
      : `➡️ **Confirm Transfer**\n\nPlease click the button below to confirm the transfer of **${amount} ${tokenInfo.symbol}** from your main wallet to your trading wallet in your web wallet.`;

    const keyboard = {
      inline_keyboard: [
        [{ 
          text: lang === 'zh' ? '🔗 在浏览器中确认' : '🔗 Confirm in Browser', 
          url: taskUrl 
        }]
      ]
    };
    
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  }

  /**
   * Handle token transfer from trading wallet to main wallet
   * Supports both WalletConnect and web frontend connections
   * Supports both native BNB and ERC20 tokens
   */
  async handleTransferFromTrading(ctx: Context, amount: string, backCallback?: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    const finalBackCallback = backCallback || session?.transfer?.backCallback || 'wallet_info';

    // Get selected token from session (defaults to BNB if not set)
    const selectedToken = session?.transfer?.selectedToken || COMMON_TOKENS.BNB;

    // Check if user has an active WalletConnect session
    if (session?.client && session?.address) {
      // Execute WalletConnect flow
      await this.handleWalletConnectTransferFromTrading(ctx, amount, session, finalBackCallback, selectedToken);
    } else {
      // Execute web frontend flow for web-connected users
      await this.handleWebFrontendTransferFromTrading(ctx, amount, finalBackCallback, selectedToken);
    }
  }

  /**
   * Handle transfer from trading to main via WalletConnect session
   */
  private async handleWalletConnectTransferFromTrading(ctx: Context, amount: string, session: any, backCallback: string, tokenInfo: TokenInfo) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer from trading via WalletConnect', { userId, token: tokenInfo.symbol });

    // Import UserService
    const { UserService } = await import('../user');
    const { getTradingWallet } = await import('./tradingWallet');

    const tradingWalletData = await UserService.getTradingWalletData(userId);
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

    if (!tradingWalletData || !tradingWalletAddress) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Trading wallet not found');
      } else {
        await ctx.reply('❌ Trading wallet not found');
      }
      return;
    }

    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery();
      }

      // Get provider
      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');

      // Get trading wallet instance
      const tradingWallet = getTradingWallet(
        tradingWalletData.encryptedPrivateKey,
        tradingWalletData.iv,
        provider
      );

      // Execute transfer
      let tx: ethers.TransactionResponse;

      if (isNativeBNB(tokenInfo.address)) {
        // Native BNB transfer
        tx = await tradingWallet.sendTransaction({
          to: session.address,
          value: ethers.parseEther(amount)
        });
      } else {
        // ERC20 token transfer
        tx = await executeERC20Transfer(
          tokenInfo.address,
          session.address,
          amount,
          tokenInfo.decimals,
          tradingWallet
        );
      }

      const transferTitle = await getTranslation(ctx, 'transfer.fromTradingTitle');
      const amountLabel = await getTranslation(ctx, 'transfer.amount');
      const fromLabel = await getTranslation(ctx, 'transfer.from');
      const toLabel = await getTranslation(ctx, 'transfer.to');
      const transactionSubmitted = await getTranslation(ctx, 'transfer.transactionSubmitted');

      const processingMessage =
        `${transferTitle}\n\n` +
        `${amountLabel}: ${amount} ${tokenInfo.symbol}\n` +
        `${fromLabel}: \`${tradingWalletAddress.slice(0, 6)}...${tradingWalletAddress.slice(-4)}\`\n` +
        `${toLabel}: \`${session.address.slice(0, 6)}...${session.address.slice(-4)}\`\n\n` +
        `${transactionSubmitted}`;

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
      }

      // Wait for confirmation
      const receipt = await tx.wait();

      // Invalidate DeFi cache for both wallets after successful transfer
      await DeFiPosition.updateMany(
        {
          userId: userId,
          walletAddress: { $in: [session.address.toLowerCase(), tradingWalletAddress.toLowerCase()] }
        },
        {
          $set: { lastRefreshAt: new Date(0) } // Set to epoch to force refresh
        }
      );
      logger.info('Invalidated DeFi cache after transfer from trading', { userId });

      // Show success message
      const successTitle = await getTranslation(ctx, 'transfer.success');
      const transferredMsg = await getTranslation(ctx, 'transfer.transferredToMain');
      const txHashLabel = await getTranslation(ctx, 'transfer.transactionHash');
      const viewOnBscScan = await getTranslation(ctx, 'wallet.viewOnBscScan');
      // Determine button text based on where user came from
      const backButtonText = backCallback === 'honey_recharge'
        ? '🍯 Back to Buy Honey'
        : await getTranslation(ctx, 'transfer.backToWalletInfo');

      const successMessage =
        `${successTitle}\n\n` +
        `${transferredMsg.replace('{amount}', `${amount} ${tokenInfo.symbol}`)}\n\n` +
        `${txHashLabel}:\n\`${receipt!.hash}\`\n\n` +
        `[${viewOnBscScan}](https://bscscan.com/tx/${receipt!.hash})`;

      const successKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      } else {
        await ctx.reply(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      }

    } catch (error: any) {
      logger.error('Transfer from trading error', { userId, error: error instanceof Error ? error.message : String(error) });
      
      let errorMessage = await getTranslation(ctx, 'transfer.transferFailed');
      if (error.message?.includes('insufficient funds')) {
        errorMessage = await getTranslation(ctx, 'transfer.insufficientBalanceInTrading');
      } else if (error.reason) {
        errorMessage = `❌ Error: ${error.reason}`;
      }
      
      const backButtonText = await getTranslation(ctx, 'common.back');
      const errorKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMessage, {
          reply_markup: errorKeyboard
        });
      } else {
        await ctx.reply(errorMessage, {
          reply_markup: errorKeyboard
        });
      }
    }
  }

  /**
   * Handle transfer from trading to main for web-connected users
   * This executes the transfer directly from the trading wallet
   */
  private async handleWebFrontendTransferFromTrading(ctx: Context, amount: string, backCallback: string, tokenInfo: TokenInfo) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer from trading for web-connected user', { userId, token: tokenInfo.symbol });

    const { UserService } = await import('../user');
    const { getTradingWallet } = await import('./tradingWallet');

    // Get main wallet address from database
    const mainWalletAddress = await UserService.getMainWalletAddress(userId);
    if (!mainWalletAddress) {
      const errorMsg = 'Error: Your main wallet address is not registered. Please reconnect via the web page.';
      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return;
    }

    // Get trading wallet data
    const tradingWalletData = await UserService.getTradingWalletData(userId);
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);

    if (!tradingWalletData || !tradingWalletAddress) {
      const errorMsg = 'Error: Trading wallet not found.';
      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return;
    }

    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery();
      }

      // Get provider
      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');

      // Get trading wallet instance
      const tradingWallet = getTradingWallet(
        tradingWalletData.encryptedPrivateKey,
        tradingWalletData.iv,
        provider
      );

      // Execute transfer
      let tx: ethers.TransactionResponse;

      if (isNativeBNB(tokenInfo.address)) {
        // Native BNB transfer
        tx = await tradingWallet.sendTransaction({
          to: mainWalletAddress,
          value: ethers.parseEther(amount)
        });
      } else {
        // ERC20 token transfer
        tx = await executeERC20Transfer(
          tokenInfo.address,
          mainWalletAddress,
          amount,
          tokenInfo.decimals,
          tradingWallet
        );
      }

      const transferTitle = await getTranslation(ctx, 'transfer.fromTradingTitle');
      const amountLabel = await getTranslation(ctx, 'transfer.amount');
      const fromLabel = await getTranslation(ctx, 'transfer.from');
      const toLabel = await getTranslation(ctx, 'transfer.to');
      const transactionSubmitted = await getTranslation(ctx, 'transfer.transactionSubmitted');

      const processingMessage =
        `${transferTitle}\n\n` +
        `${amountLabel}: ${amount} ${tokenInfo.symbol}\n` +
        `${fromLabel}: \`${tradingWalletAddress.slice(0, 6)}...${tradingWalletAddress.slice(-4)}\`\n` +
        `${toLabel}: \`${mainWalletAddress.slice(0, 6)}...${mainWalletAddress.slice(-4)}\`\n\n` +
        `${transactionSubmitted}`;

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(processingMessage, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(processingMessage, { parse_mode: 'Markdown' });
      }

      // Wait for confirmation
      const receipt = await tx.wait();

      // Invalidate DeFi cache for both wallets after successful transfer
      await DeFiPosition.updateMany(
        {
          userId: userId,
          walletAddress: { $in: [mainWalletAddress.toLowerCase(), tradingWalletAddress.toLowerCase()] }
        },
        {
          $set: { lastRefreshAt: new Date(0) } // Set to epoch to force refresh
        }
      );
      logger.info('Invalidated DeFi cache after transfer from trading', { userId });

      // Show success message
      const successTitle = await getTranslation(ctx, 'transfer.success');
      const transferredMsg = await getTranslation(ctx, 'transfer.transferredToMain');
      const txHashLabel = await getTranslation(ctx, 'transfer.transactionHash');
      const viewOnBscScan = await getTranslation(ctx, 'wallet.viewOnBscScan');
      // Determine button text based on where user came from
      const backButtonText = backCallback === 'honey_recharge'
        ? '🍯 Back to Buy Honey'
        : await getTranslation(ctx, 'transfer.backToWalletInfo');

      const successMessage =
        `${successTitle}\n\n` +
        `${transferredMsg.replace('{amount}', `${amount} ${tokenInfo.symbol}`)}\n\n` +
        `${txHashLabel}:\n\`${receipt!.hash}\`\n\n` +
        `[${viewOnBscScan}](https://bscscan.com/tx/${receipt!.hash})`;

      const successKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      } else {
        await ctx.reply(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: successKeyboard
        });
      }

    } catch (error: any) {
      logger.error('Transfer from trading error for web user', { userId, error: error instanceof Error ? error.message : String(error) });
      
      let errorMessage = await getTranslation(ctx, 'transfer.transferFailed');
      if (error.message?.includes('insufficient funds')) {
        errorMessage = await getTranslation(ctx, 'transfer.insufficientBalanceInTrading');
      } else if (error.reason) {
        errorMessage = `❌ Error: ${error.reason}`;
      }
      
      const backButtonText = await getTranslation(ctx, 'common.back');
      const errorKeyboard = {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: backCallback }]
        ]
      };

      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(errorMessage, {
          reply_markup: errorKeyboard
        });
      } else {
        await ctx.reply(errorMessage, {
          reply_markup: errorKeyboard
        });
      }
    }
  }

  /**
   * Show token selection menu
   */
  async showTokenSelectionMenu(ctx: Context, direction: 'to_trading' | 'from_trading') {
    const userId = ctx.from!.id;
    await ctx.answerCbQuery();

    // Get translations
    const selectToken = await getTranslation(ctx, 'transfer.selectToken');
    const customToken = await getTranslation(ctx, 'transfer.customToken');
    const cancel = await getTranslation(ctx, 'common.cancel');

    // Build keyboard with common tokens
    const tokenButtons = Object.values(COMMON_TOKENS).map(token => ({
      text: `${token.emoji || ''} ${token.symbol}`,
      callback_data: `transfer_token_${direction}_${token.symbol.toLowerCase()}`
    }));

    // Group tokens into rows of 2
    const tokenRows = [];
    for (let i = 0; i < tokenButtons.length; i += 2) {
      tokenRows.push(tokenButtons.slice(i, i + 2));
    }

    const keyboard = {
      inline_keyboard: [
        ...tokenRows,
        [{ text: `✏️ ${customToken}`, callback_data: `transfer_custom_token_${direction}` }],
        [{ text: '🔙 ' + cancel, callback_data: 'wallet_info' }]
      ]
    };

    await ctx.editMessageText(
      selectToken,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  }

  /**
   * Show transfer direction selection menu
   */
  async showTransferMenu(ctx: Context) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);

    // Check if user has any wallet connected (WalletConnect or web frontend)
    if (!session?.address) {
      // Check if user has web-connected wallet
      const { UserService } = await import('../user');
      const mainWalletAddress = await UserService.getMainWalletAddress(userId);

      if (!mainWalletAddress) {
        const noWalletMsg = await getTranslation(ctx, 'wallet.noWalletConnected');
        await ctx.answerCbQuery(noWalletMsg);
        return;
      }
    }

    await ctx.answerCbQuery();

    // Get translations
    const title = await getTranslation(ctx, 'transfer.title');
    const selectDirection = await getTranslation(ctx, 'transfer.selectDirection');
    const toTrading = await getTranslation(ctx, 'transfer.toTrading');
    const fromTrading = await getTranslation(ctx, 'transfer.fromTrading');
    const cancel = await getTranslation(ctx, 'common.cancel');

    const keyboard = {
      inline_keyboard: [
        [{ text: toTrading, callback_data: 'transfer_direction_to_trading' }],
        [{ text: fromTrading, callback_data: 'transfer_direction_from_trading' }],
        [{ text: '🔙 ' + cancel, callback_data: 'wallet_info' }]
      ]
    };

    await ctx.editMessageText(
      `${title}\n\n${selectDirection}`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  }

  /**
   * Show transfer amount selection menu for Main to Trading
   * @param ctx - Telegraf context
   * @param tokenInfo - Token to transfer
   * @param backCallback - Optional callback data for the back button (defaults to 'transfer_menu')
   */
  async showTransferToTradingMenu(ctx: Context, tokenInfo: TokenInfo, backCallback: string = 'transfer_menu') {
    const userId = ctx.from!.id;

    // Store the token and back callback in the session
    const sessionForCallback = global.userSessions.get(userId);
    if (sessionForCallback) {
        if (!sessionForCallback.transfer) sessionForCallback.transfer = {};
        sessionForCallback.transfer.backCallback = backCallback;
        sessionForCallback.transfer.selectedToken = tokenInfo;
    }
    const session = global.userSessions.get(userId);

    // Get main wallet address - either from session or database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Check if user has web-connected wallet
      const { UserService } = await import('../user');
      mainWalletAddress = await UserService.getMainWalletAddress(userId);

      if (!mainWalletAddress) {
        const noWalletMsg = await getTranslation(ctx, 'wallet.noWalletConnected');
        // Only answer callback query if this is a callback context
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery(noWalletMsg);
        } else {
          await ctx.reply(noWalletMsg);
        }
        return;
      }
    }

    // Import services
    const { UserService } = await import('../user');

    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      const noTradingMsg = await getTranslation(ctx, 'wallet.noTradingWallet');
      // Only answer callback query if this is a callback context
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(noTradingMsg);
      } else {
        await ctx.reply(noTradingMsg);
      }
      return;
    }

    // Get main wallet balance
    let mainBalance: string;
    if (isNativeBNB(tokenInfo.address)) {
      const { getBNBBalance } = await import('./balance');
      mainBalance = await getBNBBalance(mainWalletAddress);
    } else {
      // ERC20 token balance
      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
      mainBalance = await getTokenBalance(tokenInfo.address, mainWalletAddress, provider);
    }

    // Only answer callback query if this is a callback context
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
    }

    // Get translations
    const title = await getTranslation(ctx, 'transfer.title');
    const toTradingText = await getTranslation(ctx, 'transfer.toTrading');
    const availableBalance = await getTranslation(ctx, 'transfer.availableBalance');
    const selectAmount = await getTranslation(ctx, 'transfer.selectAmount');
    const customAmount = await getTranslation(ctx, 'transfer.customAmount');
    const cancel = await getTranslation(ctx, 'common.cancel');

    // Create quick amount buttons based on token
    const quickAmounts = isNativeBNB(tokenInfo.address)
      ? ['0.01', '0.05', '0.1', '0.5']
      : tokenInfo.symbol === 'USDT' || tokenInfo.symbol === 'USDC' || tokenInfo.symbol === 'BUSD'
      ? ['10', '50', '100', '500']
      : ['0.1', '0.5', '1', '5'];

    const keyboard = {
      inline_keyboard: [
        // Quick transfer amounts
        [
          { text: `${quickAmounts[0]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_to_${quickAmounts[0]}` },
          { text: `${quickAmounts[1]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_to_${quickAmounts[1]}` },
          { text: `${quickAmounts[2]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_to_${quickAmounts[2]}` },
          { text: `${quickAmounts[3]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_to_${quickAmounts[3]}` }
        ],
        // Percentage buttons
        [
          { text: '25%', callback_data: 'transfer_percent_to_25' },
          { text: '50%', callback_data: 'transfer_percent_to_50' },
          { text: '75%', callback_data: 'transfer_percent_to_75' },
          { text: '100%', callback_data: 'transfer_percent_to_100' }
        ],
        [
          { text: customAmount, callback_data: 'transfer_custom_amount_to_trading' }
        ],
        [{ text: '🔙 ' + cancel, callback_data: backCallback }]
      ]
    };

    const message =
      `${title} ${toTradingText}\n\n` +
      `${tokenInfo.emoji || ''} *${tokenInfo.symbol}*\n` +
      `${availableBalance} ${formatTokenBalance(mainBalance)} ${tokenInfo.symbol}\n\n` +
      `${selectAmount}`;

    // Use editMessageText for callback queries, reply for regular messages
    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  }

  /**
   * Show transfer amount selection menu for Trading to Main
   * @param ctx - Telegraf context
   * @param tokenInfo - Token to transfer
   * @param backCallback - Optional callback data for the back button (defaults to 'transfer_menu')
   */
  async showTransferFromTradingMenu(ctx: Context, tokenInfo: TokenInfo, backCallback: string = 'transfer_menu') {
    const userId = ctx.from!.id;

    // Store the token and back callback in the session
    const sessionForCallback = global.userSessions.get(userId);
    if (sessionForCallback) {
        if (!sessionForCallback.transfer) sessionForCallback.transfer = {};
        sessionForCallback.transfer.backCallback = backCallback;
        sessionForCallback.transfer.selectedToken = tokenInfo;
    }

    const session = global.userSessions.get(userId);

    // Get main wallet address - either from session or database
    let mainWalletAddress = session?.address;

    if (!mainWalletAddress) {
      // Check if user has web-connected wallet
      const { UserService } = await import('../user');
      mainWalletAddress = await UserService.getMainWalletAddress(userId);

      if (!mainWalletAddress) {
        const noWalletMsg = await getTranslation(ctx, 'wallet.noWalletConnected');
        // Only answer callback query if this is a callback context
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery(noWalletMsg);
        } else {
          await ctx.reply(noWalletMsg);
        }
        return;
      }
    }

    // Import services
    const { UserService } = await import('../user');

    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      const noTradingMsg = await getTranslation(ctx, 'wallet.noTradingWallet');
      // Only answer callback query if this is a callback context
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(noTradingMsg);
      } else {
        await ctx.reply(noTradingMsg);
      }
      return;
    }

    // Get trading wallet balance
    let tradingBalance: string;
    if (isNativeBNB(tokenInfo.address)) {
      const { getBNBBalance } = await import('./balance');
      tradingBalance = await getBNBBalance(tradingWalletAddress);
    } else {
      // ERC20 token balance
      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
      tradingBalance = await getTokenBalance(tokenInfo.address, tradingWalletAddress, provider);
    }

    // Only answer callback query if this is a callback context
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
    }

    // Get translations
    const title = await getTranslation(ctx, 'transfer.title');
    const fromTradingText = await getTranslation(ctx, 'transfer.fromTrading');
    const availableBalance = await getTranslation(ctx, 'transfer.availableBalance');
    const selectAmount = await getTranslation(ctx, 'transfer.selectAmount');
    const customAmount = await getTranslation(ctx, 'transfer.customAmount');
    const cancel = await getTranslation(ctx, 'common.cancel');

    // Create quick amount buttons based on token
    const quickAmounts = isNativeBNB(tokenInfo.address)
      ? ['0.01', '0.05', '0.1', '0.5']
      : tokenInfo.symbol === 'USDT' || tokenInfo.symbol === 'USDC' || tokenInfo.symbol === 'BUSD'
      ? ['10', '50', '100', '500']
      : ['0.1', '0.5', '1', '5'];

    const keyboard = {
      inline_keyboard: [
        // Quick transfer amounts
        [
          { text: `${quickAmounts[0]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_from_${quickAmounts[0]}` },
          { text: `${quickAmounts[1]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_from_${quickAmounts[1]}` },
          { text: `${quickAmounts[2]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_from_${quickAmounts[2]}` },
          { text: `${quickAmounts[3]} ${tokenInfo.symbol}`, callback_data: `transfer_amount_from_${quickAmounts[3]}` }
        ],
        // Percentage buttons
        [
          { text: '25%', callback_data: 'transfer_percent_from_25' },
          { text: '50%', callback_data: 'transfer_percent_from_50' },
          { text: '75%', callback_data: 'transfer_percent_from_75' },
          { text: '100%', callback_data: 'transfer_percent_from_100' }
        ],
        [
          { text: customAmount, callback_data: 'transfer_custom_amount_from_trading' }
        ],
        [{ text: '🔙 ' + cancel, callback_data: backCallback }]
      ]
    };

    const message =
      `${title} ${fromTradingText}\n\n` +
      `${tokenInfo.emoji || ''} *${tokenInfo.symbol}*\n` +
      `${availableBalance} ${formatTokenBalance(tradingBalance)} ${tokenInfo.symbol}\n\n` +
      `${selectAmount}`;

    // Use editMessageText for callback queries, reply for regular messages
    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  }

  /**
   * Handle percentage-based transfer from main to trading
   */
  async handlePercentageTransfer(ctx: Context, percentage: number) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    
    // Get main wallet address - either from session or database
    let mainWalletAddress = session?.address;
    
    if (!mainWalletAddress) {
      // Check if user has web-connected wallet
      const { UserService } = await import('../user');
      mainWalletAddress = await UserService.getMainWalletAddress(userId);
      
      if (!mainWalletAddress) {
        await ctx.answerCbQuery('Main wallet not connected');
        return;
      }
    }

    const { getBNBBalance } = await import('./balance');
    const balance = await getBNBBalance(mainWalletAddress);
    const balanceNum = parseFloat(balance);
    
    const transferAmount = (balanceNum * percentage / 100).toFixed(4);
    
    if (parseFloat(transferAmount) < 0.001) {
      await ctx.answerCbQuery('Amount too small');
      return;
    }

    await this.handleTransferToTrading(ctx, transferAmount);
  }

  /**
   * Handle percentage-based transfer from trading to main
   */
  async handlePercentageTransferFromTrading(ctx: Context, percentage: number) {
    const userId = ctx.from!.id;
    
    // Import services
    const { UserService } = await import('../user');
    const { getBNBBalance } = await import('./balance');
    
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      await ctx.answerCbQuery('Trading wallet not found');
      return;
    }
    
    const balance = await getBNBBalance(tradingWalletAddress);
    const balanceNum = parseFloat(balance);
    
    const transferAmount = (balanceNum * percentage / 100).toFixed(4);
    
    if (parseFloat(transferAmount) < 0.001) {
      await ctx.answerCbQuery('Amount too small');
      return;
    }

    await this.handleTransferFromTrading(ctx, transferAmount);
  }

  /**
   * Handle custom transfer amount input for Main to Trading
   */
  async handleCustomTransferToTrading(ctx: Context) {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    let session = global.userSessions.get(userId);

    // Create session if it doesn't exist (for web-connected users)
    if (!session) {
      session = {
        transfer: {}
      };
      global.userSessions.set(userId, session);
    }

    if (!session.transfer) {
      session.transfer = {};
    }

    session.transfer.waitingForAmountInput = true;
    session.transfer.direction = 'to_trading';

    await ctx.reply(
      '💰 Please enter the amount of BNB you want to transfer to your trading wallet:\n\n' +
      'Example: `0.5` for 0.5 BNB',
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle custom transfer amount input for Trading to Main
   */
  async handleCustomTransferFromTrading(ctx: Context) {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    let session = global.userSessions.get(userId);

    // Create session if it doesn't exist (for web-connected users)
    if (!session) {
      session = {
        transfer: {}
      };
      global.userSessions.set(userId, session);
    }

    if (!session.transfer) {
      session.transfer = {};
    }

    session.transfer.waitingForAmountInput = true;
    session.transfer.direction = 'from_trading';

    // Get selected token symbol from session
    const selectedToken = session.transfer.selectedToken || COMMON_TOKENS.BNB;

    await ctx.reply(
      `💰 Please enter the amount of ${selectedToken.symbol} you want to transfer to your main wallet:\n\n` +
      `Example: \`0.5\` for 0.5 ${selectedToken.symbol}`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle custom token address input
   */
  async handleCustomTokenInput(ctx: Context, direction: 'to_trading' | 'from_trading') {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    let session = global.userSessions.get(userId);

    // Create session if it doesn't exist
    if (!session) {
      session = {
        transfer: {}
      };
      global.userSessions.set(userId, session);
    }

    if (!session.transfer) {
      session.transfer = {};
    }

    session.transfer.waitingForCustomTokenAddress = true;
    session.transfer.direction = direction;

    const enterTokenAddress = await getTranslation(ctx, 'transfer.enterTokenAddress');
    const cancel = await getTranslation(ctx, 'common.cancel');

    await ctx.reply(
      `${enterTokenAddress}\n\n` +
      'Example: `0x55d398326f99059fF775485246999027B3197955` (USDT)',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 ' + cancel, callback_data: 'wallet_info' }]
          ]
        }
      }
    );
  }

  /**
   * Process custom token address and show amount selection
   */
  async processCustomTokenAddress(ctx: Context, tokenAddress: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);

    if (!session?.transfer?.direction) {
      await ctx.reply('❌ Error: Transfer direction not set. Please start over.');
      return;
    }

    const direction = session.transfer.direction;

    // Validate token address format
    if (!isValidTokenAddress(tokenAddress)) {
      const invalidTokenAddress = await getTranslation(ctx, 'transfer.invalidTokenAddress');
      await ctx.reply(invalidTokenAddress);
      return;
    }

    try {
      // Show loading message
      const loadingMsg = await ctx.reply('🔍 Fetching token information...');

      // Get token metadata
      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
      const metadata = await getTokenMetadata(tokenAddress, provider);

      // Create token info object
      const tokenInfo: TokenInfo = {
        address: tokenAddress,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals
      };

      // Delete loading message
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {
        // Ignore deletion errors
      }

      // Store token in session
      if (!session.transfer) {
        session.transfer = {};
      }
      session.transfer.selectedToken = tokenInfo;
      session.transfer.waitingForCustomTokenAddress = false;

      // Show amount selection menu
      if (direction === 'to_trading') {
        await this.showTransferToTradingMenu(ctx, tokenInfo);
      } else {
        await this.showTransferFromTradingMenu(ctx, tokenInfo);
      }
    } catch (error) {
      logger.error('Error fetching custom token metadata', { tokenAddress, error });

      const cancel = await getTranslation(ctx, 'common.cancel');
      await ctx.reply(
        '❌ Failed to fetch token information. Please make sure the address is correct and try again.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 ' + cancel, callback_data: 'wallet_info' }]
            ]
          }
        }
      );
    }
  }
}