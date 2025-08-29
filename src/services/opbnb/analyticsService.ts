import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { createLogger } from '../../utils/logger';

const moduleLogger = createLogger('opbnbAnalytics');

export interface TokenHolder {
  address: string;
  balance: string;
  percentage?: number;
}

export interface TokenListItem {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  transferCount: number;
  holderCount?: number;
  totalSupply?: string;
}

export interface DailyActivity {
  date: string;
  transferCount: number;
  blockCount: number;
  activeAddresses: number;
}

export interface TokenHealthMetrics {
  holderCount: number;
  topHolderConcentration: number;
  avgDailyTransfers: number;
  liquidityScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  warnings: string[];
  insights: string[];
}

export class OpBNBAnalyticsService {
  private apiKey: string;
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private provider: ethers.JsonRpcProvider;

  constructor() {
    const apiKey = process.env.NODEREAL_API_KEY;
    if (!apiKey) {
      moduleLogger.error("NODEREAL_API_KEY is not configured. Please add it to your .env file.");
      throw new Error("NODEREAL_API_KEY is required for opBNB features. Please add it to your .env file.");
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

  /**
   * Get top token holders with whale analysis
   */
  async getWhaleTracker(tokenAddress: string, limit: number = 20): Promise<{
    holders: TokenHolder[];
    analysis: {
      totalHolders: number;
      whaleCount: number;
      whaleThreshold: string;
      topHolderConcentration: number;
      distribution: {
        top10: number;
        top20: number;
        top50: number;
      };
    };
  }> {
    try {
      moduleLogger.info(`Fetching whale data for token ${tokenAddress}`);
      
      // Get token holders
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenHolders',
        params: [tokenAddress, `0x${limit.toString(16)}`, ''],
        id: 1
      });

      moduleLogger.debug('Token holders API response:', {
        hasResult: !!response.data.result,
        details: response.data.result?.details?.length || 0,
        holders: response.data.result?.holders?.length || 0,
        error: response.data.error
      });

      if (response.data.error) {
        moduleLogger.error('API Error:', response.data.error);
        throw new Error(`API Error: ${response.data.error.message || 'Unknown error'}`);
      }

      // The API returns 'details' array, not 'holders'
      const rawHolders = response.data.result?.details || response.data.result?.holders;
      
      if (!response.data.result || !rawHolders || rawHolders.length === 0) {
        moduleLogger.warn(`No holder data available for token ${tokenAddress}`);
        // Return empty data structure instead of throwing
        return {
          holders: [],
          analysis: {
            totalHolders: 0,
            whaleCount: 0,
            whaleThreshold: '0',
            topHolderConcentration: 0,
            distribution: {
              top10: 0,
              top20: 0,
              top50: 0
            }
          }
        };
      }
      
      // Get holder count
      const holderCountResponse = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenHolderCount',
        params: [tokenAddress],
        id: 1
      });

      const totalHolders = parseInt(holderCountResponse.data.result || '0', 16);

      // Calculate total supply from all fetched holders (this is the best we can do with current API)
      // Note: This gives us the supply held by the top holders, not the total token supply
      const totalSupplyFromHolders = rawHolders.reduce((sum: bigint, holder: any) => {
        const balance = holder.tokenBalance.startsWith('0x') 
          ? BigInt(holder.tokenBalance) 
          : BigInt(holder.tokenBalance);
        return sum + balance;
      }, BigInt(0));

      // For more accurate analysis, we note that these percentages are relative to top holders only
      const totalSupply = totalSupplyFromHolders;

      // Transform holders and calculate percentages
      const holders: TokenHolder[] = rawHolders.map((holder: any) => {
        const balance = holder.tokenBalance.startsWith('0x')
          ? BigInt(holder.tokenBalance)
          : BigInt(holder.tokenBalance);
        const percentage = totalSupply > BigInt(0) 
          ? Number((balance * BigInt(10000)) / totalSupply) / 100
          : 0;

        return {
          address: holder.accountAddress || holder.address,  // Handle both field names
          balance: balance.toString(),
          percentage
        };
      });

      // Sort holders by balance (descending)
      holders.sort((a, b) => {
        const balanceA = BigInt(a.balance);
        const balanceB = BigInt(b.balance);
        if (balanceB > balanceA) return 1;
        if (balanceB < balanceA) return -1;
        return 0;
      });

      // Calculate whale metrics
      const whaleThreshold = (totalSupply * BigInt(1)) / BigInt(100); // 1% of supply
      const whaleCount = holders.filter(h => BigInt(h.balance) >= whaleThreshold).length;

      // Calculate concentration metrics
      const top10Supply = holders.slice(0, 10).reduce((sum, h) => sum + BigInt(h.balance), BigInt(0));
      const top20Supply = holders.slice(0, 20).reduce((sum, h) => sum + BigInt(h.balance), BigInt(0));
      const top50Supply = holders.slice(0, Math.min(50, holders.length)).reduce((sum, h) => sum + BigInt(h.balance), BigInt(0));

      const distribution = {
        top10: totalSupply > BigInt(0) ? Number((top10Supply * BigInt(10000)) / totalSupply) / 100 : 0,
        top20: totalSupply > BigInt(0) ? Number((top20Supply * BigInt(10000)) / totalSupply) / 100 : 0,
        top50: totalSupply > BigInt(0) ? Number((top50Supply * BigInt(10000)) / totalSupply) / 100 : 0,
      };

      return {
        holders,
        analysis: {
          totalHolders,
          whaleCount,
          whaleThreshold: ethers.formatUnits(whaleThreshold, 18),
          topHolderConcentration: holders[0]?.percentage || 0,
          distribution
        }
      };
    } catch (error) {
      moduleLogger.error('Error in whale tracker:', error);
      throw error;
    }
  }

  /**
   * Get hot tokens by transfer activity
   */
  async getHotTokens(limit: number = 20): Promise<TokenListItem[]> {
    try {
      moduleLogger.info(`Fetching hot tokens list`);
      
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenList',
        params: [{
          category: '20',  // ERC20 tokens
          maxCount: `0x${Math.min(limit, 50).toString(16)}`  // Max 50 tokens
        }],
        id: 1
      });

      moduleLogger.debug('Hot tokens API response:', {
        hasResult: !!response.data.result,
        tokens: response.data.result?.tokens?.length || 0,
        error: response.data.error
      });

      if (response.data.error) {
        moduleLogger.error('API Error:', response.data.error);
        return [];
      }

      if (!response.data.result || !response.data.result.tokens || response.data.result.tokens.length === 0) {
        moduleLogger.warn('No hot tokens data available');
        return [];
      }

      // Transform the response to our TokenListItem format
      const tokens: TokenListItem[] = await Promise.all(
        response.data.result.tokens.map(async (token: any) => {
          // Get additional token info and holder count
          let holderCount = 0;
          let tokenSymbol = 'Unknown';
          let transferCount = 0;
          
          try {
            // Get token metadata
            const metaResponse = await this.axiosInstance.post('', {
              jsonrpc: '2.0',
              method: 'nr_getTokenMeta',
              params: [token.TokenAddress],
              id: 1
            });
            
            if (metaResponse.data.result) {
              tokenSymbol = metaResponse.data.result.symbol || 'Unknown';
            }
            
            // Get holder count
            const holderResponse = await this.axiosInstance.post('', {
              jsonrpc: '2.0',
              method: 'nr_getTokenHolderCount',
              params: [token.TokenAddress],
              id: 1
            });
            holderCount = parseInt(holderResponse.data.result || '0', 16);
          } catch (error) {
            moduleLogger.warn(`Could not fetch details for ${token.TokenAddress}`);
          }

          return {
            tokenAddress: token.TokenAddress,
            tokenName: token.Name || 'Unknown Token',
            tokenSymbol: tokenSymbol,
            transferCount: token.ID || 0,  // ID seems to be the ranking/activity indicator
            holderCount,
            totalSupply: undefined
          };
        })
      );

      // Sort by ID/ranking (higher activity first)
      return tokens.sort((a, b) => b.transferCount - a.transferCount);
      
    } catch (error) {
      moduleLogger.error('Error fetching hot tokens:', error);
      return [];
    }
  }

  /**
   * Comprehensive token health check
   */
  async getTokenHealthCheck(tokenAddress: string): Promise<TokenHealthMetrics> {
    try {
      moduleLogger.info(`Performing health check for token ${tokenAddress}`);
      
      // Fetch all necessary data in parallel
      const [metadata, holders, holderCount, dailyActivity] = await Promise.all([
        this.getTokenMetadata(tokenAddress),
        this.getWhaleTracker(tokenAddress, 50),
        this.getTokenHolderCount(tokenAddress),
        this.getDailyActivity('20', 30) // Last 30 days of ERC20 activity
      ]);

      const warnings: string[] = [];
      const insights: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      // Check metadata
      if (!metadata || !metadata.name || !metadata.symbol) {
        warnings.push('⚠️ Missing or incomplete token metadata');
        riskLevel = 'high';
      } else {
        insights.push(`✅ Token: ${metadata.name} (${metadata.symbol})`);
      }

      // Check holder count
      if (holderCount === 0) {
        warnings.push('🚨 No token holders found');
        riskLevel = 'high';
      } else if (holderCount < 10) {
        warnings.push(`⚠️ Very low holder count: ${holderCount}`);
        riskLevel = riskLevel === 'high' ? 'high' : 'medium';
      } else if (holderCount < 100) {
        insights.push(`📊 Holder count: ${holderCount} (growing)`)
      } else {
        insights.push(`✅ Strong holder base: ${holderCount} holders`);
      }

      // Check concentration
      const topHolderConcentration = holders.analysis.topHolderConcentration;
      if (topHolderConcentration > 50) {
        warnings.push(`🚨 Extreme concentration: Top holder owns ${topHolderConcentration.toFixed(2)}%`);
        riskLevel = 'high';
      } else if (topHolderConcentration > 30) {
        warnings.push(`⚠️ High concentration: Top holder owns ${topHolderConcentration.toFixed(2)}%`);
        riskLevel = riskLevel === 'high' ? 'high' : 'medium';
      } else if (topHolderConcentration > 10) {
        insights.push(`📊 Moderate concentration: Top holder owns ${topHolderConcentration.toFixed(2)}%`);
      } else {
        insights.push(`✅ Healthy distribution: Top holder owns ${topHolderConcentration.toFixed(2)}%`);
      }

      // Check distribution
      if (holders.analysis.distribution.top10 > 80) {
        warnings.push(`⚠️ Top 10 holders control ${holders.analysis.distribution.top10.toFixed(2)}% of supply`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Calculate average daily transfers
      const avgDailyTransfers = dailyActivity.reduce((sum, day) => sum + day.transferCount, 0) / dailyActivity.length;
      
      if (avgDailyTransfers < 1) {
        warnings.push('⚠️ Very low trading activity');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      } else if (avgDailyTransfers < 10) {
        insights.push(`📊 Low activity: ~${Math.round(avgDailyTransfers)} transfers/day`);
      } else if (avgDailyTransfers < 100) {
        insights.push(`✅ Moderate activity: ~${Math.round(avgDailyTransfers)} transfers/day`);
      } else {
        insights.push(`🔥 High activity: ~${Math.round(avgDailyTransfers)} transfers/day`);
      }

      // Calculate liquidity score (0-100)
      let liquidityScore = 0;
      if (holderCount > 0) liquidityScore += Math.min(30, holderCount / 10);
      if (topHolderConcentration < 50) liquidityScore += (50 - topHolderConcentration) * 0.6;
      if (avgDailyTransfers > 0) liquidityScore += Math.min(40, avgDailyTransfers);
      liquidityScore = Math.min(100, Math.round(liquidityScore));

      return {
        holderCount,
        topHolderConcentration,
        avgDailyTransfers,
        liquidityScore,
        riskLevel,
        warnings,
        insights
      };
    } catch (error) {
      moduleLogger.error('Error in token health check:', error);
      throw error;
    }
  }

  /**
   * Get network activity data
   */
  async getDailyActivity(category: string = 'external', days: number = 10): Promise<DailyActivity[]> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getDailyCategoryCount',
        params: [{
          category: category,
          totalDay: days
        }],
        id: 1
      });

      if (!response.data.result || !response.data.result.data) {
        return [];
      }

      return response.data.result.data.map((day: any) => ({
        date: day.date,
        transferCount: parseInt(day.transferCount || '0'),
        blockCount: parseInt(day.blockCount || '0'),
        activeAddresses: parseInt(day.activeAddresses || '0')
      }));
    } catch (error) {
      moduleLogger.error('Error fetching daily activity:', error);
      return [];
    }
  }

  /**
   * Get active accounts by balance
   */
  async getTopAccounts(limit: number = 20): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getAccountList',
        params: [`0x1`, `0x${limit.toString(16)}`],
        id: 1
      });

      if (!response.data.result || !response.data.result.accounts) {
        return [];
      }

      return response.data.result.accounts;
    } catch (error) {
      moduleLogger.error('Error fetching top accounts:', error);
      return [];
    }
  }

  private async getTokenMetadata(tokenAddress: string): Promise<any> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenMeta',
        params: [tokenAddress],
        id: 1
      });

      return response.data.result;
    } catch (error) {
      moduleLogger.warn(`Could not fetch metadata for ${tokenAddress}`);
      return null;
    }
  }

  private async getTokenHolderCount(tokenAddress: string): Promise<number> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method: 'nr_getTokenHolderCount',
        params: [tokenAddress],
        id: 1
      });

      return parseInt(response.data.result || '0', 16);
    } catch (error) {
      moduleLogger.warn(`Could not fetch holder count for ${tokenAddress}`);
      return 0;
    }
  }

  /**
   * Format address for display
   */
  formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * Format large numbers
   */
  formatNumber(num: number): string {
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(2);
  }
}

export const opbnbAnalytics = new OpBNBAnalyticsService();