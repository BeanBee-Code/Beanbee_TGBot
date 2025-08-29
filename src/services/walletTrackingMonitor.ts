import { WebSocketService } from './rpc/websocketService';
import { WalletTrackingService } from './walletTracking';
import { createLogger } from '@/utils/logger';
import { ethers } from 'ethers';

const logger = createLogger('services.walletTrackingMonitor');

export class WalletTrackingMonitor {
    private static instance: WalletTrackingMonitor;
    private websocketService: WebSocketService;
    private isInitialized = false;

    private constructor() {
        this.websocketService = new WebSocketService();
    }

    public static getInstance(): WalletTrackingMonitor {
        if (!WalletTrackingMonitor.instance) {
            WalletTrackingMonitor.instance = new WalletTrackingMonitor();
        }
        return WalletTrackingMonitor.instance;
    }

    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            logger.info('Wallet tracking monitor already initialized');
            return;
        }

        try {
            // Set up event listener for wallet tracking notifications
            this.websocketService.registerListener(async (tx, decoded) => {
                await this.handleTrackedWalletTransaction(tx, decoded);
            });

            // Connect to WebSocket
            this.websocketService.connect();

            // Load existing tracked wallets from database
            await this.loadTrackedWallets();

            this.isInitialized = true;
            logger.info('✅ Optimized wallet tracking monitor initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize wallet tracking monitor', { error });
            throw error;
        }
    }

    public async addWalletToTracking(walletAddress: string): Promise<void> {
        try {
            const normalizedAddress = walletAddress.toLowerCase();
            this.websocketService.addWalletToWatch(normalizedAddress);
            logger.info('Added wallet to WebSocket monitoring', { walletAddress: normalizedAddress });
        } catch (error) {
            logger.error('Failed to add wallet to tracking', { error, walletAddress });
            throw error;
        }
    }

    public async removeWalletFromTracking(walletAddress: string): Promise<void> {
        try {
            const normalizedAddress = walletAddress.toLowerCase();
            this.websocketService.removeWalletFromWatch(normalizedAddress);
            logger.info('Removed wallet from WebSocket monitoring', { walletAddress: normalizedAddress });
        } catch (error) {
            logger.error('Failed to remove wallet from tracking', { error, walletAddress });
            throw error;
        }
    }

    public async addTokenToTracking(tokenAddress: string, tokenSymbol?: string): Promise<void> {
        try {
            this.websocketService.addTokenToTrack(tokenAddress, tokenSymbol);
            logger.info('Added token to tracking', { tokenAddress, tokenSymbol });
        } catch (error) {
            logger.error('Failed to add token to tracking', { error, tokenAddress });
            throw error;
        }
    }

    public async removeTokenFromTracking(tokenAddress: string): Promise<void> {
        try {
            this.websocketService.removeTokenFromTracking(tokenAddress);
            logger.info('Removed token from tracking', { tokenAddress });
        } catch (error) {
            logger.error('Failed to remove token from tracking', { error, tokenAddress });
            throw error;
        }
    }

    public getWalletAnalytics(walletAddress: string) {
        try {
            return this.websocketService.getWalletAnalytics(walletAddress);
        } catch (error) {
            logger.error('Failed to get wallet analytics', { error, walletAddress });
            return null;
        }
    }

    public getMonitoringStats() {
        try {
            return this.websocketService.getStatus();
        } catch (error) {
            logger.error('Failed to get monitoring stats', { error });
            return null;
        }
    }

    private async loadTrackedWallets(): Promise<void> {
        try {
            // Get all tracked wallets from database
            const trackedWallets = await WalletTrackingService.getTrackedWallets();
            
            logger.info(`Loading ${trackedWallets.length} tracked wallets into WebSocket monitor`);
            
            // Add each wallet to WebSocket monitoring
            for (const walletAddress of trackedWallets) {
                this.websocketService.addWalletToWatch(walletAddress);
            }
            
            logger.info(`Successfully loaded ${trackedWallets.length} wallets into monitoring`);
        } catch (error) {
            logger.error('Failed to load tracked wallets', { error });
        }
    }

    private async handleTrackedWalletTransaction(tx: ethers.TransactionResponse, decoded: any): Promise<void> {
        
        try {
            const fromAddress = tx.from?.toLowerCase();
            const toAddress = tx.to?.toLowerCase();
            
            // For token transfers, get the actual recipient from decoded data
            let actualToAddress = toAddress;
            if (decoded && decoded.type === 'TOKEN_TRANSFER' && decoded.recipient) {
                actualToAddress = decoded.recipient.toLowerCase();
            }
            
            // Check if this transaction involves any tracked wallets
            const trackedWallets = this.websocketService.getWatchedWallets();
            
            // Find all tracked wallets involved in this transaction
            const involvedWallets: string[] = [];
            if (fromAddress && trackedWallets.includes(fromAddress)) {
                involvedWallets.push(fromAddress);
            }
            if (actualToAddress && trackedWallets.includes(actualToAddress)) {
                involvedWallets.push(actualToAddress);
            }
            
            if (involvedWallets.length === 0) {
                return; // Not a tracked wallet transaction
            }

            // Enhance transaction data with decoded information
            const enhancedTransaction = {
                hash: tx.hash,
                from: tx.from,
                to: actualToAddress, // Use the actual recipient for token transfers
                value: tx.value.toString(),
                gasPrice: tx.gasPrice?.toString(),
                gasLimit: tx.gasLimit?.toString(),
                blockNumber: tx.blockNumber,
                decoded: {
                    type: decoded.type,
                    functionName: decoded.functionName,
                    contractName: decoded.contractName,
                    tokenIn: decoded.tokenIn,
                    tokenOut: decoded.tokenOut,
                    amountIn: decoded.amountIn,
                    amountOut: decoded.amountOut,
                    recipient: decoded.recipient, // Include the recipient in decoded data
                    risk: decoded.risk,
                    tags: decoded.tags
                }
            };

            // Send notification to users tracking each involved wallet
            for (const involvedWallet of involvedWallets) {
                logger.info('🔔 Tracked wallet transaction detected', {
                    walletAddress: involvedWallet,
                    txHash: tx.hash,
                    type: decoded.type,
                    risk: decoded.risk,
                    direction: involvedWallet === fromAddress ? 'outgoing' : 'incoming'
                });

                // Send notification to users tracking this specific wallet
                await WalletTrackingService.notifyWalletTransaction(involvedWallet, enhancedTransaction);
            }

        } catch (error) {
            logger.error('Error handling tracked wallet transaction', { 
                error, 
                txHash: tx.hash,
                from: tx.from,
                to: tx.to
            });
        }
    }

    public async shutdown(): Promise<void> {
        try {
            await this.websocketService.disconnect();
            this.isInitialized = false;
            logger.info('Wallet tracking monitor shut down successfully');
        } catch (error) {
            logger.error('Error shutting down wallet tracking monitor', { error });
        }
    }

    // Additional utility methods
    public isConnected(): boolean {
        return this.websocketService.getStatus().isConnected;
    }

    public getTrackedWalletsCount(): number {
        return this.websocketService.getWatchedWallets().length;
    }

    public getTrackedTokensCount(): number {
        return this.websocketService.getTrackedTokens().length;
    }

    public getTrackedTokens(): string[] {
        return this.websocketService.getTrackedTokens();
    }

    public async refreshTrackedWallets(): Promise<void> {
        try {
            // Clear current wallets
            const currentWallets = this.websocketService.getWatchedWallets();
            for (const wallet of currentWallets) {
                this.websocketService.removeWalletFromWatch(wallet);
            }

            // Reload from database
            await this.loadTrackedWallets();
            
            logger.info('Successfully refreshed tracked wallets');
        } catch (error) {
            logger.error('Failed to refresh tracked wallets', { error });
        }
    }
}