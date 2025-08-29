import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { createLogger } from '../../utils/logger';

const moduleLogger = createLogger('opbnbService');

export interface TokenHolding {
  tokenContractAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  balance: string;
  tokenDecimal?: string;
  tokenType?: string;
}

export interface TokenHoldingsResponse {
  tokenHoldings: TokenHolding[];
  totalCount: string;
}

export interface WalletBalance {
  nativeBNB: string;
  tokens: TokenHolding[];
}

export class OpBNBService {
  private apiKey: string;
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private provider: ethers.JsonRpcProvider;

  constructor() {
    const apiKey = process.env.NODEREAL_API_KEY;
    if (!apiKey) {
      throw new Error("NODEREAL_API_KEY is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = `https://opbnb-mainnet.nodereal.io/v1/${apiKey}`;
    
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.provider = new ethers.JsonRpcProvider(this.baseUrl);
  }

  async getNativeBalance(walletAddress: string): Promise<{ balance: string; formatted: string; usdValue?: number }> {
    try {
      moduleLogger.info(`Fetching native BNB balance for ${walletAddress} on opBNB`);
      
      const balance = await this.provider.getBalance(walletAddress);
      const balanceBNB = ethers.formatEther(balance);
      
      // For now, we'll need to fetch BNB price from an external source
      // You can integrate with your existing price service
      const bnbPrice = await this.getBNBPrice();
      const usdValue = parseFloat(balanceBNB) * bnbPrice;
      
      moduleLogger.info(`BNB balance for ${walletAddress}: ${balanceBNB} BNB ($${usdValue.toFixed(2)})`);
      
      return {
        balance: balance.toString(),
        formatted: `${balanceBNB} BNB`,
        usdValue: usdValue > 0 ? usdValue : undefined
      };
    } catch (error) {
      moduleLogger.error('Error fetching native balance:', error);
      throw error;
    }
  }

  async getTokenBalances(walletAddress: string): Promise<any[]> {
    try {
      moduleLogger.info(`Fetching token balances for ${walletAddress} on opBNB`);
      
      const allTokens: any[] = [];
      const pageSize = 20;
      let currentPage = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.axiosInstance.post('', {
          jsonrpc: '2.0',
          method: 'nr_getTokenHoldings',
          params: [
            walletAddress,
            `0x${currentPage.toString(16)}`,
            `0x${pageSize.toString(16)}`
          ],
          id: currentPage
        });

        if (response.data.result) {
          const { details, totalCount } = response.data.result;
          
          if (details && details.length > 0) {
            // Transform the response format to match the expected interface
            const transformedTokens = await Promise.all(details.map(async (token: any) => {
              const formattedBalance = this.formatBalance(token.tokenBalance, parseInt(token.tokenDecimals || '18', 16));
              
              // Special handling for known stablecoins
              let usdValue: number | undefined;
              const tokenAddress = token.tokenAddress?.toLowerCase();
              
              // USDT on opBNB
              if (tokenAddress === '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3') {
                usdValue = parseFloat(formattedBalance) * 1.0;
                moduleLogger.info(`Applied hardcoded USDT price: ${formattedBalance} USDT = $${usdValue}`);
              }
              // Add more stablecoin addresses as needed
              
              return {
                contractAddress: token.tokenAddress,
                name: token.tokenName,
                symbol: token.tokenSymbol,
                decimals: parseInt(token.tokenDecimals || '18', 16),
                balance: token.tokenBalance,
                formatted: formattedBalance,
                usdValue: usdValue,
                logoUrl: undefined // NodeReal doesn't provide logos
              };
            }));
            
            allTokens.push(...transformedTokens);
          }

          const total = parseInt(totalCount || '0', 16);
          hasMore = allTokens.length < total && details?.length === pageSize;
          currentPage++;
        } else {
          hasMore = false;
        }
      }

      moduleLogger.info(`Found ${allTokens.length} tokens for ${walletAddress}`);
      return allTokens;
    } catch (error) {
      moduleLogger.error('Error fetching token balances:', error);
      throw error;
    }
  }

  async getTransactionHistory(walletAddress: string, limit: number = 10): Promise<any[]> {
    try {
      moduleLogger.info(`Fetching transaction history for ${walletAddress} on opBNB`);
      
      // Fetch transactions where the address is sender
      const sentTxsPromise = this.fetchTransactionsByAddress(walletAddress, 'from', limit);
      
      // Fetch transactions where the address is recipient
      const receivedTxsPromise = this.fetchTransactionsByAddress(walletAddress, 'to', limit);
      
      // Wait for both requests to complete
      const [sentTransactions, receivedTransactions] = await Promise.all([
        sentTxsPromise,
        receivedTxsPromise
      ]);
      
      // Combine and deduplicate transactions by hash
      const txMap = new Map<string, any>();
      
      [...sentTransactions, ...receivedTransactions].forEach(tx => {
        if (!txMap.has(tx.hash)) {
          txMap.set(tx.hash, tx);
        }
      });
      
      // Convert map to array and sort by timestamp (most recent first)
      const allTransactions = Array.from(txMap.values())
        .sort((a, b) => b.blockTimeStamp - a.blockTimeStamp)
        .slice(0, limit);
      
      // Format transactions for display
      const formattedTransactions = allTransactions.map(tx => {
        const valueInBNB = tx.value ? ethers.formatEther(tx.value) : '0';
        const gasFeesInBNB = tx.gasUsed && tx.gasPrice 
          ? ethers.formatEther(BigInt(tx.gasUsed) * BigInt(tx.gasPrice))
          : '0';
        
        return {
          hash: tx.hash,
          blockHeight: parseInt(tx.blockNum, 16),
          timestamp: new Date(tx.blockTimeStamp * 1000).toISOString(),
          from: tx.from,
          to: tx.to || 'Contract Creation',
          value: tx.value,
          gasUsed: tx.gasUsed?.toString() || '0',
          gasPrice: tx.gasPrice?.toString() || '0',
          successful: tx.receiptsStatus === 1,
          fees: tx.gasUsed && tx.gasPrice 
            ? (BigInt(tx.gasUsed) * BigInt(tx.gasPrice)).toString()
            : '0',
          formattedValue: `${valueInBNB} BNB`,
          formattedFees: `${gasFeesInBNB} BNB`,
          category: tx.category,
          tokenInfo: tx.tokenSymbol ? {
            symbol: tx.tokenSymbol,
            name: tx.tokenName,
            decimal: tx.tokenDecimal
          } : undefined
        };
      });
      
      moduleLogger.info(`Found ${formattedTransactions.length} transactions for ${walletAddress}`);
      return formattedTransactions;
    } catch (error) {
      moduleLogger.error('Error fetching transaction history:', error);
      // Return empty array instead of throwing to maintain compatibility
      return [];
    }
  }
  
  private async fetchTransactionsByAddress(
    walletAddress: string, 
    addressType: 'from' | 'to', 
    limit: number
  ): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTransactionByAddress',
        params: [{
          category: ['external', '20', '721', '1155'], // Include all transaction types
          addressType: addressType,
          address: walletAddress.toLowerCase(),
          order: 'desc', // Most recent first
          maxCount: `0x${limit.toString(16)}` // Convert to hex
        }],
        id: 1
      });
      
      if (response.data.result && response.data.result.transfers) {
        return response.data.result.transfers;
      }
      
      return [];
    } catch (error) {
      moduleLogger.error(`Error fetching ${addressType} transactions:`, error);
      return [];
    }
  }

  private formatBalance(balance: string, decimals: number): string {
    if (!balance || balance === '0') return '0';
    
    try {
      // Handle hex strings
      let balanceValue = balance;
      if (balance.startsWith('0x')) {
        balanceValue = BigInt(balance).toString();
      }
      
      return ethers.formatUnits(balanceValue, decimals);
    } catch (error) {
      moduleLogger.error('Error formatting balance:', error);
      return '0';
    }
  }

  private async getBNBPrice(): Promise<number> {
    try {
      // Try to get BNB price from CoinGecko or similar service
      // For now, return a hardcoded value or integrate with your existing price service
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
      return response.data.binancecoin?.usd || 600; // Default to $600 if API fails
    } catch (error) {
      moduleLogger.warn('Could not fetch BNB price, using default value');
      return 600; // Default BNB price
    }
  }

  formatDate(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  shortenAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  async getTokenMeta(tokenAddress: string): Promise<any> {
    try {
      moduleLogger.info(`Fetching token metadata for ${tokenAddress}`);
      
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenMeta',
        params: [tokenAddress],
        id: 1
      });

      if (response.data.result) {
        return response.data.result;
      }
      
      return null;
    } catch (error) {
      moduleLogger.error('Error fetching token metadata:', error);
      throw error;
    }
  }

  async getTokenHolders(tokenAddress: string, maxCount: number = 20): Promise<any> {
    try {
      moduleLogger.info(`Fetching token holders for ${tokenAddress}`);
      
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenHolders',
        params: [tokenAddress, `0x${maxCount.toString(16)}`, ''],
        id: 1
      });

      if (response.data.result) {
        return response.data.result;
      }
      
      return { holders: [], pageKey: null };
    } catch (error) {
      moduleLogger.error('Error fetching token holders:', error);
      throw error;
    }
  }

  async getDailyCategoryCount(category: string = 'external', totalDays: number = 10): Promise<any> {
    try {
      moduleLogger.info(`Fetching daily category count for ${category}`);
      
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getDailyCategoryCount',
        params: [{
          category: category,
          totalDay: totalDays
        }],
        id: 1
      });

      if (response.data.result) {
        return response.data.result;
      }
      
      return null;
    } catch (error) {
      moduleLogger.error('Error fetching daily category count:', error);
      throw error;
    }
  }

  async analyzeToken(tokenAddress: string): Promise<{
    metadata: any;
    holders: any;
    dailyActivity: any;
    analysis: {
      riskLevel: 'low' | 'medium' | 'high';
      warnings: string[];
      insights: string[];
    };
  }> {
    try {
      moduleLogger.info(`Analyzing token ${tokenAddress} on opBNB`);
      
      // Fetch all data in parallel
      const [metadata, holders, dailyActivity] = await Promise.all([
        this.getTokenMeta(tokenAddress),
        this.getTokenHolders(tokenAddress, 50),
        this.getDailyCategoryCount('20', 30) // ERC20 transfers for last 30 days
      ]);

      // Analyze the data for risk indicators
      const warnings: string[] = [];
      const insights: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      // Check metadata
      if (!metadata || !metadata.name || !metadata.symbol) {
        warnings.push('Missing token metadata');
        riskLevel = 'high';
      } else {
        insights.push(`Token: ${metadata.name} (${metadata.symbol})`);
        if (metadata.decimals) {
          insights.push(`Decimals: ${metadata.decimals}`);
        }
      }

      // Analyze holder distribution
      if (holders && holders.holders) {
        const totalHolders = holders.holders.length;
        
        if (totalHolders === 0) {
          warnings.push('No token holders found');
          riskLevel = 'high';
        } else if (totalHolders < 10) {
          warnings.push(`Very low holder count: ${totalHolders}`);
          riskLevel = riskLevel === 'high' ? 'high' : 'medium';
        } else {
          insights.push(`Total holders: ${totalHolders}`);
          
          // Check concentration
          if (totalHolders > 0) {
            const topHolder = holders.holders[0];
            const totalSupply = holders.holders.reduce((sum: bigint, h: any) => {
              try {
                const balance = h.tokenBalance.startsWith('0x') 
                  ? BigInt(h.tokenBalance) 
                  : BigInt(h.tokenBalance);
                return sum + balance;
              } catch {
                return sum;
              }
            }, BigInt(0));
            
            if (totalSupply > BigInt(0) && topHolder) {
              const topHolderBalance = topHolder.tokenBalance.startsWith('0x')
                ? BigInt(topHolder.tokenBalance)
                : BigInt(topHolder.tokenBalance);
              const concentration = (topHolderBalance * BigInt(100)) / totalSupply;
              
              if (concentration > BigInt(50)) {
                warnings.push(`High concentration: Top holder owns ${concentration}% of supply`);
                riskLevel = 'high';
              } else if (concentration > BigInt(30)) {
                warnings.push(`Moderate concentration: Top holder owns ${concentration}% of supply`);
                riskLevel = riskLevel === 'high' ? 'high' : 'medium';
              } else {
                insights.push(`Healthy distribution: Top holder owns ${concentration}% of supply`);
              }
            }
          }
        }
      }

      // Analyze daily activity
      if (dailyActivity && dailyActivity.transfers) {
        const recentActivity = dailyActivity.transfers.slice(-7); // Last 7 days
        const avgTransfers = recentActivity.reduce((sum: number, day: any) => 
          sum + (parseInt(day.transferCount) || 0), 0) / recentActivity.length;
        
        if (avgTransfers < 1) {
          warnings.push('Very low daily transfer activity');
          riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
        } else if (avgTransfers < 10) {
          insights.push(`Low activity: ~${Math.round(avgTransfers)} transfers/day`);
        } else {
          insights.push(`Active: ~${Math.round(avgTransfers)} transfers/day`);
        }
      }

      return {
        metadata,
        holders,
        dailyActivity,
        analysis: {
          riskLevel,
          warnings,
          insights
        }
      };
    } catch (error) {
      moduleLogger.error('Error analyzing token:', error);
      throw error;
    }
  }
}

export const opbnbService = new OpBNBService();