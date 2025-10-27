// Polyfill for crypto.getRandomValues (required for WalletConnect in Node.js)
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
    // @ts-ignore
    globalThis.crypto = webcrypto;
}

import dotenv from "dotenv";
import { TelegramBot, bot as botExport } from './telegram/bot';
import { connectDatabase } from './database/connection';
import { initMoralis } from './services/moralis';
import { createLogger } from './utils/logger';

dotenv.config();

const logger = createLogger('main');

// Keep track of recently seen errors to prevent duplicate handling
const recentErrors = new Set<string>();
const ERROR_CACHE_TIME = 1000; // 1 second

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason: any, promise) => {
    // Check if this is a WalletConnect session error
    const errorMessage = reason?.message || String(reason);
    const errorStack = reason?.stack || '';
    
    // Create a unique error key
    const errorKey = `${errorMessage}-${Date.now()}`;
    
    // Check if we've already seen this error recently
    if (recentErrors.has(errorMessage)) {
        return; // Skip duplicate errors
    }
    
    // Add to recent errors and clear after timeout
    recentErrors.add(errorMessage);
    setTimeout(() => recentErrors.delete(errorMessage), ERROR_CACHE_TIME);
    
    const walletConnectErrors = [
        'No matching key',
        'session topic doesn\'t exist',
        'No matching session',
        'isValidSessionTopic',
        'onSessionEventRequest',
        'onSessionUpdateRequest',
        'isValidUpdate',
        'isValidEmit',
        'session:',
        'getData',
        'proposal:',
        'onSessionProposeResponse',
        '@walletconnect',
        'onSessionEvent',
        'processRequest',
        'onRelayMessage'
    ];
    
    if (walletConnectErrors.some(err => errorMessage.includes(err) || errorStack.includes(err))) {
        // Don't even log these - they're too noisy
        return; // Ignore these errors as they're expected when sessions expire
    }
    
    logger.error('Unhandled Rejection at:', { promise, reason });
    // Don't exit the process, just log the error
});

process.on('uncaughtException', (error: any) => {
    const errorMessage = error?.message || String(error);
    const errorStack = error?.stack || '';
    
    // Check if we've already seen this error recently
    if (recentErrors.has(errorMessage)) {
        return; // Skip duplicate errors
    }
    
    const walletConnectErrors = [
        'No matching key',
        'session topic doesn\'t exist',
        'No matching session',
        'isValidSessionTopic',
        'onSessionEventRequest',
        'onSessionUpdateRequest',
        'isValidUpdate',
        'isValidEmit',
        'session:',
        'getData',
        'proposal:',
        'onSessionProposeResponse',
        '@walletconnect',
        'onSessionEvent',
        'processRequest',
        'onRelayMessage'
    ];
    
    if (walletConnectErrors.some(err => errorMessage.includes(err) || errorStack.includes(err))) {
        // Don't even log these - they're too noisy
        return; // Ignore these errors
    }
    
    logger.error('Uncaught Exception:', { error });
    // Don't exit the process for now during debugging
    // process.exit(1);
});

// Validation
if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set');
    throw new Error('TELEGRAM_BOT_TOKEN is not set')
}

if (!process.env.PROJECT_ID) {
    logger.error('PROJECT_ID is not set');
    throw new Error('PROJECT_ID is not set')
}

if (!process.env.MORALIS_API_KEY) {
    logger.error('MORALIS_API_KEY is not set');
    throw new Error('MORALIS_API_KEY is not set')
}

// Warn if sensitive values are using defaults (for production safety)
if (process.env.NODE_ENV === 'production') {
    // Check if NodeReal API key is configured
    if (!process.env.NODEREAL_API_KEY) {
        logger.warn('NODEREAL_API_KEY not set - opBNB features may not work');
    }
    
    // Check if honey deposit addresses are configured
    if (!process.env.HONEY_MAIN_DEPOSIT_ADDRESS) {
        logger.warn('HONEY_MAIN_DEPOSIT_ADDRESS not set - using default address');
    }
    
    if (!process.env.HONEY_REFERRAL_DEPOSIT_ADDRESS) {
        logger.warn('HONEY_REFERRAL_DEPOSIT_ADDRESS not set - using default address');
    }
    
    // Check if Binance Wallet configuration is set
    if (!process.env.BINANCE_WALLET_APP_ID) {
        logger.warn('BINANCE_WALLET_APP_ID not set - using default configuration');
    }
}

async function startApplication() {
    try {
        logger.info('Starting application...');
        
        // Start API server FIRST for Cloud Run health checks
        const { startApiServer } = await import('./api/server');
        await startApiServer();
        logger.info('✅ API server started - Cloud Run health checks will pass');
        
        // Initialize other services in the background
        logger.info('Initializing database and services...');
        await connectDatabase();
        logger.info('✅ Database connected');
        
        await initMoralis();
        logger.info('✅ Moralis initialized');

        const botInstance = new TelegramBot();
        
        // Set the global bot export for notification services and API
        (globalThis as any).botExport = botInstance;
        
        // Start Telegram bot
        await botInstance.start();
        logger.info('✅ Telegram bot started');

        logger.info('🚀 Application started successfully');
    } catch (error: any) {
        if (error.message?.includes('Conflict: terminated by other getUpdates request')) {
            logger.error('Another instance of the bot is already running', {
                message: 'Please stop the existing bot instance before starting a new one.'
            });
            process.exit(1);
        }
        logger.error('Failed to start application', error);
        process.exit(1);
    }
}

startApplication();

// Graceful shutdown
const stopApplication = async () => {
    try {
        logger.info('🛑 Shutting down application...');
        // Bot cleanup will be handled in TelegramBot class
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
    }
};

process.once('SIGINT', stopApplication);
process.once('SIGTERM', stopApplication);