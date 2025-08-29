import Moralis from "moralis";
import { EvmChain } from "@moralisweb3/common-evm-utils";
import { createLogger } from '@/utils/logger';

const logger = createLogger('wallet.customPnL');

interface TokenTransaction {
	tokenAddress: string;
	tokenSymbol: string;
	amount: number;
	usdValue: number;
	type: "buy" | "sell";
	timestamp: Date;
	blockNumber: number;
}

interface PnLCalculation {
	totalRealizedPnL: number;
	totalUnrealizedPnL: number;
	totalPnL: number;
	tokenBreakdown: TokenPnLBreakdown[];
	totalInvested: number;
	currentPortfolioValue: number;
	portfolioReturn: number; // Total return percentage
}

interface TokenPnLBreakdown {
	tokenAddress: string;
	tokenSymbol: string;
	
	// Transaction data
	totalBought: number;
	totalSold: number;
	currentHoldings: number;
	
	// Price data
	averageBuyPrice: number;
	averageSellPrice: number;
	currentPrice: number;
	
	// PnL data
	realizedPnL: number;
	unrealizedPnL: number;
	totalPnL: number;
	
	// Investment and current value
	totalInvested: number;
	currentValue: number;
	returnPercentage: number;
}

interface FIFOQueueItem {
	amount: number;
	pricePerUnit: number;
	timestamp: Date;
}

export class CustomPnLService {
	private readonly DAYS_TO_ANALYZE = 7;
	private readonly BNB_CONTRACT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // Native BNB placeholder
	private readonly WBNB_CONTRACT = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // Wrapped BNB for price
	private currentWalletAddress: string = "";

	/**
	 * Calculate wallet PnL for the last 7 days
	 */
	async calculateWalletPnL(address: string): Promise<PnLCalculation> {
		try {
			logger.info('Starting PnL calculation', { address });
			this.currentWalletAddress = address;

			// 1. Get transaction history for the last 7 days
			const transactions = await this.getRecentTransactions(address);
			logger.info('Fetched transactions', { count: transactions.length });

			// 2. Parse transactions to extract token buy/sell information
			const tokenTransactions = await this.parseTokenTransactions(transactions);
			logger.info('Parsed token transactions', { count: tokenTransactions.length });

			// 3. Get current wallet balances
			const currentBalances = await this.getCurrentBalances(address);
			logger.info('Found token balances', { count: currentBalances.length });

			// 4. Calculate PnL
			const pnlCalculation = await this.calculatePnL(tokenTransactions, currentBalances);

			logger.info('PnL calculation completed', { totalPnL: pnlCalculation.totalPnL, tokenCount: pnlCalculation.tokenBreakdown.length });
			return pnlCalculation;
		} catch (error) {
			logger.error('Error calculating PnL', { address, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	/**
	 * Get transaction history for the last 7 days
	 */
	private async getRecentTransactions(address: string) {
		const sevenDaysAgo = new Date();
		sevenDaysAgo.setDate(sevenDaysAgo.getDate() - this.DAYS_TO_ANALYZE);

		// Get block number from 7 days ago
		const fromBlock = await this.getBlockByDate(sevenDaysAgo);

		// Get native transactions
		const nativeResponse = await Moralis.EvmApi.wallets.getWalletHistory({
			chain: EvmChain.BSC,
			address,
			limit: 100,
			fromBlock,
		});

		// Get token transfers
		const tokenResponse = await Moralis.EvmApi.token.getWalletTokenTransfers({
			chain: EvmChain.BSC,
			address,
			limit: 100,
			fromBlock,
		});

		// Combine both native and token transactions
		const allTransactions = [
			...(nativeResponse.toJSON().result || []),
			...(tokenResponse.toJSON().result || [])
		];

		// Sort by block number (most recent first)
		allTransactions.sort((a, b) => parseInt(b.block_number) - parseInt(a.block_number));

		return allTransactions;
	}

	/**
	 * Get block number for a specific date
	 */
	private async getBlockByDate(date: Date): Promise<number> {
		try {
			const response = await Moralis.EvmApi.block.getDateToBlock({
				chain: EvmChain.BSC,
				date: date.toISOString(),
			});
			return response.toJSON().block;
		} catch (error) {
			console.warn("Could not get block by date, using current block - 200000");
			return Math.max(0, await this.getCurrentBlock() - 200000); // Approximately 7 days ago
		}
	}

	/**
	 * Get current block number
	 */
	private async getCurrentBlock(): Promise<number> {
		// This is a simplified version, in practice you might need to call RPC
		return 35_000_000; // Approximate current BSC block height
	}

	/**
	 * Parse transactions to extract token transaction information
	 */
	private async parseTokenTransactions(transactions: any[]): Promise<TokenTransaction[]> {
		const tokenTransactions: TokenTransaction[] = [];

		for (const tx of transactions) {
			try {
				// Check if this is a token transfer (has token_address field)
				if (tx.token_address || tx.address) {
					const tokenTx = await this.parseERC20Transfer(tx);
					if (tokenTx) tokenTransactions.push(tokenTx);
				}
				// Parse BNB transfers (native transactions with value)
				else if (tx.value && parseFloat(tx.value) > 0 && !tx.token_address) {
					const bnbTx = await this.parseBNBTransfer(tx);
					if (bnbTx) tokenTransactions.push(bnbTx);
				}

				// Parse DEX transactions (PancakeSwap etc.)
				if (
					tx.decoded_call &&
					(tx.decoded_call.label?.includes("swap") ||
						tx.decoded_call.label?.includes("exchange"))
				) {
					const swapTxs = await this.parseSwapTransaction(tx);
					tokenTransactions.push(...swapTxs);
				}
			} catch (error) {
				console.warn(`Error parsing transaction ${tx.hash}:`, error);
			}
		}

		return tokenTransactions;
	}

	/**
	 * Parse ERC20 token transfer
	 */
	private async parseERC20Transfer(tx: any): Promise<TokenTransaction | null> {
		try {
			// For token transfers, the token address is in the 'address' field
			const tokenAddress = tx.address || tx.token_address || tx.to_address;
			if (!tokenAddress) return null;

			const tokenInfo = await this.getTokenInfo(tokenAddress);

			// Calculate amount
			const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tokenInfo.decimals.toString()));

			// Get price at transaction time
			const priceAtTime = await this.getTokenPriceAtBlock(tokenAddress, tx.block_number);

			// Determine if it's a buy or sell based on the direction
			const walletAddress = tx.from_address?.toLowerCase() === this.currentWalletAddress?.toLowerCase() ? 'from' : 'to';
			const type = walletAddress === 'from' ? 'sell' : 'buy';

			return {
				tokenAddress,
				tokenSymbol: tokenInfo.symbol,
				amount,
				usdValue: amount * priceAtTime,
				type,
				timestamp: new Date(tx.block_timestamp),
				blockNumber: tx.block_number,
			};
		} catch (error) {
			console.warn("Error parsing ERC20 transfer:", error);
			return null;
		}
	}

	/**
	 * Parse BNB transfer
	 */
	private async parseBNBTransfer(tx: any): Promise<TokenTransaction | null> {
		try {
			const amount = parseFloat(tx.value) / Math.pow(10, 18); // BNB has 18 decimals
			// Use WBNB contract to get BNB price
			const priceAtTime = await this.getTokenPriceAtBlock(this.WBNB_CONTRACT, tx.block_number);

			// Determine if it's a buy or sell
			const type = tx.from_address.toLowerCase() === this.currentWalletAddress.toLowerCase() ? "sell" : "buy";

			return {
				tokenAddress: this.BNB_CONTRACT,
				tokenSymbol: "BNB",
				amount,
				usdValue: amount * priceAtTime,
				type,
				timestamp: new Date(tx.block_timestamp),
				blockNumber: tx.block_number,
			};
		} catch (error) {
			console.warn("Error parsing BNB transfer:", error);
			return null;
		}
	}

	/**
	 * Parse DEX transaction
	 */
	private async parseSwapTransaction(tx: any): Promise<TokenTransaction[]> {
		// More complex logic needed here to parse DEX transactions
		// Can identify token swaps through transaction logs
		return [];
	}

	/**
	 * Get token information
	 */
	private async getTokenInfo(tokenAddress: string) {
		try {
			const response = await Moralis.EvmApi.token.getTokenMetadata({
				chain: EvmChain.BSC,
				addresses: [tokenAddress],
			});
			const tokenData = response.toJSON()[0];
			return {
				symbol: tokenData.symbol,
				decimals: tokenData.decimals,
				name: tokenData.name,
			};
		} catch (error) {
			return { symbol: "UNKNOWN", decimals: 18, name: "Unknown Token" };
		}
	}

	/**
	 * Get token price at specific block
	 */
	private async getTokenPriceAtBlock(tokenAddress: string, blockNumber: number): Promise<number> {
		try {
			// For native BNB, use WBNB price
			const priceAddress = tokenAddress.toLowerCase() === this.BNB_CONTRACT.toLowerCase() 
				? this.WBNB_CONTRACT 
				: tokenAddress;
				
			const response = await Moralis.EvmApi.token.getTokenPrice({
				chain: EvmChain.BSC,
				address: priceAddress,
				toBlock: blockNumber,
			});
			return response.toJSON().usdPrice || 0;
		} catch (error) {
			console.warn(`Could not get price for token ${tokenAddress} at block ${blockNumber}`);
			return 0;
		}
	}

	/**
	 * Get current token price
	 */
	private async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
		try {
			// For native BNB, use WBNB price
			const priceAddress = tokenAddress.toLowerCase() === this.BNB_CONTRACT.toLowerCase() 
				? this.WBNB_CONTRACT 
				: tokenAddress;
				
			const response = await Moralis.EvmApi.token.getTokenPrice({
				chain: EvmChain.BSC,
				address: priceAddress,
			});
			return response.toJSON().usdPrice || 0;
		} catch (error) {
			console.warn(`Could not get current price for token ${tokenAddress}`);
			return 0;
		}
	}

	/**
	 * Get current wallet balances
	 */
	private async getCurrentBalances(address: string) {
		const balances = [];

		try {
			// Get BNB balance
			const nativeBalance = await Moralis.EvmApi.balance.getNativeBalance({
				chain: EvmChain.BSC,
				address,
			});

			const bnbBalance = parseFloat(nativeBalance.toJSON().balance) / Math.pow(10, 18);
			if (bnbBalance > 0) {
				balances.push({
					tokenAddress: this.BNB_CONTRACT,
					tokenSymbol: "BNB",
					balance: bnbBalance,
				});
			}

			// Get ERC20 token balances
			try {
				const tokenBalances = await Moralis.EvmApi.token.getWalletTokenBalances({
					chain: EvmChain.BSC,
					address,
				});

				for (const token of tokenBalances.toJSON()) {
					const balance = parseFloat(token.balance) / Math.pow(10, parseInt(token.decimals.toString()));
					if (balance > 0) {
						balances.push({
							tokenAddress: token.token_address,
							tokenSymbol: token.symbol,
							balance,
						});
					}
				}
			} catch (tokenError: any) {
				// Handle wallets with 2000+ tokens
				if (tokenError.message?.includes("2000 tokens")) {
					console.warn("Wallet has 2000+ tokens, fetching only tokens from recent transactions");
					// We'll still calculate PnL based on transaction history
				} else {
					logger.error('Error getting token balances', { error: tokenError instanceof Error ? tokenError.message : String(tokenError) });
				}
			}
		} catch (error) {
			logger.error('Error getting current balances', { address, error: error instanceof Error ? error.message : String(error) });
		}

		return balances;
	}

	/**
	 * Calculate PnL
	 */
	private async calculatePnL(
		transactions: TokenTransaction[],
		currentBalances: any[],
	): Promise<PnLCalculation> {
		const tokenMap = new Map<
			string,
			{
				transactions: TokenTransaction[];
				currentBalance: number;
				currentPrice: number;
			}
		>();

		// Organize data
		for (const tx of transactions) {
			if (!tokenMap.has(tx.tokenAddress)) {
				const currentBalance =
					currentBalances.find(
						(b) => b.tokenAddress.toLowerCase() === tx.tokenAddress.toLowerCase(),
					)?.balance || 0;

				const currentPrice = await this.getCurrentTokenPrice(tx.tokenAddress);

				tokenMap.set(tx.tokenAddress, {
					transactions: [],
					currentBalance,
					currentPrice,
				});
			}
			tokenMap.get(tx.tokenAddress)!.transactions.push(tx);
		}

		// Calculate PnL for each token
		const tokenBreakdown: TokenPnLBreakdown[] = [];
		let totalRealizedPnL = 0;
		let totalUnrealizedPnL = 0;
		let totalInvested = 0;
		let currentValue = 0;

		for (const [tokenAddress, data] of tokenMap) {
			const tokenPnL = this.calculateTokenPnL(
				data.transactions,
				data.currentBalance,
				data.currentPrice,
			);
			tokenBreakdown.push(tokenPnL);

			totalRealizedPnL += tokenPnL.realizedPnL;
			totalUnrealizedPnL += tokenPnL.unrealizedPnL;
			totalInvested += tokenPnL.totalInvested;
			currentValue += tokenPnL.currentValue;
		}

		return {
			totalRealizedPnL,
			totalUnrealizedPnL,
			totalPnL: totalRealizedPnL + totalUnrealizedPnL,
			tokenBreakdown,
			totalInvested,
			currentPortfolioValue: currentValue,
			portfolioReturn: totalInvested > 0 
				? ((totalRealizedPnL + totalUnrealizedPnL) / totalInvested) * 100 
				: 0,
		};
	}

	/**
	 * Calculate PnL for a single token using FIFO method
	 */
	private calculateTokenPnL(
		transactions: TokenTransaction[],
		currentBalance: number,
		currentPrice: number,
	): TokenPnLBreakdown {
		// Sort transactions by timestamp
		const sortedTransactions = [...transactions].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime()
		);
		
		// Separate buy and sell transactions
		const buyTransactions = sortedTransactions.filter(tx => tx.type === 'buy');
		const sellTransactions = sortedTransactions.filter(tx => tx.type === 'sell');
		
		// Calculate totals
		const totalBought = buyTransactions.reduce((sum, tx) => sum + tx.amount, 0);
		const totalSold = sellTransactions.reduce((sum, tx) => sum + tx.amount, 0);
		const totalBuyValue = buyTransactions.reduce((sum, tx) => sum + tx.usdValue, 0);
		const totalSellValue = sellTransactions.reduce((sum, tx) => sum + tx.usdValue, 0);
		
		// Calculate average prices
		const averageBuyPrice = totalBought > 0 ? totalBuyValue / totalBought : 0;
		const averageSellPrice = totalSold > 0 ? totalSellValue / totalSold : 0;
		
		// Calculate realized PnL using FIFO
		const realizedPnL = this.calculateRealizedPnLFIFO(buyTransactions, sellTransactions);
		
		// Calculate unrealized PnL
		let unrealizedPnL = 0;
		if (currentBalance > 0 && currentPrice > 0) {
			// Calculate remaining cost basis using FIFO
			const remainingCostBasis = this.calculateRemainingCostBasis(
				buyTransactions,
				sellTransactions,
				currentBalance
			);
			unrealizedPnL = (currentPrice * currentBalance) - remainingCostBasis;
		}
		
		const currentValue = currentBalance * currentPrice;
		const returnPercentage = totalBuyValue > 0
			? ((realizedPnL + unrealizedPnL) / totalBuyValue) * 100
			: 0;

		return {
			tokenAddress: transactions[0]?.tokenAddress || "",
			tokenSymbol: transactions[0]?.tokenSymbol || "",
			totalBought,
			totalSold,
			currentHoldings: currentBalance,
			averageBuyPrice,
			averageSellPrice,
			currentPrice,
			realizedPnL,
			unrealizedPnL,
			totalPnL: realizedPnL + unrealizedPnL,
			totalInvested: totalBuyValue,
			currentValue,
			returnPercentage
		};
	}

	/**
	 * Get total invested amount
	 */
	private getTotalInvested(transactions: TokenTransaction[]): number {
		return transactions
			.filter((tx) => tx.type === "buy")
			.reduce((sum, tx) => sum + tx.usdValue, 0);
	}

	/**
	 * Calculate realized PnL using FIFO (First In, First Out) method
	 */
	private calculateRealizedPnLFIFO(
		buyTransactions: TokenTransaction[],
		sellTransactions: TokenTransaction[]
	): number {
		// Sort by timestamp (oldest first)
		const sortedBuys = [...buyTransactions].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime()
		);
		const sortedSells = [...sellTransactions].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime()
		);

		let realizedPnL = 0;
		let buyIndex = 0;
		let remainingBuyAmount = 0;

		for (const sell of sortedSells) {
			let remainingSellAmount = sell.amount;
			const sellPricePerUnit = sell.usdValue / sell.amount;

			while (remainingSellAmount > 0 && buyIndex < sortedBuys.length) {
				if (remainingBuyAmount === 0) {
					remainingBuyAmount = sortedBuys[buyIndex].amount;
				}

				const buyPricePerUnit = sortedBuys[buyIndex].usdValue / sortedBuys[buyIndex].amount;
				const amountToMatch = Math.min(remainingSellAmount, remainingBuyAmount);

				// Calculate PnL for this portion
				const pnl = (sellPricePerUnit - buyPricePerUnit) * amountToMatch;
				realizedPnL += pnl;

				remainingSellAmount -= amountToMatch;
				remainingBuyAmount -= amountToMatch;

				if (remainingBuyAmount === 0) {
					buyIndex++;
				}
			}
		}

		return realizedPnL;
	}

	/**
	 * Calculate remaining cost basis using FIFO method
	 */
	private calculateRemainingCostBasis(
		buyTransactions: TokenTransaction[],
		sellTransactions: TokenTransaction[],
		currentHoldings: number
	): number {
		// Sort by timestamp (oldest first)
		const sortedBuys = [...buyTransactions].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime()
		);
		const sortedSells = [...sellTransactions].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime()
		);

		// Build FIFO queue of remaining holdings
		const fifoQueue: FIFOQueueItem[] = [];
		let buyIndex = 0;
		let remainingBuyAmount = 0;

		// Process all sells to determine what's left
		for (const sell of sortedSells) {
			let remainingSellAmount = sell.amount;

			while (remainingSellAmount > 0 && buyIndex < sortedBuys.length) {
				if (remainingBuyAmount === 0) {
					const buy = sortedBuys[buyIndex];
					remainingBuyAmount = buy.amount;
					// Add to FIFO queue
					fifoQueue.push({
						amount: buy.amount,
						pricePerUnit: buy.usdValue / buy.amount,
						timestamp: buy.timestamp
					});
				}

				const amountToRemove = Math.min(remainingSellAmount, remainingBuyAmount);
				
				// Update the last item in queue
				if (fifoQueue.length > 0) {
					fifoQueue[fifoQueue.length - 1].amount -= amountToRemove;
					if (fifoQueue[fifoQueue.length - 1].amount <= 0) {
						fifoQueue.pop();
					}
				}

				remainingSellAmount -= amountToRemove;
				remainingBuyAmount -= amountToRemove;

				if (remainingBuyAmount === 0) {
					buyIndex++;
				}
			}
		}

		// Add any remaining buys to the queue
		while (buyIndex < sortedBuys.length) {
			const buy = sortedBuys[buyIndex];
			const amount = buyIndex === sortedBuys.length - 1 && remainingBuyAmount > 0
				? remainingBuyAmount
				: buy.amount;
			
			fifoQueue.push({
				amount,
				pricePerUnit: buy.usdValue / buy.amount,
				timestamp: buy.timestamp
			});
			buyIndex++;
			remainingBuyAmount = 0;
		}

		// Calculate cost basis from remaining holdings
		let costBasis = 0;
		let remainingToAccount = currentHoldings;

		for (const item of fifoQueue) {
			if (remainingToAccount <= 0) break;
			
			const amountToUse = Math.min(item.amount, remainingToAccount);
			costBasis += amountToUse * item.pricePerUnit;
			remainingToAccount -= amountToUse;
		}

		// If we couldn't account for all holdings (data mismatch), use average cost
		if (remainingToAccount > 0) {
			console.warn('Holdings mismatch in FIFO calculation, using average cost for remainder');
			const totalBuyValue = buyTransactions.reduce((sum, tx) => sum + tx.usdValue, 0);
			const totalBought = buyTransactions.reduce((sum, tx) => sum + tx.amount, 0);
			const avgCost = totalBought > 0 ? totalBuyValue / totalBought : 0;
			costBasis += remainingToAccount * avgCost;
		}

		return costBasis;
	}

	/**
	 * Format PnL message with comprehensive breakdown
	 */
	formatPnLMessage(pnlData: PnLCalculation, address: string): string {
		const totalPnLEmoji = pnlData.totalPnL >= 0 ? "🟢" : "🔴";
		const totalPnLSign = pnlData.totalPnL >= 0 ? "+" : "";
		const returnSign = pnlData.portfolioReturn >= 0 ? "+" : "";

		let message = "📊 *Complete Portfolio Analysis (7 Days)*\n";
		message += `👛 \`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n`;

		// Overall summary
		message += `${totalPnLEmoji} *Total PnL*: ${totalPnLSign}$${pnlData.totalPnL.toFixed(2)} (${returnSign}${pnlData.portfolioReturn.toFixed(2)}%)\n\n`;
		
		// Detailed breakdown
		message += `💰 *Portfolio Summary*:\n`;
		message += `• Total Invested: $${pnlData.totalInvested.toFixed(2)}\n`;
		message += `• Current Value: $${pnlData.currentPortfolioValue.toFixed(2)}\n`;
		message += `• Realized PnL: ${pnlData.totalRealizedPnL >= 0 ? "+" : ""}$${pnlData.totalRealizedPnL.toFixed(2)}\n`;
		message += `• Unrealized PnL: ${pnlData.totalUnrealizedPnL >= 0 ? "+" : ""}$${pnlData.totalUnrealizedPnL.toFixed(2)}\n\n`;

		// Token performance ranking
		if (pnlData.tokenBreakdown.length > 0) {
			message += "*🏆 Token Performance:*\n\n";
			
			const sortedTokens = pnlData.tokenBreakdown
				.sort((a, b) => b.totalPnL - a.totalPnL)
				.slice(0, 5);

			sortedTokens.forEach((token, index) => {
				const tokenPnLEmoji = token.totalPnL >= 0 ? "🟢" : "🔴";
				const tokenPnLSign = token.totalPnL >= 0 ? "+" : "";
				const tokenReturnSign = token.returnPercentage >= 0 ? "+" : "";

				message += `${index + 1}. *${token.tokenSymbol}*\n`;
				message += `   ${tokenPnLEmoji} Total: ${tokenPnLSign}$${token.totalPnL.toFixed(2)} (${tokenReturnSign}${token.returnPercentage.toFixed(2)}%)\n`;
				message += `   💎 Realized: ${token.realizedPnL >= 0 ? "+" : ""}$${token.realizedPnL.toFixed(2)}\n`;
				message += `   📈 Unrealized: ${token.unrealizedPnL >= 0 ? "+" : ""}$${token.unrealizedPnL.toFixed(2)}\n`;
				message += `   💰 Holdings: ${token.currentHoldings.toFixed(4)} (Value: $${token.currentValue.toFixed(2)})\n\n`;
			});
		}

		message += `⏰ *Analysis Period*: Last 7 days\n`;
		message += `🔄 *Method*: FIFO cost basis calculation`;

		return message;
	}
} 