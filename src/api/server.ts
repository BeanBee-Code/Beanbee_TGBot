import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { UserService } from '../services/user';
import { createLogger } from '../utils/logger';
import { getUserLanguage, t } from '../i18n';
import { Context } from 'telegraf';
import { mainMenu } from '../telegram/menus/main';

const logger = createLogger('api.server');

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS configuration using cors middleware
app.use(cors({
  origin: '*', // In production, consider specifying the frontend domain: 'https://connect.beanbee.ai'
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning'],
}));

// Store temporary tokens for wallet connection verification
const connectionTokens = new Map<string, { userId: number; expires: number; origin?: string }>();

// Clean up expired tokens every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of connectionTokens.entries()) {
        if (data.expires < now) {
            connectionTokens.delete(token);
        }
    }
}, 5 * 60 * 1000);

/**
 * Generate a secure connection token for a user
 * Returns the complete connection URL
 */
export function generateConnectionLink(userId: number): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes expiration
    connectionTokens.set(token, { userId, expires });
    
  const frontendUrl = process.env.FRONTEND_URL || 'https://connect.beanbee.ai';
    return `${frontendUrl}/?token=${token}`;
}

/**
 * Generate a secure transfer token for a user
 * Returns the complete transfer URL with action parameters
 */
export function generateTransferLink(userId: number, to: string, amount: string, token: string = 'BNB', origin?: string): string {
    const secureToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes expiration
    connectionTokens.set(secureToken, { userId, expires, origin });
    
  const frontendUrl = process.env.FRONTEND_URL || 'https://connect.beanbee.ai';
    const taskUrl = new URL(frontendUrl);
    taskUrl.searchParams.set('token', secureToken);
    taskUrl.searchParams.set('action', 'transfer');
    taskUrl.searchParams.set('to', to);
    taskUrl.searchParams.set('amount', amount);
    taskUrl.searchParams.set('tokenSymbol', token);
    if (origin) {
        taskUrl.searchParams.set('origin', origin);
    }
    
    return taskUrl.toString();
}

/**
 * Get the API base URL
 */
export function getApiBaseUrl(): string {
    const baseUrl = process.env.API_BASE_URL || `http://localhost:${PORT}`;
    return baseUrl.replace(/\/$/, ''); // Remove trailing slash
}

// API Routes

// Root health check for Cloud Run startup probes
app.get('/', (_, res) => {
    res.status(200).json({ 
        status: 'ok', 
        service: 'beanbee-tgbot',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0'
    });
});

// Enhanced health check endpoint  
app.get('/api/health', (_, res) => {
    res.status(200).json({ 
        status: 'ok', 
        service: 'beanbee-tgbot',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: process.env.NODE_ENV || 'development',
        port: process.env.PORT || 4000
    });
});

// Connect wallet endpoint - receives wallet data from frontend
app.post('/api/connect-wallet', async (req, res) => {
  const { token, walletAddress } = req.body;

  logger.info('Received /api/connect-wallet request', { token: token?.substring(0, 8) + '...', walletAddress });

  // 1. Validate the incoming data
  if (!token || !walletAddress) {
    return res.status(400).json({ success: false, message: 'Token and walletAddress are required.' });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ success: false, message: 'Invalid wallet address format.' });
  }

  // 2. Validate the token
  const tokenData = connectionTokens.get(token);
  if (!tokenData || tokenData.expires < Date.now()) {
    logger.warn('Invalid or expired token attempt', { token: token?.substring(0, 8) + '...' });
    return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
  }

  // Token is valid, immediately delete it to prevent reuse
  connectionTokens.delete(token);
  const { userId } = tokenData;

  try {
    // 3. Update the user's wallet address in the database
    await UserService.updateMainWalletAddress(userId, walletAddress);
    logger.info('Successfully updated wallet address in DB', { userId, walletAddress });

    // 4. Send a confirmation message back to the user in Telegram
    const botInstance = (globalThis as any).botExport;
    if (botInstance) {
      const lang = await getUserLanguage(userId);
      const message = t(lang, 'wallet.walletConnectedDesc') + `\n\n✅ Address: \`${walletAddress}\``;
      
      await botInstance.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown',
      });
      
      // Create a minimal context object to refresh the main menu
      const mockCtx = {
        from: { id: userId },
        chat: { id: userId },
        // These methods are needed for mainMenuEdit to work
        editMessageText: (text: string, extra: any) => 
            botInstance.telegram.sendMessage(userId, text, extra),
        answerCbQuery: () => Promise.resolve(true),
        reply: (text: string, extra: any) =>
            botInstance.telegram.sendMessage(userId, text, extra),
      } as unknown as Context;

      // Automatically show the updated main menu
      await mainMenu(mockCtx);

      logger.info('Sent confirmation message and refreshed menu for user', { userId });
    } else {
      logger.error('Bot instance not found, could not send confirmation message.');
    }

    // 5. Send a success response to the frontend
    return res.status(200).json({ success: true, message: 'Wallet connected successfully.' });

  } catch (error) {
    logger.error('Error in /api/connect-wallet endpoint', { error });
    return res.status(500).json({ success: false, message: 'An internal server error occurred.' });
  }
});

// Transaction feedback endpoint - receives transaction status from frontend
app.post('/api/transaction-feedback', async (req, res) => {
  const { token, action, status, txHash, error } = req.body;

  logger.info('Received transaction feedback from frontend', { token: token?.substring(0, 8) + '...', action, status, txHash });

  if (!token || !action || !status) {
    return res.status(400).json({ success: false, message: 'Missing required parameters.' });
  }

  // Validate the token
  const tokenData = connectionTokens.get(token);
  if (!tokenData || tokenData.expires < Date.now()) {
    logger.warn('Invalid or expired token attempt for transaction feedback', { token: token?.substring(0, 8) + '...' });
    return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
  }

  // Token is valid, immediately delete it to prevent reuse
  const { userId, origin } = tokenData;
  connectionTokens.delete(token);

  try {
    const botInstance = (globalThis as any).botExport;
    const lang = await getUserLanguage(userId);

    if (botInstance) {
      let message = '';
      let keyboard;
      if (status === 'success') {
        // Transaction successful
        message = lang === 'zh'
          ? `✅ **转账成功！**\n\n交易已广播到网络。\n哈希: \`${txHash}\`\n[在BSCScan上查看](https://bscscan.com/tx/${txHash})`
          : `✅ **Transfer Successful!**\n\nThe transaction has been broadcast to the network.\nHash: \`${txHash}\`\n[View on BSCScan](https://bscscan.com/tx/${txHash})`;
        
        // Determine which button to show based on origin
        const backCallback = origin || 'main_menu';
        const backButtonText = lang === 'zh' 
            ? (backCallback === 'honey_recharge' ? '🍯 返回购买 Honey' : '🏠 主菜单')
            : (backCallback === 'honey_recharge' ? '🍯 Back to Buy Honey' : '🏠 Main Menu');
        
        keyboard = {
            inline_keyboard: [
                [{ text: backButtonText, callback_data: backCallback }]
            ]
        };
      } else {
        // Transaction failed or rejected
        const reason = error || (lang === 'zh' ? '未知错误' : 'Unknown error');
        message = lang === 'zh'
          ? `❌ **转账失败**\n\n原因: ${reason}\n请返回Telegram重试。`
          : `❌ **Transfer Failed**\n\nReason: ${reason}\nPlease return to Telegram to try again.`;
        
        // Show back button for failed transactions too
        const backCallback = origin || 'main_menu';
        const backButtonText = lang === 'zh' ? '🔙 返回' : '🔙 Back';
        keyboard = {
            inline_keyboard: [
                [{ text: backButtonText, callback_data: backCallback }]
            ]
        };
      }
      
      await botInstance.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });

    } else {
      logger.error('Bot instance not found, could not send feedback message.');
    }

    return res.status(200).json({ success: true, message: 'Feedback received.' });
  } catch (err) {
    logger.error('Error in /api/transaction-feedback endpoint', { err });
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// Start server
export async function startApiServer() {
    return new Promise<void>((resolve) => {
        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`API server started on port ${PORT}`);
            logger.info(`Server listening on all interfaces (0.0.0.0:${PORT})`);
            resolve();
        });
    });
}

// Export for use in tests
export { app };