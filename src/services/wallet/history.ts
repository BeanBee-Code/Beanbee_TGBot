import Moralis from 'moralis';
import { EvmChain } from '@moralisweb3/common-evm-utils';
import { Context } from 'telegraf';
import { createLogger } from '@/utils/logger';

const logger = createLogger('wallet.history');

/**
 * Service for handling wallet transaction history operations
 * Provides methods to fetch and format wallet transaction history from BSC chain
 */
export class WalletHistoryService {
	/**
	 * Fetches transaction history for a given wallet address
	 * @param address - The wallet address to fetch history for
	 * @param options - Optional parameters for pagination and filtering
	 * @returns Transaction history data from Moralis
	 */
	async getWalletHistory(
		address: string,
		options?: {
			limit?: number;
			cursor?: string;
			fromBlock?: number;
			toBlock?: number;
		},
	) {
		try {
			const response = await Moralis.EvmApi.wallets.getWalletHistory({
				chain: EvmChain.BSC, // Using official Moralis chain enum
				address,
				limit: options?.limit ?? 10,
				cursor: options?.cursor,
				fromBlock: options?.fromBlock,
				toBlock: options?.toBlock,
			});

			return response.toJSON();
		} catch (error) {
			logger.error('Error fetching wallet history', { address, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	/**
	 * Formats transaction history data into a user-friendly message
	 * @param historyData - Raw transaction history data from Moralis
	 * @param address - The wallet address being queried
	 * @returns Formatted message string
	 */
	formatHistoryMessage(historyData: any, address: string): string {
		let message = "📜 *Transaction History*\n";
		message += `👛 \`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n`;

		if (!historyData.result || historyData.result.length === 0) {
			return message + "No transactions found.";
		}

		historyData.result.forEach((tx: any, index: number) => {
			const date = new Date(tx.block_timestamp).toLocaleDateString();
			const hash = `${tx.hash.slice(0, 8)}...${tx.hash.slice(-6)}`;
			const value = parseFloat(tx.value) / Math.pow(10, 18);

			message += `${index + 1}. ${date}\n`;
			message += `   Hash: \`${hash}\`\n`;
			message += `   Value: ${value.toFixed(4)} BNB\n`;
			message += `   From: \`${tx.from_address.slice(0, 6)}...${tx.from_address.slice(-4)}\`\n`;
			message += `   To: \`${tx.to_address.slice(0, 6)}...${tx.to_address.slice(-4)}\`\n\n`;
		});

		return message;
	}
} 