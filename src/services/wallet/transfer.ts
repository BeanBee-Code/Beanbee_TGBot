import { Context } from 'telegraf';
import { ethers } from 'ethers';
import SignClient from '@walletconnect/sign-client';
import { getTranslation } from '@/i18n';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { createLogger } from '@/utils/logger';

const logger = createLogger('wallet.transfer');

export class TransferService {
  /**
   * Handle BNB transfer from main wallet to trading wallet
   * Supports both WalletConnect and web frontend connections
   */
  async handleTransferToTrading(ctx: Context, amount: string, backCallback?: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    const finalBackCallback = backCallback || session?.transfer?.backCallback || 'wallet_info';
    
    // Check if user has an active WalletConnect session
    if (session?.client && session?.address) {
      // Execute WalletConnect flow
      await this.handleWalletConnectTransfer(ctx, amount, session, finalBackCallback);
    } else {
      // Execute web frontend flow - generate task link
      await this.handleWebFrontendTransfer(ctx, amount, finalBackCallback);
    }
  }

  /**
   * Handle transfer via WalletConnect session
   */
  private async handleWalletConnectTransfer(ctx: Context, amount: string, session: any, backCallback: string) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer via WalletConnect session', { userId });

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
      const tx = {
        from: session.address,
        to: tradingWalletAddress,
        value: ethers.toQuantity(ethers.parseEther(amount)), // Convert to hex format
        data: '0x'
      };

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
        `📤 *Transfer BNB to Trading Wallet*\n\n` +
        `Amount: ${amount} BNB\n` +
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
        `${transferredMsg.replace('{amount}', amount)}\n\n` +
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
  private async handleWebFrontendTransfer(ctx: Context, amount: string, backCallback: string) {
    const userId = ctx.from!.id;
    logger.info('Generating transfer task link for web-connected user', { userId });
    
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
    const taskUrl = generateTransferLink(userId, tradingWalletAddress, amount, 'BNB', backCallback);

    // Get user language for localized messages
    const lang = await getUserLanguage(userId);
    const message = lang === 'zh'
      ? `➡️ **确认转账**\n\n请点击下方按钮，在您的网页钱包中确认将 **${amount} BNB** 从您的主钱包转入交易钱包。`
      : `➡️ **Confirm Transfer**\n\nPlease click the button below to confirm the transfer of **${amount} BNB** from your main wallet to your trading wallet in your web wallet.`;

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
   * Handle BNB transfer from trading wallet to main wallet
   * Supports both WalletConnect and web frontend connections
   */
  async handleTransferFromTrading(ctx: Context, amount: string, backCallback?: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    const finalBackCallback = backCallback || session?.transfer?.backCallback || 'wallet_info';
    
    // Check if user has an active WalletConnect session
    if (session?.client && session?.address) {
      // Execute WalletConnect flow
      await this.handleWalletConnectTransferFromTrading(ctx, amount, session, finalBackCallback);
    } else {
      // Execute web frontend flow for web-connected users
      await this.handleWebFrontendTransferFromTrading(ctx, amount, finalBackCallback);
    }
  }

  /**
   * Handle transfer from trading to main via WalletConnect session
   */
  private async handleWalletConnectTransferFromTrading(ctx: Context, amount: string, session: any, backCallback: string) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer from trading via WalletConnect', { userId });

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
      
      // Create transaction
      const tx = await tradingWallet.sendTransaction({
        to: session.address,
        value: ethers.parseEther(amount)
      });

      const transferTitle = await getTranslation(ctx, 'transfer.fromTradingTitle');
      const amountLabel = await getTranslation(ctx, 'transfer.amount');
      const fromLabel = await getTranslation(ctx, 'transfer.from');
      const toLabel = await getTranslation(ctx, 'transfer.to');
      const transactionSubmitted = await getTranslation(ctx, 'transfer.transactionSubmitted');
      
      const processingMessage = 
        `${transferTitle}\n\n` +
        `${amountLabel}: ${amount} BNB\n` +
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
        `${transferredMsg.replace('{amount}', amount)}\n\n` +
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
  private async handleWebFrontendTransferFromTrading(ctx: Context, amount: string, backCallback: string) {
    const userId = ctx.from!.id;
    logger.info('Executing transfer from trading for web-connected user', { userId });
    
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
      
      // Create transaction from trading wallet to main wallet
      const tx = await tradingWallet.sendTransaction({
        to: mainWalletAddress,
        value: ethers.parseEther(amount)
      });

      const transferTitle = await getTranslation(ctx, 'transfer.fromTradingTitle');
      const amountLabel = await getTranslation(ctx, 'transfer.amount');
      const fromLabel = await getTranslation(ctx, 'transfer.from');
      const toLabel = await getTranslation(ctx, 'transfer.to');
      const transactionSubmitted = await getTranslation(ctx, 'transfer.transactionSubmitted');
      
      const processingMessage = 
        `${transferTitle}\n\n` +
        `${amountLabel}: ${amount} BNB\n` +
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
        `${transferredMsg.replace('{amount}', amount)}\n\n` +
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
        [{ text: toTrading, callback_data: 'transfer_to_trading' }],
        [{ text: fromTrading, callback_data: 'transfer_from_trading' }],
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
   * @param backCallback - Optional callback data for the back button (defaults to 'transfer_menu')
   */
  async showTransferToTradingMenu(ctx: Context, backCallback: string = 'transfer_menu') {
    const userId = ctx.from!.id;

    // Store the back callback in the session
    const sessionForCallback = global.userSessions.get(userId);
    if (sessionForCallback) {
        if (!sessionForCallback.transfer) sessionForCallback.transfer = {};
        sessionForCallback.transfer.backCallback = backCallback;
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
        await ctx.answerCbQuery(noWalletMsg);
        return;
      }
    }

    // Import services
    const { UserService } = await import('../user');
    const { getBNBBalance, formatBNBBalance } = await import('./balance');
    
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      const noTradingMsg = await getTranslation(ctx, 'wallet.noTradingWallet');
      await ctx.answerCbQuery(noTradingMsg);
      return;
    }

    // Get main wallet balance using the address we found
    const mainBalance = await getBNBBalance(mainWalletAddress);
    

    await ctx.answerCbQuery();

    // Get translations
    const title = await getTranslation(ctx, 'transfer.title');
    const toTradingText = await getTranslation(ctx, 'transfer.toTrading');
    const availableBalance = await getTranslation(ctx, 'transfer.availableBalance');
    const selectAmount = await getTranslation(ctx, 'transfer.selectAmount');
    const customAmount = await getTranslation(ctx, 'transfer.customAmount');
    const cancel = await getTranslation(ctx, 'common.cancel');

    const keyboard = {
      inline_keyboard: [
        // Quick transfer amounts
        [
          { text: '0.01 BNB', callback_data: 'transfer_0.01' },
          { text: '0.05 BNB', callback_data: 'transfer_0.05' },
          { text: '0.1 BNB', callback_data: 'transfer_0.1' },
          { text: '0.5 BNB', callback_data: 'transfer_0.5' }
        ],
        // Percentage buttons
        [
          { text: '25%', callback_data: 'transfer_percent_25' },
          { text: '50%', callback_data: 'transfer_percent_50' },
          { text: '75%', callback_data: 'transfer_percent_75' },
          { text: '100%', callback_data: 'transfer_percent_100' }
        ],
        [
          { text: customAmount, callback_data: 'transfer_custom_to_trading' }
        ],
        [{ text: '🔙 ' + cancel, callback_data: backCallback }]
      ]
    };

    await ctx.editMessageText(
      `${title} ${toTradingText}\n\n` +
      `${availableBalance} ${formatBNBBalance(mainBalance)} BNB\n\n` +
      `${selectAmount}`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  }

  /**
   * Show transfer amount selection menu for Trading to Main
   * @param ctx - Telegraf context
   * @param backCallback - Optional callback data for the back button (defaults to 'transfer_menu')
   */
  async showTransferFromTradingMenu(ctx: Context, backCallback: string = 'transfer_menu') {
    const userId = ctx.from!.id;

    // Store the back callback in the session
    const sessionForCallback = global.userSessions.get(userId);
    if (sessionForCallback) {
        if (!sessionForCallback.transfer) sessionForCallback.transfer = {};
        sessionForCallback.transfer.backCallback = backCallback;
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
        await ctx.answerCbQuery(noWalletMsg);
        return;
      }
    }

    // Import services
    const { UserService } = await import('../user');
    const { getBNBBalance, formatBNBBalance } = await import('./balance');
    
    const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
    if (!tradingWalletAddress) {
      const noTradingMsg = await getTranslation(ctx, 'wallet.noTradingWallet');
      await ctx.answerCbQuery(noTradingMsg);
      return;
    }

    // Get trading wallet balance
    const tradingBalance = await getBNBBalance(tradingWalletAddress);
    

    await ctx.answerCbQuery();

    // Get translations
    const title = await getTranslation(ctx, 'transfer.title');
    const fromTradingText = await getTranslation(ctx, 'transfer.fromTrading');
    const availableBalance = await getTranslation(ctx, 'transfer.availableBalance');
    const selectAmount = await getTranslation(ctx, 'transfer.selectAmount');
    const customAmount = await getTranslation(ctx, 'transfer.customAmount');
    const cancel = await getTranslation(ctx, 'common.cancel');

    const keyboard = {
      inline_keyboard: [
        // Quick transfer amounts
        [
          { text: '0.01 BNB', callback_data: 'transfer_from_0.01' },
          { text: '0.05 BNB', callback_data: 'transfer_from_0.05' },
          { text: '0.1 BNB', callback_data: 'transfer_from_0.1' },
          { text: '0.5 BNB', callback_data: 'transfer_from_0.5' }
        ],
        // Percentage buttons
        [
          { text: '25%', callback_data: 'transfer_from_percent_25' },
          { text: '50%', callback_data: 'transfer_from_percent_50' },
          { text: '75%', callback_data: 'transfer_from_percent_75' },
          { text: '100%', callback_data: 'transfer_from_percent_100' }
        ],
        [
          { text: customAmount, callback_data: 'transfer_custom_from_trading' }
        ],
        [{ text: '🔙 ' + cancel, callback_data: backCallback }]
      ]
    };

    await ctx.editMessageText(
      `${title} ${fromTradingText}\n\n` +
      `${availableBalance} ${formatBNBBalance(tradingBalance)} BNB\n\n` +
      `${selectAmount}`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
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

    await ctx.reply(
      '💰 Please enter the amount of BNB you want to transfer to your main wallet:\n\n' +
      'Example: `0.5` for 0.5 BNB',
      { parse_mode: 'Markdown' }
    );
  }
}