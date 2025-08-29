import { WalletService } from './connect';

// Global WalletService instance
let globalWalletService: WalletService | null = null;

/**
 * Get or create the global WalletService instance
 */
export function getWalletService(): WalletService {
  if (!globalWalletService) {
    if (!global.userSessions) {
      throw new Error('Global userSessions not initialized');
    }
    globalWalletService = new WalletService(global.userSessions);
  }
  return globalWalletService;
}

/**
 * Set the global WalletService instance (used by bot initialization)
 */
export function setGlobalWalletService(service: WalletService): void {
  globalWalletService = service;
}

// Export all wallet-related services
export { WalletService } from './connect';
export { TransferService } from './transfer';
export { SignClientManager } from './signClientManager';
export { walletConnectStorage } from './walletConnectStorage';
export * from './balance';
export * from './tradingWallet';