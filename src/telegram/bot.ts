import { Telegraf } from 'telegraf';
import { WalletService } from '../services/wallet/connect';
import { setGlobalWalletService } from '../services/wallet';
import { TradingService } from '../services/trading';
import { ScannerService } from '../services/wallet/scanner';
import { RugAlertsService } from '../services/rugAlerts';
import { NotificationScheduler } from '../services/notifications/scheduler';
import { WebSocketService } from '../services/rpc/websocketService';
import { WalletTrackingMonitor } from '../services/walletTrackingMonitor';
import { UserSession } from '../types';
import { setupCommands } from './handlers/commands';
import { setupCallbacks } from './handlers/callbacks';
import { setupMessages } from './handlers/messages';
import { createLogger } from '../utils/logger';

const logger = createLogger('telegram.bot');

export class TelegramBot {
	private bot: Telegraf;
	private walletService: WalletService;
	private tradingService: TradingService;
	private scannerService: ScannerService;
	private rugAlertsService: RugAlertsService;
	private notificationScheduler: NotificationScheduler;
	private webSocketService: WebSocketService;
	private walletTrackingMonitor: WalletTrackingMonitor;
	private userSessions: Map<number, UserSession>;

	// Getter to expose the bot instance
	public getBot(): Telegraf {
		return this.bot;
	}

	constructor() {
		this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
			handlerTimeout: 900000, // 15 minutes timeout
		});
		this.userSessions = new Map();

		// Initialize services
		this.walletService = new WalletService(this.userSessions);
		this.tradingService = new TradingService();
		this.scannerService = new ScannerService();
		this.rugAlertsService = new RugAlertsService();
		this.notificationScheduler = new NotificationScheduler(this.bot);
		this.webSocketService = new WebSocketService();
		this.walletTrackingMonitor = WalletTrackingMonitor.getInstance();

		// Make sessions globally available for backwards compatibility
		global.userSessions = this.userSessions;
		
		// Set the global wallet service instance
		setGlobalWalletService(this.walletService);

		this.setupHandlers();
		this.setupCommands();
	}

	private setupHandlers() {
		setupCommands(this.bot, this.walletService);
		setupCallbacks(
			this.bot,
			this.walletService,
			this.tradingService,
			this.scannerService,
			this.rugAlertsService
		);
		setupMessages(
			this.bot,
			this.scannerService,
			this.tradingService,
			this.rugAlertsService
		);
	}

	private setupCommands() {
		// Set commands with error handling to avoid rate limits
		this.bot.telegram.setMyCommands([
			{ command: 'start', description: 'Start the bot' },
			{ command: 'settings', description: 'Bot settings' },
		]).catch((error) => {
			if (error.response?.error_code === 429) {
				logger.warn('Rate limited when setting commands, will retry later');
			} else {
				logger.error('Error setting bot commands', { error });
			}
		});
	}

	async start() {
		try {
			// --- Step 1: Clean up and restore core services ---
			logger.info('Cleaning up stale WalletConnect data...');
			try {
				// Clear SignClient instances but NOT the storage (we want to keep sessions)
				const { SignClientManager } = await import('../services/wallet/signClientManager');
				await SignClientManager.clearAll();
				
				// Only clean up OLD entries, not all storage
				const { walletConnectStorage } = await import('../services/wallet/walletConnectStorage');
				const deletedCount = await walletConnectStorage.cleanupOldEntries(7); // Clean up entries older than 7 days
				if (deletedCount > 0) {
					logger.info(`🧹 Cleaned up ${deletedCount} old WalletConnect storage entries`);
				}
				logger.info('WalletConnect cleanup completed');
			} catch (error) {
				logger.error('Failed to cleanup WalletConnect data', { error });
			}

			// Restore wallet sessions
			logger.info('Restoring wallet sessions...');
			try {
				await this.walletService.restoreAllSessions();
				logger.info('Wallet sessions restored successfully');
			} catch (error) {
				logger.error('Failed to restore wallet sessions', { error });
			}

			// --- Step 2: Start all background schedulers and services ---
			logger.info('Starting notification scheduler...');
			this.notificationScheduler.start();
			logger.info('Notification scheduler has been started');

			// Start WebSocket service to monitor BSC transactions
			logger.info('Starting WebSocket service...');
			this.webSocketService.connect();
			logger.info('WebSocket service has been started');

			// Initialize wallet tracking monitor
			logger.info('Initializing wallet tracking monitor...');
			this.walletTrackingMonitor.initialize().then(() => {
				logger.info('Wallet tracking monitor has been initialized');
			}).catch((error) => {
				logger.error('Failed to initialize wallet tracking monitor', { error });
			});

			// Initialize token price monitor
			logger.info('Initializing token price monitor...');
			import('../services/tokenPriceMonitor').then(async ({ tokenPriceMonitor }) => {
				try {
					await tokenPriceMonitor.initialize();
					logger.info('Token price monitor has been initialized');
				} catch (error) {
					logger.error('Failed to initialize token price monitor', { error });
				}
			}).catch((error) => {
				logger.error('Failed to import token price monitor', { error });
			});

			// Initialize leaderboard scheduler
			logger.info('Initializing leaderboard scheduler...');
			try {
				const { LeaderboardScheduler } = await import('../services/leaderboardScheduler');
				LeaderboardScheduler.start();
				logger.info('Leaderboard scheduler has been initialized');
			} catch (error) {
				logger.error('Failed to initialize leaderboard scheduler', { error });
			}

			logger.info('Bot background services initialization completed');
			
			// --- Step 3: Finally, start the bot message polling ---
			await this.bot.launch();
			
			const me = await this.bot.telegram.getMe();
			logger.info(`🤖 Bot is running... @${me.username}`);

			// Set up periodic cleanup of old WalletConnect storage entries (every 24 hours)
			setInterval(async () => {
				try {
					const { walletConnectStorage } = await import('../services/wallet/walletConnectStorage');
					const deletedCount = await walletConnectStorage.cleanupOldEntries(30);
					if (deletedCount > 0) {
						logger.info(`Cleaned up ${deletedCount} old WalletConnect storage entries`);
					}
				} catch (error) {
					logger.error('Failed to cleanup WalletConnect storage', { error });
				}
			}, 24 * 60 * 60 * 1000); // 24 hours
		} catch (error) {
			logger.error('Failed to launch bot', { error });
			// If bot launch fails due to network issues, try again
			if (error instanceof Error && (error.message.includes('TLS') || error.message.includes('ECONNRESET'))) {
				logger.info('Retrying bot launch due to network error...');
				try {
					await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
					await this.bot.launch();
					logger.info('🤖 Bot launched successfully on retry');
				} catch (retryError) {
					logger.error('Failed to launch bot on retry', { retryError });
					throw retryError;
				}
			} else {
				throw error;
			}
		}

		// Graceful stop handlers
		process.once('SIGINT', () => this.stop('SIGINT'));
		process.once('SIGTERM', () => this.stop('SIGTERM'));
	}

	private async stop(signal: string) {
		logger.info(`🛑 Received ${signal}, stopping bot...`);
		this.notificationScheduler.stop();
		await this.webSocketService.disconnect();
		await this.walletTrackingMonitor.shutdown();
		
		// Stop token price monitor
		try {
			const { tokenPriceMonitor } = await import('../services/tokenPriceMonitor');
			await tokenPriceMonitor.stop();
			logger.info('Token price monitor has been stopped');
		} catch (error) {
			logger.error('Failed to stop token price monitor', { error });
		}
		
		// Stop leaderboard scheduler
		try {
			const { LeaderboardScheduler } = await import('../services/leaderboardScheduler');
			LeaderboardScheduler.stop();
			logger.info('Leaderboard scheduler has been stopped');
		} catch (error) {
			logger.error('Failed to stop leaderboard scheduler', { error });
		}
		
		this.bot.stop(signal);
	}

	get telegram() {
		return this.bot.telegram;
	}
}

// Export the bot instance for use in notification services
export let bot: TelegramBot;