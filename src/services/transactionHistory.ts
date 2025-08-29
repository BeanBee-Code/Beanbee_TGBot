import Moralis from 'moralis';
import { TransactionModel, Transaction } from '../database/models/Transaction';
import { subDays, format } from 'date-fns';
import { EvmChain } from '@moralisweb3/common-evm-utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('transactionHistory');

export class TransactionHistoryService {
  /**
   * Fetches transaction history for a wallet address and saves to MongoDB
   * @param walletAddress - The wallet address to fetch history for
   * @param days - Number of days of history to fetch (default: 7)
   */
  static async fetchAndSaveTransactionHistory(walletAddress: string, days: number = 7): Promise<void> {
    try {
      const toDate = new Date();
      const fromDate = subDays(toDate, days);

      const response = await Moralis.EvmApi.wallets.getWalletHistory({
        address: walletAddress,
        chain: EvmChain.BSC,
        fromDate: fromDate,
        toDate: toDate,
        order: 'DESC',
        limit: 100
      });

      const historyData = response.toJSON();

      // Save transactions to MongoDB
      for (const tx of historyData.result) {
        const transactionData = {
          walletAddress: walletAddress.toLowerCase(),
          hash: tx.hash,
          blockNumber: tx.block_number,
          blockTimestamp: new Date(tx.block_timestamp),
          from: tx.from_address,
          to: tx.to_address || '',
          value: tx.value,
          valueDecimal: parseFloat(tx.value) / 1e18, // Convert from wei to BNB
          gas: tx.gas,
          gasPrice: tx.gas_price,
          receiptStatus: parseInt(tx.receipt_status),
          category: tx.category,
          method: tx.method_label,
          nativeTransfers: tx.native_transfers,
          erc20Transfers: tx.erc20_transfers,
          nftTransfers: tx.nft_transfers,
          summary: tx.summary,
          possibleSpam: tx.possible_spam
        };

        await TransactionModel.findOneAndUpdate(
          { hash: tx.hash },
          transactionData,
          { upsert: true, new: true }
        );
      }

      // Handle pagination if there are more transactions
      let cursor = historyData.cursor;
      while (cursor) {
        const nextResponse = await Moralis.EvmApi.wallets.getWalletHistory({
          address: walletAddress,
          chain: EvmChain.BSC,
          fromDate: fromDate,
          toDate: toDate,
          order: 'DESC',
          limit: 100,
          cursor
        });

        const nextHistoryData = nextResponse.toJSON();

        for (const tx of nextHistoryData.result) {
          const transactionData = {
            walletAddress: walletAddress.toLowerCase(),
            hash: tx.hash,
            blockNumber: tx.block_number,
            blockTimestamp: new Date(tx.block_timestamp),
            from: tx.from_address,
            to: tx.to_address || '',
            value: tx.value,
            valueDecimal: parseFloat(tx.value) / 1e18,
            gas: tx.gas,
            gasPrice: tx.gas_price,
            receiptStatus: parseInt(tx.receipt_status),
            category: tx.category,
            method: tx.method_label,
            nativeTransfers: tx.native_transfers,
            erc20Transfers: tx.erc20_transfers,
            nftTransfers: tx.nft_transfers,
            summary: tx.summary,
            possibleSpam: tx.possible_spam
          };

          await TransactionModel.findOneAndUpdate(
            { hash: tx.hash },
            transactionData,
            { upsert: true, new: true }
          );
        }

        cursor = nextHistoryData.cursor;
      }
    } catch (error) {
      logger.error('Error fetching transaction history', { 
        walletAddress, 
        days, 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  /**
   * Gets cached transactions from MongoDB for a wallet address
   */
  static async getCachedTransactions(walletAddress: string, fromDate?: Date): Promise<Transaction[]> {
    const query: any = { walletAddress: walletAddress.toLowerCase() };
    
    if (fromDate) {
      query.blockTimestamp = { $gte: fromDate.toISOString() };
    }

    return await TransactionModel.find(query).sort({ blockTimestamp: -1 });
  }

  /**
   * Updates transaction history by fetching only new transactions since last update
   */
  static async updateTransactionHistory(walletAddress: string, lastTransactionHash: string): Promise<void> {
    try {
      // Get the timestamp of the last transaction
      const lastTransaction = await TransactionModel.findOne({ hash: lastTransactionHash });
      if (!lastTransaction) {
        // If last transaction not found, fetch full 7-day history
        await this.fetchAndSaveTransactionHistory(walletAddress);
        return;
      }

      const fromDate = new Date(lastTransaction.blockTimestamp);
      const toDate = new Date();

      const response = await Moralis.EvmApi.wallets.getWalletHistory({
        address: walletAddress,
        chain: EvmChain.BSC,
        fromDate: fromDate,
        toDate: toDate,
        order: 'DESC',
        limit: 100
      });

      const historyData = response.toJSON();

      // Save only new transactions
      for (const tx of historyData.result) {
        if (tx.hash === lastTransactionHash) {
          break; // Stop when we reach the last known transaction
        }

        const transactionData = {
          walletAddress: walletAddress.toLowerCase(),
          hash: tx.hash,
          blockNumber: tx.block_number,
          blockTimestamp: new Date(tx.block_timestamp),
          from: tx.from_address,
          to: tx.to_address || '',
          value: tx.value,
          valueDecimal: parseFloat(tx.value) / 1e18,
          gas: tx.gas,
          gasPrice: tx.gas_price,
          receiptStatus: parseInt(tx.receipt_status),
          category: tx.category,
          method: tx.method_label,
          nativeTransfers: tx.native_transfers,
          erc20Transfers: tx.erc20_transfers,
          nftTransfers: tx.nft_transfers,
          summary: tx.summary,
          possibleSpam: tx.possible_spam
        };

        await TransactionModel.findOneAndUpdate(
          { hash: tx.hash },
          transactionData,
          { upsert: true, new: true }
        );
      }
    } catch (error) {
      logger.error('Error updating transaction history', { 
        walletAddress, 
        lastTransactionHash, 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }
}