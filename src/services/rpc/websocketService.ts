import { ethers } from 'ethers';
import { createLogger } from '@/utils/logger';
import { TransactionDecoder, DecodedTransaction, TransactionType } from './transactionDecoder';
import { preloadCommonTokens } from '../wallet/tokenInfoCache';

const logger = createLogger('rpc.websocket');

// The Transfer event signature for ERC20 tokens
const TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Common DEX contract addresses on BSC
const DEX_CONTRACTS = {
    PANCAKESWAP_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    PANCAKESWAP_V3_ROUTER: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    BISWAP_ROUTER: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
    BAKERY_ROUTER: '0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F'
};

// Simplified transaction listener type - no longer passes log object
type TransactionListener = (tx: ethers.TransactionResponse, decoded: DecodedTransaction) => Promise<void>;

interface WalletActivity {
    tx: ethers.TransactionResponse;
    decoded: DecodedTransaction;
    timestamp: number;
    logIndex: number;
}

interface TransactionStats {
    totalEventsProcessed: number;
    transferEvents: number;
    dexSwaps: number;
    liquidityOps: number;
    highRiskTxs: number;
    watchedWalletEvents: number;
    tokenTrackingEvents: number;
}

export class WebSocketService {
    private provider: ethers.WebSocketProvider | null = null;
    private listeners: TransactionListener[] = [];
    private decoder: TransactionDecoder;
    private isConnected = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private readonly reconnectDelay = 5000;

    // Wallet tracking features
    private watchedWallets = new Set<string>();
    private walletFilters = new Map<string, { fromFilter: any, toFilter: any }>();
    private walletActivity = new Map<string, WalletActivity[]>();
    
    // Token tracking features
    private trackedTokens = new Map<string, any>(); // token address -> filter
    
    // Transaction processing cache to avoid duplicates
    private processedTxHashes = new Set<string>();
    private readonly maxCacheSize = 10000;
    
    // Statistics
    private stats: TransactionStats = {
        totalEventsProcessed: 0,
        transferEvents: 0,
        dexSwaps: 0,
        liquidityOps: 0,
        highRiskTxs: 0,
        watchedWalletEvents: 0,
        tokenTrackingEvents: 0
    };

    constructor() {
        this.decoder = new TransactionDecoder();
        // Pre-load common tokens for faster symbol lookup
        preloadCommonTokens();
        logger.info('🚀 WebSocket service initialized with hybrid monitoring (event logs + native transfers)');
    }

    public connect(): void {
        if (this.isConnected || !process.env.QUICKNODE_BSC_WSS_URL) {
            if (!process.env.QUICKNODE_BSC_WSS_URL) {
                logger.warn('QUICKNODE_BSC_WSS_URL is not set. Optimized WebSocket service disabled.');
            }
            return;
        }

        if (!this.validateWebSocketUrl(process.env.QUICKNODE_BSC_WSS_URL)) {
            logger.error('Invalid WebSocket URL format. Optimized WebSocket service disabled.');
            return;
        }

        logger.info('🔌 Connecting to BSC WebSocket with hybrid monitoring (event logs + native transfers)...');
        this.provider = new ethers.WebSocketProvider(process.env.QUICKNODE_BSC_WSS_URL);
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        if (!this.provider) return;

        logger.info('🎧 Setting up hybrid event listeners (logs + native transfers)...');

        // Native BNB transfer detection via block monitoring
        this.provider.on('block', this.handleNewBlock.bind(this));

        // Network and error listeners
        this.provider.on('network', (newNetwork, oldNetwork) => {
            if (oldNetwork) {
                logger.info('Network changed:', { from: oldNetwork.name, to: newNetwork.name });
            } else {
                logger.info('Connected to network:', newNetwork.name);
                this.isConnected = true;
                this.reconnectAttempts = 0;
            }
        });

        this.provider.on('error', (error) => {
            logger.error('Provider error:', error);
            this.isConnected = false;
            this.handleReconnect();
        });

        logger.info('✅ Hybrid event listeners configured. Wallet/token filters will be added dynamically.');
    }

    /**
     * Handle new blocks to detect native BNB transfers
     * This catches native transfers that don't emit Transfer events
     */
    private async handleNewBlock(blockNumber: number): Promise<void> {
        if (this.watchedWallets.size === 0) {
            return; // No wallets to watch, skip processing
        }

        try {
            // Log every 20 blocks for basic stats
            if (blockNumber % 20 === 0) {
                logger.info(`📦 Block ${blockNumber} | Stats: ${JSON.stringify(this.getStats())}`);
            }

            // OPTIMIZATION: Skip most blocks to reduce API usage (scan every 10th block)
            // WebSocket event listeners will catch most transactions, this is just a backup
            if (blockNumber % 10 !== 0) {
                return;
            }

            // Fetch the block with transaction details (only every 10th block now)
            const block = await this.provider!.getBlock(blockNumber, true);
            if (!block || !block.prefetchedTransactions) return;

            logger.debug(`🔍 Scanning block ${blockNumber} with ${block.prefetchedTransactions.length} transactions for watched wallets`);

            for (const tx of block.prefetchedTransactions) {
                // Check if this transaction involves any of our watched wallets
                const from = tx.from?.toLowerCase();
                const to = tx.to?.toLowerCase();
                const isWatched = (from && this.watchedWallets.has(from)) || (to && this.watchedWallets.has(to));

                // Process ALL transactions for watched wallets (native BNB + ERC-20 tokens + contract interactions)
                // The processedTxHashes set prevents double-counting from event listeners
                if (isWatched) {
                    // Avoid processing if we already handled it
                    if (this.processedTxHashes.has(tx.hash)) {
                        continue;
                    }
                    
                    this.processedTxHashes.add(tx.hash);
                    this.cleanupProcessedCache();

                    // Determine transaction type for logging
                    const isNativeTransfer = !tx.data || tx.data === '0x';
                    const txType = isNativeTransfer ? 'Native BNB' : 'Contract interaction (likely token)';
                    
                    logger.info(`🔍 Watched wallet transaction detected in block ${blockNumber}`, { 
                        hash: tx.hash,
                        type: txType,
                        from,
                        to,
                        value: ethers.formatEther(tx.value || 0),
                        hasData: !isNativeTransfer
                    });
                    
                    // Decode and process the transaction
                    const decoded = await this.decoder.decodeTransaction(tx);
                    this.updateStats(decoded, 'wallet');

                    // Determine which wallet is involved
                    const involvedWallet = from && this.watchedWallets.has(from) ? from : to!;
                    // Record activity for all transaction types
                    const activity = this.walletActivity.get(involvedWallet) || [];
                    activity.push({
                        tx,
                        decoded,
                        timestamp: Date.now(),
                        logIndex: -1 // Block-based detection doesn't have log index
                    });
                    if (activity.length > 100) {
                        activity.splice(0, activity.length - 100);
                    }
                    this.walletActivity.set(involvedWallet, activity);

                    // Notify listeners with simplified signature
                    for (const listener of this.listeners) {
                        try {
                            await listener(tx, decoded);
                        } catch (error) {
                            logger.error('Error in transaction listener:', { error, txHash: tx.hash });
                        }
                    }
                }
            }

        } catch (error) {
            logger.error('Error processing block for native transfers', { blockNumber, error });
        }
    }

    /**
     * Add a wallet to watch for all transfers (in and out)
     * This replaces the inefficient pending transaction monitoring
     */
    public addWalletToWatch(address: string): void {
        if (!this.provider) {
            logger.warn('Provider not connected, cannot add wallet to watch list.');
            return;
        }

        const normalizedAddress = address.toLowerCase();
        if (this.watchedWallets.has(normalizedAddress)) {
            logger.info(`Wallet ${address} is already being watched.`);
            return;
        }

        this.watchedWallets.add(normalizedAddress);

        // Create filters for transfers FROM and TO the watched address
        const paddedAddress = ethers.zeroPadValue(address, 32);
        
        // Filter for transfers FROM the watched address (sender)
        const fromFilter = {
            topics: [TRANSFER_EVENT_SIGNATURE, paddedAddress, null]
        };

        // Filter for transfers TO the watched address (receiver)
        const toFilter = {
            topics: [TRANSFER_EVENT_SIGNATURE, null, paddedAddress]
        };

        // Handler for both types of transfers
        const onTransfer = async (log: ethers.Log) => {
            await this.handleTransferEvent(log, normalizedAddress, 'wallet');
        };

        // Register the filters
        this.provider.on(fromFilter, onTransfer);
        this.provider.on(toFilter, onTransfer);

        // Store filters for cleanup
        this.walletFilters.set(normalizedAddress, { fromFilter, toFilter });

        // Initialize activity tracking
        if (!this.walletActivity.has(normalizedAddress)) {
            this.walletActivity.set(normalizedAddress, []);
        }

        logger.info(`👀 Started monitoring transfers for wallet: ${address}`);
        logger.info(`📊 Now watching ${this.watchedWallets.size} wallets`);
    }

    /**
     * Add a token to track for all transfer activity
     * Useful for monitoring buys/sells of specific tokens
     */
    public addTokenToTrack(tokenAddress: string, tokenSymbol?: string): void {
        if (!this.provider) {
            logger.warn('Provider not connected, cannot add token to tracking.');
            return;
        }

        const normalizedTokenAddress = tokenAddress.toLowerCase();
        if (this.trackedTokens.has(normalizedTokenAddress)) {
            logger.info(`Token ${tokenAddress} is already being tracked.`);
            return;
        }

        // Filter for all Transfer events on this specific token contract
        const tokenFilter = {
            address: tokenAddress,
            topics: [TRANSFER_EVENT_SIGNATURE]
        };

        const onTokenTransfer = async (log: ethers.Log) => {
            await this.handleTransferEvent(log, normalizedTokenAddress, 'token');
        };

        this.provider.on(tokenFilter, onTokenTransfer);
        this.trackedTokens.set(normalizedTokenAddress, tokenFilter);

        const displayName = tokenSymbol ? `${tokenSymbol} (${tokenAddress})` : tokenAddress;
        logger.info(`🪙 Started tracking token transfers for: ${displayName}`);
        logger.info(`📊 Now tracking ${this.trackedTokens.size} tokens`);
    }

    /**
     * Core event handler for Transfer events
     * This is called for both wallet and token tracking
     */
    private async handleTransferEvent(log: ethers.Log, trackedItem: string, trackingType: 'wallet' | 'token'): Promise<void> {
        try {
            // Avoid processing the same transaction multiple times
            if (this.processedTxHashes.has(log.transactionHash)) {
                return;
            }

            // Get the full transaction for analysis
            const tx = await this.provider!.getTransaction(log.transactionHash);
            if (!tx) return;

            // Mark as processed
            this.processedTxHashes.add(log.transactionHash);
            this.cleanupProcessedCache();

            // Decode the transaction
            const decoded = await this.decoder.decodeTransaction(tx);

            // Update statistics
            this.updateStats(decoded, trackingType);

            // Record activity if it's a wallet transfer
            if (trackingType === 'wallet') {
                this.recordWalletActivity(trackedItem, tx, decoded, log);
            }

            // Enhanced logging
            this.logTransferEvent(log, tx, decoded, trackedItem, trackingType);

            // Notify listeners with simplified signature
            for (const listener of this.listeners) {
                try {
                    await listener(tx, decoded);
                } catch (error) {
                    logger.error('Error in transaction listener:', { error, txHash: tx.hash });
                }
            }

        } catch (error) {
            logger.debug('Failed to process transfer event:', {
                txHash: log.transactionHash,
                error: error instanceof Error ? error.message : error
            });
        }
    }

    private updateStats(decoded: DecodedTransaction, trackingType: 'wallet' | 'token'): void {
        this.stats.totalEventsProcessed++;
        this.stats.transferEvents++;
        
        if (trackingType === 'wallet') {
            this.stats.watchedWalletEvents++;
        } else {
            this.stats.tokenTrackingEvents++;
        }
        
        if (decoded.type === TransactionType.DEX_SWAP) {
            this.stats.dexSwaps++;
        }
        
        if (decoded.type === TransactionType.ADD_LIQUIDITY || decoded.type === TransactionType.REMOVE_LIQUIDITY) {
            this.stats.liquidityOps++;
        }
        
        if (decoded.risk === 'HIGH' || decoded.risk === 'VERY_HIGH') {
            this.stats.highRiskTxs++;
        }
    }

    private recordWalletActivity(walletAddress: string, tx: ethers.TransactionResponse, decoded: DecodedTransaction, log: ethers.Log): void {
        const activity = this.walletActivity.get(walletAddress) || [];
        
        activity.push({
            tx,
            decoded,
            timestamp: Date.now(),
            logIndex: log.index
        });
        
        // Keep only recent 100 transactions per wallet
        if (activity.length > 100) {
            activity.splice(0, activity.length - 100);
        }
        
        this.walletActivity.set(walletAddress, activity);
    }

    private logTransferEvent(log: ethers.Log, tx: ethers.TransactionResponse, decoded: DecodedTransaction, trackedItem: string, trackingType: 'wallet' | 'token'): void {
        const prefix = trackingType === 'wallet' ? '👀 WALLET' : '🪙 TOKEN';
        
        // Extract transfer details from log
        const from = log.topics[1] ? `0x${log.topics[1].slice(26)}` : 'unknown';
        const to = log.topics[2] ? `0x${log.topics[2].slice(26)}` : 'unknown';
        const value = log.data ? ethers.getBigInt(log.data) : BigInt(0);
        
        logger.info(`${prefix} transfer detected:`, {
            [trackingType]: trackedItem,
            hash: tx.hash,
            from,
            to,
            value: ethers.formatEther(value),
            contract: log.address,
            type: decoded.type,
            functionName: decoded.functionName,
            contractName: decoded.contractName,
            risk: decoded.risk,
            blockNumber: tx.blockNumber || 'pending'
        });
    }

    private cleanupProcessedCache(): void {
        if (this.processedTxHashes.size > this.maxCacheSize) {
            // Remove oldest 20% of entries
            const toRemove = Math.floor(this.maxCacheSize * 0.2);
            const entries = Array.from(this.processedTxHashes);
            for (let i = 0; i < toRemove; i++) {
                this.processedTxHashes.delete(entries[i]);
            }
        }
    }

    public removeWalletFromWatch(address: string): void {
        const normalizedAddress = address.toLowerCase();
        if (!this.watchedWallets.has(normalizedAddress)) {
            logger.info(`Wallet ${address} is not being watched.`);
            return;
        }

        this.watchedWallets.delete(normalizedAddress);
        this.walletActivity.delete(normalizedAddress);

        // Clean up filters
        const filters = this.walletFilters.get(normalizedAddress);
        if (filters && this.provider) {
            this.provider.removeAllListeners(filters.fromFilter);
            this.provider.removeAllListeners(filters.toFilter);
        }
        this.walletFilters.delete(normalizedAddress);

        logger.info(`🚫 Stopped watching wallet: ${address}`);
        logger.info(`📊 Now watching ${this.watchedWallets.size} wallets`);
    }

    public removeTokenFromTracking(tokenAddress: string): void {
        const normalizedTokenAddress = tokenAddress.toLowerCase();
        if (!this.trackedTokens.has(normalizedTokenAddress)) {
            logger.info(`Token ${tokenAddress} is not being tracked.`);
            return;
        }

        const filter = this.trackedTokens.get(normalizedTokenAddress);
        if (filter && this.provider) {
            this.provider.removeAllListeners(filter);
        }
        this.trackedTokens.delete(normalizedTokenAddress);

        logger.info(`🚫 Stopped tracking token: ${tokenAddress}`);
        logger.info(`📊 Now tracking ${this.trackedTokens.size} tokens`);
    }

    // Getters
    public getWatchedWallets(): string[] {
        return Array.from(this.watchedWallets);
    }

    public getTrackedTokens(): string[] {
        return Array.from(this.trackedTokens.keys());
    }

    public getWalletActivity(address: string, limit = 50): WalletActivity[] {
        const normalizedAddress = address.toLowerCase();
        const activity = this.walletActivity.get(normalizedAddress) || [];
        return activity.slice(-limit);
    }

    public getStats(): TransactionStats & { 
        watchedWallets: number; 
        trackedTokens: number; 
        totalWalletActivity: number;
        cacheSize: number;
    } {
        return {
            ...this.stats,
            watchedWallets: this.watchedWallets.size,
            trackedTokens: this.trackedTokens.size,
            totalWalletActivity: Array.from(this.walletActivity.values())
                .reduce((sum, activity) => sum + activity.length, 0),
            cacheSize: this.processedTxHashes.size
        };
    }

    public getWalletAnalytics(address: string): {
        totalTransactions: number;
        dexSwaps: number;
        liquidityOps: number;
        highRiskTxs: number;
        favoriteTokens: string[];
        mostUsedContracts: string[];
        averageGasUsed: string;
        recentActivity: WalletActivity[];
    } {
        const normalizedAddress = address.toLowerCase();
        const activity = this.walletActivity.get(normalizedAddress) || [];

        const analytics = {
            totalTransactions: activity.length,
            dexSwaps: 0,
            liquidityOps: 0,
            highRiskTxs: 0,
            favoriteTokens: [] as string[],
            mostUsedContracts: [] as string[],
            averageGasUsed: '0',
            recentActivity: activity.slice(-10) // Last 10 transactions
        };

        if (activity.length === 0) return analytics;

        const tokenCounts = new Map<string, number>();
        const contractCounts = new Map<string, number>();
        let totalGas = BigInt(0);
        let gasCount = 0;

        activity.forEach(({ tx, decoded }) => {
            // Count transaction types
            if (decoded.type === TransactionType.DEX_SWAP) {
                analytics.dexSwaps++;
            }
            if (decoded.type === TransactionType.ADD_LIQUIDITY || decoded.type === TransactionType.REMOVE_LIQUIDITY) {
                analytics.liquidityOps++;
            }
            if (decoded.risk === 'HIGH' || decoded.risk === 'VERY_HIGH') {
                analytics.highRiskTxs++;
            }

            // Count token usage
            if (decoded.tokenIn) {
                tokenCounts.set(decoded.tokenIn, (tokenCounts.get(decoded.tokenIn) || 0) + 1);
            }
            if (decoded.tokenOut) {
                tokenCounts.set(decoded.tokenOut, (tokenCounts.get(decoded.tokenOut) || 0) + 1);
            }

            // Count contract usage
            if (decoded.contractName) {
                contractCounts.set(decoded.contractName, (contractCounts.get(decoded.contractName) || 0) + 1);
            }

            // Calculate gas usage
            if (tx.gasPrice && tx.gasLimit) {
                totalGas += tx.gasPrice * tx.gasLimit;
                gasCount++;
            }
        });

        // Get most used tokens and contracts
        analytics.favoriteTokens = Array.from(tokenCounts.entries())
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([token]) => token);

        analytics.mostUsedContracts = Array.from(contractCounts.entries())
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([contract]) => contract);

        // Calculate average gas
        if (gasCount > 0) {
            analytics.averageGasUsed = ethers.formatEther(totalGas / BigInt(gasCount));
        }

        return analytics;
    }

    // Listener management
    public registerListener(listener: TransactionListener): void {
        this.listeners.push(listener);
        logger.info(`Registered transaction listener. Total listeners: ${this.listeners.length}`);
    }

    // Connection management
    private handleReconnect(): void {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
            logger.info(`Attempting to reconnect in ${delay / 1000} seconds... (Attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                this.disconnect().then(() => {
                    this.connect();
                    // Re-add all watched wallets and tokens
                    this.reestablishFilters();
                });
            }, delay);
        } else {
            logger.error('Max reconnect attempts reached. Will not reconnect.');
        }
    }

    private reestablishFilters(): void {
        // Re-add wallet filters
        const wallets = Array.from(this.watchedWallets);
        this.watchedWallets.clear();
        this.walletFilters.clear();
        
        wallets.forEach(wallet => {
            this.addWalletToWatch(wallet);
        });

        // Re-add token filters  
        const tokens = Array.from(this.trackedTokens.keys());
        this.trackedTokens.clear();
        
        tokens.forEach(token => {
            this.addTokenToTrack(token);
        });

        logger.info(`🔄 Re-established ${wallets.length} wallet filters and ${tokens.length} token filters`);
    }

    public async disconnect(): Promise<void> {
        if (this.provider) {
            try {
                await this.provider.destroy();
            } catch (error) {
                logger.warn('Error during provider destruction:', error);
            }
            this.provider = null;
            this.isConnected = false;
            logger.info('🔌 Optimized WebSocket disconnected.');
        }
    }

    public getStatus(): { 
        isConnected: boolean; 
        reconnectAttempts: number; 
        stats: any;
    } {
        return {
            isConnected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            stats: this.getStats()
        };
    }

    private validateWebSocketUrl(url: string): boolean {
        try {
            const parsedUrl = new URL(url);
            const isValidProtocol = parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:';
            
            if (!isValidProtocol) {
                logger.error('WebSocket URL must use ws:// or wss:// protocol', { url: parsedUrl.protocol });
                return false;
            }
            
            if (!parsedUrl.hostname) {
                logger.error('WebSocket URL must have a valid hostname');
                return false;
            }
            
            return true;
        } catch (error) {
            logger.error('Invalid WebSocket URL format:', error);
            return false;
        }
    }

    public async testConnection(): Promise<boolean> {
        if (!this.provider) return false;

        try {
            const blockNumber = await this.provider.getBlockNumber();
            logger.info(`Optimized connection test successful. Current block: ${blockNumber}`);

            const network = await this.provider.getNetwork();
            logger.info(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`);

            return true;
        } catch (error) {
            logger.error('Optimized connection test failed:', error);
            return false;
        }
    }

    public async runDiagnostics(): Promise<void> {
        logger.info('🔍 Running Optimized WebSocket diagnostics...');
        
        const status = this.getStatus();
        logger.info('Current Status:', status);
        
        const supportedContracts = this.decoder.getSupportedContracts();
        logger.info('Supported contracts for analysis:', supportedContracts);
        
        if (!process.env.QUICKNODE_BSC_WSS_URL) {
            logger.error('❌ QUICKNODE_BSC_WSS_URL environment variable is not set');
            return;
        }
        
        if (!this.validateWebSocketUrl(process.env.QUICKNODE_BSC_WSS_URL)) {
            logger.error('❌ WebSocket URL validation failed');
            return;
        }
        
        if (!this.provider) {
            logger.warn('⚠️ WebSocket provider not initialized');
            return;
        }
        
        try {
            const connectionTest = await this.testConnection();
            if (connectionTest) {
                logger.info('✅ Optimized connection test passed');
            } else {
                logger.error('❌ Optimized connection test failed');
            }
        } catch (error) {
            logger.error('❌ Optimized diagnostics failed:', error);
        }
    }
}