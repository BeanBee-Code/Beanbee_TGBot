import { createLogger } from '@/utils/logger';

const logger = createLogger('whale.tracker');

export interface WhaleActivity {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  action: 'buy' | 'sell';
  amountUSD: number;
  walletAddress: string;
  timestamp: Date;
  txHash: string;
}

// Cache for whale activities
let whaleActivityCache: { data: WhaleActivity[]; timestamp: number } | null = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Get recent whale activities on BSC
 * This is a simplified implementation - in production you'd use a proper whale tracking API
 */
export async function getRecentWhaleActivities(minAmountUSD: number = 50000): Promise<WhaleActivity[]> {
  try {
    // Check cache first
    if (whaleActivityCache && Date.now() - whaleActivityCache.timestamp < CACHE_DURATION) {
      return whaleActivityCache.data;
    }

    // In a real implementation, you would:
    // 1. Connect to a whale tracking service API
    // 2. Filter for BSC transactions
    // 3. Get large token transfers
    
    // For now, return simulated data for demonstration
    const activities: WhaleActivity[] = [
      {
        tokenAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        tokenSymbol: 'WBNB',
        tokenName: 'Wrapped BNB',
        action: 'buy',
        amountUSD: 150000,
        walletAddress: '0x' + '0'.repeat(38) + '01',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        txHash: '0x' + Math.random().toString(16).substring(2, 66)
      },
      {
        tokenAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
        tokenSymbol: 'CAKE',
        tokenName: 'PancakeSwap Token',
        action: 'buy',
        amountUSD: 85000,
        walletAddress: '0x' + '0'.repeat(38) + '02',
        timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4 hours ago
        txHash: '0x' + Math.random().toString(16).substring(2, 66)
      }
    ];

    // Update cache
    whaleActivityCache = {
      data: activities,
      timestamp: Date.now()
    };

    return activities;
  } catch (error) {
    logger.error('Error fetching whale activities:', error);
    return [];
  }
}

/**
 * Check if user missed any whale buys on tokens they hold or previously traded
 */
export async function getMissedWhaleOpportunities(
  userTokens: string[],
  userTradedTokens: string[]
): Promise<WhaleActivity[]> {
  try {
    const allActivities = await getRecentWhaleActivities();
    const relevantTokens = new Set([...userTokens, ...userTradedTokens]);
    
    return allActivities.filter(activity => 
      activity.action === 'buy' && 
      relevantTokens.has(activity.tokenAddress.toLowerCase())
    );
  } catch (error) {
    logger.error('Error getting missed whale opportunities:', error);
    return [];
  }
}

/**
 * Get trending tokens based on whale activity
 */
export async function getTrendingTokensByWhaleActivity(limit: number = 5): Promise<{
  tokenAddress: string;
  tokenSymbol: string;
  totalVolume: number;
  buyCount: number;
  sellCount: number;
}[]> {
  try {
    const activities = await getRecentWhaleActivities();
    
    // Aggregate by token
    const tokenStats = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      totalVolume: number;
      buyCount: number;
      sellCount: number;
    }>();
    
    activities.forEach(activity => {
      const key = activity.tokenAddress.toLowerCase();
      const existing = tokenStats.get(key) || {
        tokenAddress: activity.tokenAddress,
        tokenSymbol: activity.tokenSymbol,
        totalVolume: 0,
        buyCount: 0,
        sellCount: 0
      };
      
      existing.totalVolume += activity.amountUSD;
      if (activity.action === 'buy') {
        existing.buyCount++;
      } else {
        existing.sellCount++;
      }
      
      tokenStats.set(key, existing);
    });
    
    // Sort by total volume and return top tokens
    return Array.from(tokenStats.values())
      .sort((a, b) => b.totalVolume - a.totalVolume)
      .slice(0, limit);
  } catch (error) {
    logger.error('Error getting trending tokens:', error);
    return [];
  }
}

// Export singleton service
export const whaleTracker = {
  getRecentWhaleActivities,
  getMissedWhaleOpportunities,
  getTrendingTokensByWhaleActivity
};