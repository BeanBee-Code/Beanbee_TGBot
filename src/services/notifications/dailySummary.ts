import { Telegraf } from 'telegraf';
import { UserModel } from '@/database/models/User';
import { TransactionModel } from '@/database/models/Transaction';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { PNLModel } from '@/database/models/PNL';
import { getBNBBalance } from '@/services/wallet/balance';
import { getWalletTokensWithPrices } from '@/services/wallet/scannerUtils';
import logger from '@/utils/logger';
import { geminiAI } from '@/services/ai/geminiService';
import { tavilyNewsService } from '@/services/news/tavilyService';

const log = logger.child({ module: 'dailySummary' });

interface DailySummaryData {
  telegramId: number;
  walletAddress: string;
  currentBalance: number;
  balanceChange24h: number;
  transactions24h: any[];
  defiPositions: any[];
  totalPnL24h: number;
  topGainers: any[];
  topLosers: any[];
  idleFunds: number;
  missedOpportunities: MissedOpportunity[];
  recommendedActions: string[];
}

interface MissedOpportunity {
  type: 'yield' | 'whale_buy' | 'new_pool' | 'price_surge';
  description: string;
  potentialGain?: string;
  tokenAddress?: string;
  apy?: number;
}

export class DailySummaryService {
  private bot: Telegraf;

  constructor(bot: Telegraf) {
    this.bot = bot;
  }

  private getCurrentHourInTimezone(date: Date, timezone: string): number {
    try {
      // Use Intl.DateTimeFormat to get the hour in the specified timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false
      });
      
      const parts = formatter.formatToParts(date);
      const hourPart = parts.find(part => part.type === 'hour');
      
      return hourPart ? parseInt(hourPart.value) : date.getUTCHours();
    } catch (error) {
      // If timezone is invalid, fall back to UTC
      log.warn(`Invalid timezone ${timezone}, falling back to UTC`);
      return date.getUTCHours();
    }
  }

  async generateBeanBeeSummary(telegramId: number): Promise<string> {
    try {
      const user = await UserModel.findOne({ telegramId });
      if (!user || !user.walletAddress) {
        log.warn(`No wallet found for user ${telegramId}`);
        return '';
      }

      const data = await this.collectDailySummaryData(telegramId, user.walletAddress);
      const userName = user.name || 'there';
      
      // Check if user had any activity
      const hasActivity = data.transactions24h.length > 0;
      
      if (!hasActivity && data.totalPnL24h === 0) {
        // No activity message with opportunities
        return this.generateNoActivityMessage(userName, data);
      } else {
        // Regular summary with enhanced insights
        return this.generateActiveMessage(userName, data);
      }
    } catch (error: any) {
      log.error(`Error generating BeanBee summary: ${error.message || 'Unknown error'}`);
      return '';
    }
  }

  private async generateNoActivityMessage(userName: string, data: DailySummaryData): Promise<string> {
    let message = `🐝 Hey ${userName}, BeanBee here — You missed a few things 👀\n\n`;
    message += `Your portfolio's still sitting at $${data.currentBalance.toFixed(2)}, but guess what?\n\n`;
    message += `**No actions. No rebalances. No yield moves.**\nMeanwhile… the hive's been buzzing.\n\n`;
    
    if (data.missedOpportunities.length > 0) {
      message += `🧠 *While you were away:*\n`;
      data.missedOpportunities.slice(0, 3).forEach(opp => {
        message += `• ${opp.description}\n`;
      });
      message += `\n`;
    }
    
    message += `💬 *Wanna catch up?*\n\nLet's:\n`;
    data.recommendedActions.forEach(action => {
      message += `• ${action}\n`;
    });
    
    message += `\n📊 /start - Open BeanBee Dashboard`;
    
    return message;
  }

  private async generateActiveMessage(userName: string, data: DailySummaryData): Promise<string> {
    const greeting = data.balanceChange24h > 0 
      ? `Good morning, ${userName} — your portfolio grew to $${data.currentBalance.toFixed(2)} 📈`
      : `Good morning, ${userName} — your portfolio's at $${data.currentBalance.toFixed(2)}`;
    
    let message = `🐝 ${greeting}\n\n`;
    
    // Performance summary
    if (data.totalPnL24h !== 0) {
      const pnlEmoji = data.totalPnL24h > 0 ? '✅' : '⚠️';
      message += `${pnlEmoji} 24h P&L: ${data.totalPnL24h > 0 ? '+' : ''}$${Math.abs(data.totalPnL24h).toFixed(2)}\n`;
    }
    
    if (data.transactions24h.length > 0) {
      message += `📊 Transactions: ${data.transactions24h.length}\n`;
    }
    
    message += `\n⸻\n\n`;
    
    // Opportunities section
    if (data.missedOpportunities.length > 0) {
      message += `🚨 *Opportunities You Can Still Catch:*\n`;
      data.missedOpportunities.slice(0, 3).forEach(opp => {
        message += `• ${opp.description}\n`;
      });
      message += `\n`;
    }
    
    // Action items
    message += `*What BeanBee Recommends:*\n\n`;
    data.recommendedActions.forEach(action => {
      message += `${action}\n`;
    });
    
    message += `\n⸻\n\n`;
    message += `👉 Ready to make moves?\n`;
    message += `/start - Open Dashboard | /yield - Check Yields`;
    
    return message;
  }

  async generateDailySummary(telegramId: number): Promise<string> {
    try {
      const user = await UserModel.findOne({ telegramId });
      if (!user || !user.walletAddress) {
        log.warn(`No wallet found for user ${telegramId}`);
        return '';
      }

      const data = await this.collectDailySummaryData(telegramId, user.walletAddress);
      
      // Generate BeanBee style summary
      const beanBeeSummary = await this.generateBeanBeeSummary(telegramId);
      
      // Get market news - this is cached so we only make one API call per day
      let newsSection = '';
      try {
        newsSection = await tavilyNewsService.getNewsFormatted();
      } catch (error) {
        log.error('Error getting news section:', error);
        // Continue without news if there's an error
      }
      
      // Combine BeanBee summary with news
      return beanBeeSummary + newsSection;
    } catch (error: any) {
      log.error(`Error generating daily summary: ${error.message || 'Unknown error'}`);
      return '';
    }
  }

  private async collectDailySummaryData(telegramId: number, walletAddress: string): Promise<DailySummaryData> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Get current balance
    const bnbBalance = await getBNBBalance(walletAddress);
    const tokensData = await getWalletTokensWithPrices(walletAddress);
    
    let tokens: any[] = [];
    if (Array.isArray(tokensData)) {
      tokens = tokensData;
    } else if (Array.isArray((tokensData as any).result)) {
      tokens = (tokensData as any).result;
    }
    
    const tokenValue = tokens.reduce((sum, t) => sum + (parseFloat(t.usdValue || '0') || 0), 0);
    const currentBalance = parseFloat(bnbBalance) * 500 + tokenValue; // Assuming BNB price ~$500

    // Get 24h transactions
    const transactions24h = await TransactionModel.find({
      telegramId,
      timestamp: { $gte: yesterday }
    }).sort({ timestamp: -1 });

    // Get active DeFi positions
    const defiPositions = await DeFiPosition.find({
      telegramId,
      '$or': [
        { totalDefiValue: { $gt: 0 } },
        { totalStakingValue: { $gt: 0 } }
      ]
    });

    // Calculate 24h P&L
    const pnlData = await PNLModel.find({
      telegramId,
      timestamp: { $gte: yesterday }
    });
    
    const totalPnL24h = pnlData.reduce((sum, p) => sum + (p.totalRealizedPNL || 0) + (p.totalUnrealizedPNL || 0), 0);

    // Get token holdings and calculate performance
    const holdings = await this.getTokenHoldings(walletAddress);
    const topGainers = holdings
      .filter(h => h.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 3);
    
    const topLosers = holdings
      .filter(h => h.change24h < 0)
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, 3);

    // Calculate balance change (simplified - in production would track historical balance)
    const balanceChange24h = totalPnL24h / currentBalance * 100;

    // Calculate idle funds (BNB not in DeFi)
    const idleFunds = parseFloat(bnbBalance) * 500; // Assuming BNB price ~$500
    
    // Detect missed opportunities
    const missedOpportunities = await this.detectMissedOpportunities(
      walletAddress, 
      transactions24h.length === 0,
      idleFunds,
      telegramId
    );
    
    // Generate recommended actions
    const recommendedActions = this.generateRecommendedActions(
      idleFunds,
      defiPositions.length,
      missedOpportunities
    );

    return {
      telegramId,
      walletAddress,
      currentBalance,
      balanceChange24h,
      transactions24h,
      defiPositions,
      totalPnL24h,
      topGainers,
      topLosers,
      idleFunds,
      missedOpportunities,
      recommendedActions
    };
  }

  private async getTokenHoldings(walletAddress: string): Promise<any[]> {
    try {
      const tokensData = await getWalletTokensWithPrices(walletAddress);
      
      let tokens: any[] = [];
      if (Array.isArray(tokensData)) {
        tokens = tokensData;
      } else if (Array.isArray((tokensData as any).result)) {
        tokens = (tokensData as any).result;
      }
      
      const holdings = tokens
        .filter(token => parseFloat(token.balanceFormatted || '0') > 0)
        .map(token => ({
          symbol: token.symbol || 'UNKNOWN',
          balance: token.balanceFormatted || '0',
          price: parseFloat(token.usdPrice || '0'),
          change24h: parseFloat(token.usdPrice24hrPercentChange || '0'),
          value: parseFloat(token.usdValue || '0')
        }));

      return holdings;
    } catch (error: any) {
      log.error(`Error getting token holdings: ${error.message || 'Unknown error'}`);
      return [];
    }
  }

  private async detectMissedOpportunities(
    walletAddress: string, 
    noActivity: boolean,
    idleFunds: number,
    telegramId: number
  ): Promise<MissedOpportunity[]> {
    const opportunities: MissedOpportunity[] = [];
    
    try {
      // Import yield service to check for high APY opportunities
      const { yieldService } = await import('@/services/defiLlama/yieldService');
      const topPools = await yieldService.getTopYieldOpportunities();
      
      if (topPools.length > 0 && idleFunds > 10) {
        const bestPool = topPools[0];
        const apy = bestPool.apy || (bestPool.apyBase || 0) + (bestPool.apyReward || 0);
        opportunities.push({
          type: 'yield',
          description: `$BNB vaults were paying up to ${apy.toFixed(1)}% APY — you could've rotated idle funds`,
          apy: apy,
          potentialGain: `$${(idleFunds * (apy / 100) / 365).toFixed(2)}/day`
        });
      }
      
      // Check for new high-yield pools
      const newPools = topPools.filter(pool => {
        // Since DeFiLlama doesn't provide creation date, check for newer protocols or high TVL growth
        return pool.tvlUsd > 1000000 && pool.symbol.includes('CAKE');
      }).slice(0, 2);
      
      if (newPools.length > 0) {
        opportunities.push({
          type: 'new_pool',
          description: `${newPools.length} new ${newPools[0].symbol}-based pools launched overnight, one already saw $${(newPools[0].tvlUsd / 1000000).toFixed(1)}M TVL flow in`
        });
      }
      
      // Check whale activity
      if (noActivity) {
        const { whaleTracker } = await import('@/services/whale/whaleTracker');
        const whaleActivities = await whaleTracker.getRecentWhaleActivities();
        
        if (whaleActivities.length > 0) {
          const buyCount = whaleActivities.filter(a => a.action === 'buy').length;
          if (buyCount > 0) {
            opportunities.push({
              type: 'whale_buy',
              description: `${buyCount} whale buys flagged on tokens you could've tracked`
            });
          }
        }
      }
      
      // Check for price surges in tokens user previously held
      const { TransactionModel } = await import('@/database/models/Transaction');
      const userTxs = await TransactionModel.find({ 
        telegramId: telegramId,
        timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
      }).distinct('tokenAddress');
      
      if (userTxs.length > 0 && noActivity) {
        opportunities.push({
          type: 'price_surge',
          description: `Some tokens you previously traded saw significant moves`
        });
      }
      
    } catch (error) {
      log.error('Error detecting missed opportunities:', error);
    }
    
    return opportunities;
  }

  private generateRecommendedActions(
    idleFunds: number,
    defiPositions: number,
    opportunities: MissedOpportunity[]
  ): string[] {
    const actions: string[] = [];
    
    if (idleFunds > 10) {
      actions.push('💰 Scan your wallet for idle funds');
    }
    
    if (opportunities.some(o => o.type === 'yield')) {
      actions.push('📈 Check the new vaults trending now');
    }
    
    if (opportunities.some(o => o.type === 'whale_buy')) {
      actions.push('🐋 Set alerts on the top 3 tokens moving fast');
    }
    
    if (defiPositions === 0) {
      actions.push('🌾 Explore yield farming opportunities');
    }
    
    if (actions.length === 0) {
      actions.push('✅ Keep monitoring your positions');
      actions.push('🔍 Search for new opportunities');
    }
    
    return actions;
  }

  async sendDailySummary(telegramId: number): Promise<void> {
    try {
      const summary = await this.generateDailySummary(telegramId);
      if (!summary) return;

      await this.bot.telegram.sendMessage(
        telegramId,
        summary,
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📊 Open Dashboard', callback_data: 'start' },
                { text: '💰 Check Yields', callback_data: 'yield_tips' }
              ],
              [
                { text: '🔔 Settings', callback_data: 'settings' }
              ]
            ]
          }
        }
      );

      // Update last sent timestamp
      await UserModel.updateOne(
        { telegramId },
        { dailyNotificationLastSent: new Date() }
      );
    } catch (error: any) {
      log.error(`Error sending daily summary to ${telegramId}: ${error.message || 'Unknown error'}`);
    }
  }

  async sendDailySummaries(): Promise<void> {
    const currentTime = new Date();
    
    // Get all enabled users with wallets
    const users = await UserModel.find({
      dailyNotificationEnabled: true,
      walletAddress: { $exists: true, $ne: null }
    });

    // Filter users whose local hour matches their notification hour
    const usersToNotify = users.filter(user => {
      const userTimezone = user.timezone || 'UTC';
      const userLocalHour = this.getCurrentHourInTimezone(currentTime, userTimezone);
      return userLocalHour === user.dailyNotificationHour;
    });

    log.info(`Sending daily summaries to ${usersToNotify.length} users (out of ${users.length} enabled)`);

    // Send summaries in parallel with rate limiting
    const batchSize = 10;
    for (let i = 0; i < usersToNotify.length; i += batchSize) {
      const batch = usersToNotify.slice(i, i + batchSize);
      await Promise.all(
        batch.map(user => this.sendDailySummary(user.telegramId))
      );
      
      // Rate limit to avoid Telegram API limits
      if (i + batchSize < usersToNotify.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}