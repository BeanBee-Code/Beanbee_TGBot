import { TransactionModel } from '../database/models/Transaction';
import { PNLModel, PNL, TokenPNL } from '../database/models/PNL';
import { TransactionHistoryService } from './transactionHistory';
import { subDays } from 'date-fns';
import { ethers } from 'ethers';
import { TokenAnalyzer, TokenMetadata } from './rugAlerts/tokenAnalyzer';
import Moralis from 'moralis';
import { EvmChain } from '@moralisweb3/common-evm-utils';
import { getUserLanguage, t } from '@/i18n';
import { createLogger } from '@/utils/logger';
import { pythPriceService } from './pyth/priceService';

const logger = createLogger('pnlCalculator');

interface TokenTransaction {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName?: string;
  amountIn: number;
  amountOut: number;
  valueInBNB: number;
  hash: string;
  timestamp: string;
}

export class PNLCalculatorService {
  private static readonly WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  private static readonly BNB_DECIMALS = 18;
  private static tokenAnalyzer = new TokenAnalyzer();

  /**
   * Calculates PNL for a wallet address based on 7-day transaction history
   */
  static async calculatePNL(walletAddress: string): Promise<PNL> {
    try {
      // Check if we have existing PNL data
      const existingPNL = await PNLModel.findOne({ walletAddress: walletAddress.toLowerCase() });
      
      // Get the latest transaction from cache
      const latestTransaction = await TransactionModel.findOne({ 
        walletAddress: walletAddress.toLowerCase() 
      }).sort({ blockTimestamp: -1 });

      // If we have existing PNL and it's up to date, check if we have token metadata and detailed PNL
      if (existingPNL && latestTransaction && existingPNL.lastTransaction === latestTransaction.hash) {
        // Force recalculation if missing token metadata or detailed PNL
        if (!existingPNL.tokenMetadata || Object.keys(existingPNL.tokenMetadata).length === 0 || !existingPNL.detailedPNL) {
          logger.info('Existing PNL found but missing token metadata or detailed PNL, recalculating...', { address: walletAddress });
        } else {
          return existingPNL;
        }
      }

      // If we have existing PNL but it's outdated, update transactions
      if (existingPNL && existingPNL.lastTransaction && latestTransaction) {
        await TransactionHistoryService.updateTransactionHistory(walletAddress, existingPNL.lastTransaction);
      } else {
        // Otherwise, fetch full 7-day history
        await TransactionHistoryService.fetchAndSaveTransactionHistory(walletAddress);
      }

      // Get all transactions from the last 7 days
      const sevenDaysAgo = subDays(new Date(), 7);
      const transactions = await TransactionHistoryService.getCachedTransactions(walletAddress, sevenDaysAgo);

      // Calculate PNL for each token
      const tokenPNL: Record<string, number> = {};
      const tokenTransactions: Record<string, TokenTransaction[]> = {};

      for (const tx of transactions) {
        // Process ERC20 transfers
        if (tx.erc20Transfers && Array.isArray(tx.erc20Transfers) && tx.erc20Transfers.length > 0) {
          for (const transfer of tx.erc20Transfers) {
            const tokenAddress = transfer.address?.toLowerCase() || transfer.token_address?.toLowerCase();
            if (!tokenAddress) continue;

            // Initialize token tracking
            if (!tokenTransactions[tokenAddress]) {
              tokenTransactions[tokenAddress] = [];
            }

            const amount = parseFloat(transfer.value_formatted || transfer.value || '0');
            const tokenSymbol = transfer.token_symbol || transfer.tokenSymbol || 'Unknown';

            // Determine if this is a buy or sell
            const isBuy = (transfer.to_address || transfer.to)?.toLowerCase() === walletAddress.toLowerCase();
            const isSell = (transfer.from_address || transfer.from)?.toLowerCase() === walletAddress.toLowerCase();

            if (isBuy || isSell) {
              // Calculate BNB value from transaction
              let bnbValue = 0;
              
              // Check native transfers for BNB swap
              if (tx.nativeTransfers && Array.isArray(tx.nativeTransfers) && tx.nativeTransfers.length > 0) {
                for (const nativeTransfer of tx.nativeTransfers) {
                  if (typeof nativeTransfer === 'object' && nativeTransfer !== null) {
                    if (nativeTransfer.token_symbol === 'BNB' || nativeTransfer.address?.toLowerCase() === this.WBNB_ADDRESS.toLowerCase()) {
                      const value = nativeTransfer.value_formatted || nativeTransfer.value || '0';
                      // If value is already formatted, use it directly, otherwise convert from wei
                      bnbValue = nativeTransfer.value_formatted ? parseFloat(value) : parseFloat(value) / 1e18;
                      break;
                    }
                  }
                }
              }

              // If no native transfer found, use transaction value
              if (bnbValue === 0 && tx.valueDecimal) {
                bnbValue = tx.valueDecimal;
              }

              tokenTransactions[tokenAddress].push({
                tokenAddress,
                tokenSymbol,
                tokenName: transfer.token_name || transfer.tokenName,
                amountIn: isBuy ? amount : 0,
                amountOut: isSell ? amount : 0,
                valueInBNB: bnbValue,
                hash: tx.hash,
                timestamp: tx.blockTimestamp.toISOString()
              });
            }
          }
        }
      }

      // Collect all token addresses that need current prices
      const tokenAddressesForPricing = new Set<string>();
      for (const [tokenAddress, txs] of Object.entries(tokenTransactions)) {
        const totalBought = txs.filter(tx => tx.amountIn > 0).reduce((sum, tx) => sum + tx.amountIn, 0);
        const totalSold = txs.filter(tx => tx.amountOut > 0).reduce((sum, tx) => sum + tx.amountOut, 0);
        const remainingTokens = totalBought - totalSold;
        
        // Only need current price if there are remaining tokens
        if (remainingTokens > 0) {
          tokenAddressesForPricing.add(tokenAddress);
        }
      }

      // Batch fetch all current prices from Pyth
      const currentPrices = new Map<string, number>();
      if (tokenAddressesForPricing.size > 0) {
        logger.info('Fetching current prices from Pyth for PNL calculation', { 
          tokenCount: tokenAddressesForPricing.size 
        });
        
        try {
          const pythPrices = await pythPriceService.fetchMultiplePrices(
            Array.from(tokenAddressesForPricing)
          );
          
          // Convert USD prices to BNB prices
          let bnbPriceUSD = pythPrices.get(this.WBNB_ADDRESS.toLowerCase());
          
          // If BNB price not in batch, fetch it separately
          if (!bnbPriceUSD) {
            const bnbPrice = await pythPriceService.fetchPriceByAddress(this.WBNB_ADDRESS);
            bnbPriceUSD = bnbPrice || undefined;
          }
          
          if (bnbPriceUSD && bnbPriceUSD > 0) {
            for (const [tokenAddress, tokenPriceUSD] of pythPrices.entries()) {
              if (tokenPriceUSD > 0) {
                currentPrices.set(tokenAddress, tokenPriceUSD / bnbPriceUSD);
              }
            }
            logger.info('Successfully fetched Pyth prices', { 
              pythPricesFound: currentPrices.size,
              bnbPrice: bnbPriceUSD
            });
          }
        } catch (error) {
          logger.error('Error fetching batch prices from Pyth', { 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }

      // Calculate PNL for each token
      let totalPNL = 0;
      let totalRealizedPNL = 0;
      let totalUnrealizedPNL = 0;
      const detailedPNL: Record<string, TokenPNL> = {};
      
      for (const [tokenAddress, txs] of Object.entries(tokenTransactions)) {
        const buyTxs = txs.filter(tx => tx.amountIn > 0).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const sellTxs = txs.filter(tx => tx.amountOut > 0).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
        const totalBought = buyTxs.reduce((sum, tx) => sum + tx.amountIn, 0);
        const totalSold = sellTxs.reduce((sum, tx) => sum + tx.amountOut, 0);
        const totalBNBSpent = buyTxs.reduce((sum, tx) => sum + tx.valueInBNB, 0);
        const totalBNBReceived = sellTxs.reduce((sum, tx) => sum + tx.valueInBNB, 0);
        
        // Calculate average buy price
        const averageBuyPrice = totalBought > 0 ? totalBNBSpent / totalBought : 0;
        
        // Calculate realized PNL using FIFO
        const realizedPNL = await this.calculateRealizedPNLFIFO(buyTxs, sellTxs);
        
        // Calculate unrealized PNL
        const remainingTokens = totalBought - totalSold;
        let unrealizedPNL = 0;
        let currentPrice = 0;
        
        if (remainingTokens > 0) {
          // Try to get price from Pyth first
          currentPrice = currentPrices.get(tokenAddress.toLowerCase()) || 0;
          
          // If no Pyth price, fallback to Moralis
          if (currentPrice === 0) {
            logger.debug('No Pyth price available, falling back to Moralis', { tokenAddress });
            currentPrice = await this.getCurrentTokenPrice(tokenAddress);
          }
          
          if (currentPrice > 0) {
            // Calculate remaining cost basis using FIFO
            const remainingCostBasis = this.calculateRemainingCostBasisFIFO(buyTxs, sellTxs, remainingTokens);
            unrealizedPNL = (currentPrice * remainingTokens) - remainingCostBasis;
          }
        }
        
        const totalTokenPNL = realizedPNL + unrealizedPNL;
        
        // Store both legacy and detailed PNL
        tokenPNL[tokenAddress] = totalTokenPNL; // Legacy field
        detailedPNL[tokenAddress] = {
          realizedPNL,
          unrealizedPNL,
          totalPNL: totalTokenPNL,
          currentHoldings: remainingTokens,
          averageBuyPrice,
          currentPrice
        };
        
        totalPNL += totalTokenPNL;
        totalRealizedPNL += realizedPNL;
        totalUnrealizedPNL += unrealizedPNL;
      }

      // Get the latest transaction hash
      const newLatestTransaction = transactions.length > 0 ? transactions[0].hash : '';

      // First, get basic metadata from transaction data
      const tokenMetadata: Record<string, { name: string; symbol: string; decimals: number }> = {};
      const tokenAddresses = Object.keys(tokenPNL);
      
      // Pre-populate with data from transactions
      for (const [tokenAddress, txs] of Object.entries(tokenTransactions)) {
        const firstTx = txs[0];
        if (firstTx) {
          tokenMetadata[tokenAddress] = {
            name: firstTx.tokenName || 'Unknown Token',
            symbol: firstTx.tokenSymbol || 'UNKNOWN',
            decimals: 18
          };
        }
      }
      
      // Try to enhance with Moralis data
      if (tokenAddresses.length > 0) {
        try {
          // Chunk the addresses to avoid URI too large error
          const CHUNK_SIZE = 25; // Safe chunk size for Moralis API
          const chunks = [];
          
          for (let i = 0; i < tokenAddresses.length; i += CHUNK_SIZE) {
            chunks.push(tokenAddresses.slice(i, i + CHUNK_SIZE));
          }
          
          logger.info('Fetching token metadata in chunks', { tokenCount: tokenAddresses.length, chunkCount: chunks.length });
          
          // Process each chunk
          for (const chunk of chunks) {
            try {
              const response = await Moralis.EvmApi.token.getTokenMetadata({
                chain: "0x38", // BSC
                addresses: chunk
              });
              
              const metadataArray = response.toJSON();
              
              // Process the batch response - enhance existing data
              if (Array.isArray(metadataArray)) {
                for (const data of metadataArray) {
                  if (data.address) {
                    const address = data.address.toLowerCase();
                    // Always update with Moralis data if available
                    tokenMetadata[address] = {
                      name: data.name || tokenMetadata[address]?.name || 'Unknown Token',
                      symbol: data.symbol || tokenMetadata[address]?.symbol || 'UNKNOWN',
                      decimals: data.decimals ? Number(data.decimals) : 18
                    };
                  }
                }
              }
            } catch (chunkError) {
              logger.error('Error fetching metadata for chunk', { error: chunkError instanceof Error ? chunkError.message : String(chunkError) });
              // Continue with next chunk
            }
          }
        } catch (error) {
          logger.error('Error batch fetching metadata from Moralis', { error: error instanceof Error ? error.message : String(error) });
        }
        
        // For any tokens still showing as Unknown, try direct contract calls
        for (const tokenAddress of tokenAddresses) {
          if (!tokenMetadata[tokenAddress] || tokenMetadata[tokenAddress].name === 'Unknown Token') {
            try {
              logger.info('Fetching individual metadata', { tokenAddress });
              const metadata = await this.tokenAnalyzer.getTokenMetadata(tokenAddress);
              if (metadata && metadata.name !== 'Unknown') {
                tokenMetadata[tokenAddress] = {
                  name: metadata.name,
                  symbol: metadata.symbol,
                  decimals: metadata.decimals
                };
              }
            } catch (error) {
              logger.error('Error fetching individual metadata', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
              // Keep existing data if available
            }
          }
        }
      }

      // Save or update PNL data
      const pnlData = {
        walletAddress: walletAddress.toLowerCase(),
        lastUpdated: new Date(),
        lastTransaction: newLatestTransaction,
        pnl: tokenPNL,
        detailedPNL,
        totalPNL,
        totalRealizedPNL,
        totalUnrealizedPNL,
        tokenMetadata
      };

      const updatedPNL = await PNLModel.findOneAndUpdate(
        { walletAddress: walletAddress.toLowerCase() },
        pnlData,
        { upsert: true, new: true }
      );

      return updatedPNL;
    } catch (error) {
      logger.error('Error calculating PNL', { address: walletAddress, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Formats PNL data for display with realized and unrealized breakdown
   */
  static async formatPNLForDisplay(pnlData: PNL, telegramId: number): Promise<string> {
    const lang = await getUserLanguage(telegramId);
    let message = `${t(lang, 'pnlAnalysis.title')}\n\n`;
    
    // Check if we have detailed PNL data
    const hasDetailedPNL = pnlData.detailedPNL && Object.keys(pnlData.detailedPNL).length > 0;
    
    if (hasDetailedPNL && pnlData.totalRealizedPNL !== undefined && pnlData.totalUnrealizedPNL !== undefined) {
      // New format with realized/unrealized breakdown
      const totalPnLEmoji = pnlData.totalPNL >= 0 ? '🟢' : '🔴';
      const totalPnLSign = pnlData.totalPNL >= 0 ? '+' : '';
      
      message += `${totalPnLEmoji} *${t(lang, 'pnlAnalysis.totalPnL')}* ${totalPnLSign}${pnlData.totalPNL.toFixed(4)} BNB\n\n`;
      
      message += `${t(lang, 'pnlAnalysis.pnlBreakdown')}\n`;
      message += `${t(lang, 'pnlAnalysis.realizedPnL')} ${pnlData.totalRealizedPNL >= 0 ? '+' : ''}${pnlData.totalRealizedPNL.toFixed(4)} BNB\n`;
      message += `${t(lang, 'pnlAnalysis.unrealizedPnL')} ${pnlData.totalUnrealizedPNL >= 0 ? '+' : ''}${pnlData.totalUnrealizedPNL.toFixed(4)} BNB\n\n`;
      
      if (!pnlData.detailedPNL || Object.keys(pnlData.detailedPNL).length === 0) {
        message += `_${t(lang, 'pnlAnalysis.noTransactions')}_`;
        return message;
      }
      
      message += `*${t(lang, 'pnlAnalysis.tokenPerformance')}*\n`;
      
      // Sort tokens by total PNL
      const sortedTokens = Object.entries(pnlData.detailedPNL!)
        .sort(([, a], [, b]) => b.totalPNL - a.totalPNL);
      
      // Telegram has a 4096 character limit for messages
      const MAX_MESSAGE_LENGTH = 3800; // Leave some buffer
      const MAX_TOKENS_TO_SHOW = 20; // Show top 20 tokens max
      let tokenCount = 0;
      let currentMessageLength = message.length;
      
      for (const [tokenAddress, tokenPNL] of sortedTokens) {
        if (tokenCount >= MAX_TOKENS_TO_SHOW) break;
        
        const emoji = tokenPNL.totalPNL >= 0 ? '🟢' : '🔴';
        const sign = tokenPNL.totalPNL >= 0 ? '+' : '';
        
        // Get token metadata
        const metadata = pnlData.tokenMetadata?.[tokenAddress];
        const rawTokenName = metadata?.name || 'Unknown Token';
        const rawTokenSymbol = metadata?.symbol || 'UNKNOWN';
        
        // Escape special Markdown characters
        const escapeMarkdown = (text: string): string => {
          return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
        };
        
        const tokenName = escapeMarkdown(rawTokenName);
        const tokenSymbol = escapeMarkdown(rawTokenSymbol);
        
        // Build token section
        let tokenSection = `\n${emoji} [${tokenName.slice(0, 30)}](https://bscscan.com/token/${tokenAddress}) (${tokenSymbol})\n`;
        tokenSection += `   ${t(lang, 'pnlAnalysis.total')} ${sign}${tokenPNL.totalPNL.toFixed(4)} BNB\n`;
        
        // Only show realized if non-zero AND different from total (meaning there's unrealized component)
        if (Math.abs(tokenPNL.realizedPNL) > 0.0001 && Math.abs(tokenPNL.unrealizedPNL) > 0.0001) {
          tokenSection += `   📈 Realized: ${tokenPNL.realizedPNL >= 0 ? '+' : ''}${tokenPNL.realizedPNL.toFixed(4)} BNB\n`;
        }
        
        // Only show unrealized if non-zero
        if (Math.abs(tokenPNL.unrealizedPNL) > 0.0001) {
          tokenSection += `   📊 Unrealized: ${tokenPNL.unrealizedPNL >= 0 ? '+' : ''}${tokenPNL.unrealizedPNL.toFixed(4)} BNB\n`;
        }
        
        // Only show holdings if greater than a meaningful amount
        if (tokenPNL.currentHoldings > 0.0001) {
          tokenSection += `   ${t(lang, 'pnlAnalysis.holdings')} ${tokenPNL.currentHoldings.toFixed(4)} ${t(lang, 'pnlAnalysis.tokens')}\n`;
        }
        
        // Check if adding this token would exceed the limit
        if (currentMessageLength + tokenSection.length > MAX_MESSAGE_LENGTH) {
          // Add a note about remaining tokens
          const remainingTokens = sortedTokens.length - tokenCount;
          if (remainingTokens > 0) {
            message += `\n_... and ${remainingTokens} more tokens_\n`;
          }
          break;
        }
        
        message += tokenSection;
        currentMessageLength += tokenSection.length;
        tokenCount++;
      }
      
      // Add a note if we showed all tokens
      if (tokenCount === sortedTokens.length && sortedTokens.length > MAX_TOKENS_TO_SHOW) {
        message += `\n_Showing top ${MAX_TOKENS_TO_SHOW} tokens by PNL_\n`;
      }
    } else {
      // Legacy format for backward compatibility
      message += `💰 *${t(lang, 'pnlAnalysis.totalPnL')} ${pnlData.totalPNL.toFixed(4)} BNB*\n\n`;
      
      if (Object.keys(pnlData.pnl).length === 0) {
        message += `_${t(lang, 'pnlAnalysis.noTransactions')}_`;
        return message;
      }
      
      message += `*${t(lang, 'pnlAnalysis.tokenPerformance')}*\n`;
      
      const sortedTokens = Object.entries(pnlData.pnl)
        .sort(([, a], [, b]) => b - a);
      
      const MAX_TOKENS_TO_SHOW = 25;
      let tokenCount = 0;
      
      for (const [tokenAddress, pnl] of sortedTokens) {
        if (tokenCount >= MAX_TOKENS_TO_SHOW) {
          const remainingTokens = sortedTokens.length - tokenCount;
          if (remainingTokens > 0) {
            message += `\n_... and ${remainingTokens} more tokens_\n`;
          }
          break;
        }
        
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        const sign = pnl >= 0 ? '+' : '';
        
        const metadata = pnlData.tokenMetadata?.[tokenAddress];
        const rawTokenName = metadata?.name || 'Unknown Token';
        const rawTokenSymbol = metadata?.symbol || 'UNKNOWN';
        
        // Escape special Markdown characters
        const escapeMarkdown = (text: string): string => {
          return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
        };
        
        const tokenName = escapeMarkdown(rawTokenName);
        const tokenSymbol = escapeMarkdown(rawTokenSymbol);
        
        message += `${emoji} [${tokenName.slice(0, 30)}](https://bscscan.com/token/${tokenAddress}) (${tokenSymbol}): ${sign}${pnl.toFixed(4)} BNB\n`;
        tokenCount++;
      }
    }
    
    message += `\n${t(lang, 'pnlAnalysis.lastUpdated')} ${pnlData.lastUpdated.toLocaleString()}_`;
    message += `\n${t(lang, 'pnlAnalysis.method')}_`;
    
    return message;
  }

  /**
   * Calculate realized PNL using FIFO method
   */
  private static async calculateRealizedPNLFIFO(buyTxs: TokenTransaction[], sellTxs: TokenTransaction[]): Promise<number> {
    let realizedPNL = 0;
    let buyIndex = 0;
    let remainingBuyAmount = 0;

    for (const sell of sellTxs) {
      let remainingSellAmount = sell.amountOut;
      const sellValuePerToken = sell.valueInBNB / sell.amountOut;

      while (remainingSellAmount > 0 && buyIndex < buyTxs.length) {
        if (remainingBuyAmount === 0) {
          remainingBuyAmount = buyTxs[buyIndex].amountIn;
        }

        const buyValuePerToken = buyTxs[buyIndex].valueInBNB / buyTxs[buyIndex].amountIn;
        const amountToMatch = Math.min(remainingSellAmount, remainingBuyAmount);

        // Calculate PNL for this portion (in BNB)
        const pnl = (sellValuePerToken - buyValuePerToken) * amountToMatch;
        realizedPNL += pnl;

        remainingSellAmount -= amountToMatch;
        remainingBuyAmount -= amountToMatch;

        if (remainingBuyAmount === 0) {
          buyIndex++;
        }
      }
    }

    return realizedPNL;
  }

  /**
   * Calculate remaining cost basis using FIFO method
   */
  private static calculateRemainingCostBasisFIFO(buyTxs: TokenTransaction[], sellTxs: TokenTransaction[], remainingTokens: number): number {
    // First, simulate FIFO sells to determine which buys are consumed
    let buyIndex = 0;
    let remainingBuyAmount = 0;

    for (const sell of sellTxs) {
      let remainingSellAmount = sell.amountOut;

      while (remainingSellAmount > 0 && buyIndex < buyTxs.length) {
        if (remainingBuyAmount === 0) {
          remainingBuyAmount = buyTxs[buyIndex].amountIn;
        }

        const amountToConsume = Math.min(remainingSellAmount, remainingBuyAmount);
        remainingSellAmount -= amountToConsume;
        remainingBuyAmount -= amountToConsume;

        if (remainingBuyAmount === 0) {
          buyIndex++;
        }
      }
    }

    // Now calculate cost basis for remaining tokens
    let costBasis = 0;
    let tokensToAccount = remainingTokens;

    // Continue from where we left off after processing sells
    while (tokensToAccount > 0 && buyIndex < buyTxs.length) {
      if (remainingBuyAmount === 0) {
        remainingBuyAmount = buyTxs[buyIndex].amountIn;
      }

      const amountToUse = Math.min(tokensToAccount, remainingBuyAmount);
      const buyValuePerToken = buyTxs[buyIndex].valueInBNB / buyTxs[buyIndex].amountIn;
      costBasis += amountToUse * buyValuePerToken;

      tokensToAccount -= amountToUse;
      remainingBuyAmount -= amountToUse;

      if (remainingBuyAmount === 0) {
        buyIndex++;
      }
    }

    return costBasis;
  }

  /**
   * Get current token price in BNB
   */
  private static async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const response = await Moralis.EvmApi.token.getTokenPrice({
        chain: EvmChain.BSC,
        address: tokenAddress,
      });
      
      const tokenPriceUSD = response.toJSON().usdPrice || 0;
      
      // Get BNB price in USD
      const bnbResponse = await Moralis.EvmApi.token.getTokenPrice({
        chain: EvmChain.BSC,
        address: this.WBNB_ADDRESS,
      });
      
      const bnbPriceUSD = bnbResponse.toJSON().usdPrice || 0;
      
      // Convert token price to BNB
      if (bnbPriceUSD > 0) {
        return tokenPriceUSD / bnbPriceUSD;
      }
      
      return 0;
    } catch (error: any) {
      // Handle specific Moralis errors gracefully
      if (error.code === 'C0006' && error.details?.status === 404) {
        // Token has no liquidity or price data available
        logger.info('No price data available for token', { tokenAddress });
      } else {
        console.warn(`Could not get current price for token ${tokenAddress}:`, error.message || error);
      }
      return 0;
    }
  }
}