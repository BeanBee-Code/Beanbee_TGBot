import { subDays, differenceInMinutes } from 'date-fns';
import { getUserLanguage, t, interpolate } from '@/i18n';
import { TransactionHistoryService } from '@/services/transactionHistory';
import { Transaction } from '@/database/models/Transaction';
import { createLogger } from '@/utils/logger';

const logger = createLogger('wallet.enhancedHistory');

interface TransactionInfo {
  hash: string;
  timestamp: string;
  from: string;
  to: string;
  value: string;
  valueInBNB: number;
  category: string;
  summary: string;
  direction?: 'buy' | 'sell';
  tokenTransfers: Array<{
    tokenName: string;
    tokenSymbol: string;
    amount: string;
    from: string;
    to: string;
  }>;
}

/**
 * Enhanced service for handling wallet transaction history with better filtering and display
 */
export class EnhancedWalletHistoryService {
  private static CACHE_DURATION_MINUTES = 5; // Cache for 5 minutes

  /**
   * Fetches and filters meaningful transactions for a wallet from the last 7 days
   * Uses existing TransactionHistoryService for caching
   */
  async getFilteredWalletHistory(
    address: string,
    options?: {
      limit?: number;
      cursor?: string;
      fromBlock?: number;
      toBlock?: number;
    }
  ) {
    try {
      const normalizedAddress = address.toLowerCase();
      const fromDate = subDays(new Date(), 7);
      
      // Check if we have recent cached transactions
      let cachedTransactions = await TransactionHistoryService.getCachedTransactions(normalizedAddress, fromDate);
      
      // If cache is empty or potentially stale (no transactions in last 5 minutes), fetch fresh data
      if (cachedTransactions.length === 0) {
        logger.info('No cached transactions found, fetching full history', { address });
        await TransactionHistoryService.fetchAndSaveTransactionHistory(normalizedAddress);
        cachedTransactions = await TransactionHistoryService.getCachedTransactions(normalizedAddress, fromDate);
      } else if (this.isCacheStale(cachedTransactions)) {
        logger.info('Cache is stale, fetching updates', { address, lastHash: cachedTransactions[0]?.hash });
        // Sort to ensure most recent is first
        const sortedTransactions = cachedTransactions.sort((a, b) => 
          b.blockTimestamp.getTime() - a.blockTimestamp.getTime()
        );
        const latestHash = sortedTransactions[0].hash;
        
        // Try incremental update
        await TransactionHistoryService.updateTransactionHistory(normalizedAddress, latestHash);
        cachedTransactions = await TransactionHistoryService.getCachedTransactions(normalizedAddress, fromDate);
      } else {
        logger.info('Using cached transaction history', { address, transactionCount: cachedTransactions.length });
      }
      
      // Convert to TransactionInfo format and filter
      const processedTxs = this.convertToTransactionInfo(cachedTransactions, normalizedAddress);
      
      // Return only the most meaningful transactions
      return {
        result: processedTxs.slice(0, options?.limit ?? 10)
      };
    } catch (error) {
      logger.error('Error fetching wallet history', { address, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Check if cached transactions are stale
   */
  private isCacheStale(transactions: Transaction[]): boolean {
    if (transactions.length === 0) return true;
    
    // Find the most recent transaction
    const mostRecent = transactions.reduce((latest, tx) => 
      tx.blockTimestamp > latest.blockTimestamp ? tx : latest
    );
    
    const minutesSinceLastTx = differenceInMinutes(new Date(), mostRecent.blockTimestamp);
    return minutesSinceLastTx > EnhancedWalletHistoryService.CACHE_DURATION_MINUTES;
  }

  /**
   * Convert cached Transaction models to TransactionInfo format with filtering and direction detection
   */
  private convertToTransactionInfo(transactions: Transaction[], walletAddress: string): TransactionInfo[] {
    const processed: TransactionInfo[] = [];
    const normalizedWalletAddress = walletAddress.toLowerCase();
    
    for (const tx of transactions) {
      let direction: 'buy' | 'sell' | undefined = undefined;
      const category = tx.category?.toLowerCase() || 'unknown';

      // Only detect buy/sell direction for token swap transactions
      if (category === 'token swap') {
        const erc20Out = (tx.erc20Transfers || []).some((t: any) => 
          (t.from_address || t.from)?.toLowerCase() === normalizedWalletAddress
        );
        const erc20In = (tx.erc20Transfers || []).some((t: any) => 
          (t.to_address || t.to)?.toLowerCase() === normalizedWalletAddress
        );
        
        // Logic for determining direction:
        // 1. If user received ERC20 tokens, it's usually a buy
        // 2. If user sent ERC20 tokens, it's usually a sell
        if (erc20In && !erc20Out) {
          direction = 'buy';
        } else if (erc20Out && !erc20In) {
          direction = 'sell';
        }
        // If both in and out (token-to-token swap), check BNB flow direction
        else if (erc20In && erc20Out && tx.valueDecimal && tx.valueDecimal > 0) {
          if (tx.from.toLowerCase() === normalizedWalletAddress) {
            // User sent BNB and received other tokens -> buy
            direction = 'buy';
          } else if (tx.to.toLowerCase() === normalizedWalletAddress) {
            // User received BNB and sent other tokens -> sell
            direction = 'sell';
          }
        }
      }

      const txInfo: TransactionInfo = {
        hash: tx.hash,
        timestamp: tx.blockTimestamp.toISOString(),
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueInBNB: tx.valueDecimal || 0,
        category: tx.category || 'unknown',
        summary: typeof tx.summary === 'string' ? tx.summary : (tx.summary?.message || ''),
        direction,
        tokenTransfers: []
      };

      // Process ERC20 transfers
      if (tx.erc20Transfers && Array.isArray(tx.erc20Transfers)) {
        for (const transfer of tx.erc20Transfers) {
          txInfo.tokenTransfers.push({
            tokenName: transfer.token_name || 'Unknown Token',
            tokenSymbol: transfer.token_symbol || 'Unknown',
            amount: transfer.value_formatted || transfer.value,
            from: transfer.from_address,
            to: transfer.to_address
          });
        }
      }

      // Skip transactions with 0 BNB value and no token transfers
      if (txInfo.valueInBNB === 0 && txInfo.tokenTransfers.length === 0) {
        // Unless it's a contract interaction we want to show
        const category = tx.category?.toLowerCase() || '';
        if (!['contract interaction', 'token swap', 'nft'].includes(category)) {
          continue;
        }
      }

      processed.push(txInfo);
    }

    // Sort by timestamp descending (most recent first)
    return processed.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * Formats transaction history with full addresses and BSCScan link
   */
  async formatHistoryMessage(
    historyData: any, 
    address: string,
    telegramId: number
  ): Promise<string> {
    const lang = await getUserLanguage(telegramId);
    
    let message = t(lang, 'transactionHistory.title') + '\n';
    message += `${t(lang, 'transactionHistory.wallet')} \`${address}\`\n\n`;
    
    if (!historyData.result || historyData.result.length === 0) {
      message += `_${t(lang, 'transactionHistory.noTransactions')}_\n\n`;
      message += `🔗 [${t(lang, 'transactionHistory.viewOnBSCScan')}](https://bscscan.com/address/${address})`;
      return message;
    }

    const showingText = interpolate(t(lang, 'transactionHistory.showing'), { count: historyData.result.length });
    message += `_${showingText}_\n\n`;

    historyData.result.forEach((tx: TransactionInfo, index: number) => {
      const date = new Date(tx.timestamp).toLocaleDateString();
      const time = new Date(tx.timestamp).toLocaleTimeString();

      message += `*${index + 1}* ${date} ${time}\n`;
      
      // Transaction type/category with direction
      if (tx.category && tx.category !== 'unknown') {
        let typeText = tx.category;
        // Add buy/sell direction for token swap transactions
        if (tx.category.toLowerCase() === 'token swap' && tx.direction) {
          const directionText = tx.direction === 'buy' ? ' - Buy' : ' - Sell';
          typeText += directionText;
        }
        message += `${t(lang, 'transactionHistory.type')} *${typeText}*\n`;
      }
      
      // Hash
      message += `${t(lang, 'transactionHistory.hash')} \`${tx.hash}\`\n`;
      
      // BNB value if any
      if (tx.valueInBNB > 0) {
        message += `${t(lang, 'transactionHistory.value')} *${tx.valueInBNB.toFixed(4)} BNB*\n`;
      }
      
      // Token transfers
      if (tx.tokenTransfers.length > 0) {
        message += `${t(lang, 'transactionHistory.tokenTransfers')}\n`;
        for (const transfer of tx.tokenTransfers) {
          const direction = transfer.from.toLowerCase() === address.toLowerCase() 
            ? t(lang, 'transactionHistory.sent') 
            : t(lang, 'transactionHistory.received');
          message += `  • ${direction} ${transfer.amount} ${transfer.tokenSymbol}\n`;
        }
      }
      
      // From/To addresses
      message += `${t(lang, 'transactionHistory.from')} \`${tx.from}\`\n`;
      message += `${t(lang, 'transactionHistory.to')} \`${tx.to}\`\n`;
      
      // Summary if available
      if (tx.summary && tx.summary !== tx.category) {
        message += `📝 ${tx.summary}\n`;
      }
      
      message += "\n";
    });

    // Add BSCScan link at the end
    message += `🔗 [${t(lang, 'transactionHistory.viewAllTransactions')}](https://bscscan.com/address/${address})`;

    return message;
  }


}