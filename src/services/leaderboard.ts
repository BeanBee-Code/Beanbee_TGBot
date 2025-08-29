import { UserModel } from '../database/models/User';
import { LeaderboardEntryModel, LeaderboardType, LeaderboardEntry } from '../database/models/Leaderboard';
import { KeeperService } from './keeper';
import { createLogger } from '../utils/logger';

const logger = createLogger('leaderboard');

export class LeaderboardService {
  /**
   * Calculate and update leaderboards for a specific period
   */
  static async updateLeaderboards(period?: string): Promise<void> {
    const currentPeriod = period || this.getCurrentWeekPeriod();
    
    logger.info(`Updating leaderboards for period: ${currentPeriod}`);

    try {
      // Update each leaderboard type
      await Promise.all([
        this.updateOverallLeaderboard(currentPeriod),
        this.updateHoneyBurnedLeaderboard(currentPeriod),
        this.updateLoginStreakLeaderboard(currentPeriod),
        this.updateReferralsLeaderboard(currentPeriod)
      ]);

      logger.info(`Successfully updated all leaderboards for period: ${currentPeriod}`);
    } catch (error) {
      logger.error('Failed to update leaderboards', { error, period: currentPeriod });
      throw error;
    }
  }

  /**
   * Update overall leaderboard (intelligent weighted combination of all metrics)
   */
  private static async updateOverallLeaderboard(period: string): Promise<void> {
    logger.info(`Updating overall leaderboard for period: ${period}`);
    
    const users = await UserModel.find({ isKeeper: true }).lean();
    logger.info(`Found ${users.length} keeper users for leaderboard calculation`);
    const entries: Array<{
      telegramId: number;
      score: number;
      scoreBreakdown: any;
      userName?: string;
      userRole?: string;
    }> = [];

    for (const user of users) {
      const loginStreak = user.consecutiveActiveDays || 0;
      const honeyBurned = user.totalHoneyBurned || 0;
      const actionsUsed = user.totalActionsUsed || 0; // 仅用于显示，不计入总分
      const referrals = user.activeReferralsCount || 0;
      const totalReferrals = referrals; // 使用活跃推荐数作为总推荐数
      
      // 计算各项评分
      const loginScore = this.calculateLoginScore(loginStreak);
      const honeyScore = this.calculateHoneyScore(honeyBurned, actionsUsed);
      const referralScore = this.calculateReferralScore(referrals, totalReferrals);
      
      // 角色加成
      const roleMultiplier = this.getRoleMultiplier(user.role);
      const baseTotal = loginScore + honeyScore + referralScore;
      const totalScore = Math.round(baseTotal * roleMultiplier);

      const scoreBreakdown = {
        // 评分分数（用于内部计算）
        loginScore: Math.round(loginScore * 100) / 100,
        honeyScore: Math.round(honeyScore * 100) / 100,
        referralScore: Math.round(referralScore * 100) / 100,
        roleBonus: Math.round((baseTotal * (roleMultiplier - 1)) * 100) / 100,
        // 原始数据（用于显示）
        loginStreak: loginStreak,
        honeyBurned: honeyBurned,
        referrals: referrals,
        actionsUsed: actionsUsed,
        nectrStaked: 0 // 未来功能
      };

      // 包含所有用户，即使分数为0（用于调试和完整性）
      entries.push({
        telegramId: user.telegramId,
        score: totalScore,
        scoreBreakdown,
        userName: user.name || `User${user.telegramId}`,
        userRole: user.role || 'keeper'
      });
      
      // 记录用户评分详情用于调试
      if (entries.length <= 3) { // 只记录前几个用户避免日志过多
        logger.info(`User ${user.telegramId} scores:`, {
          loginStreak, honeyBurned, actionsUsed, referrals,
          loginScore, honeyScore, referralScore, totalScore
        });
      }
    }

    // Sort by score descending
    entries.sort((a, b) => b.score - a.score);

    // Save to database
    await this.saveLeaderboardEntries(LeaderboardType.OVERALL, period, entries);
    
    logger.info(`Overall leaderboard updated with ${entries.length} entries for period: ${period}`);
  }

  /**
   * 连续登录评分算法 - 对数增长 + 里程碑奖励
   */
  private static calculateLoginScore(days: number): number {
    if (days === 0) return 0;
    
    // 对数增长基础分
    const baseScore = 15 * Math.log(days + 1);
    
    // 里程碑奖励
    let milestoneBonus = 0;
    if (days >= 7) milestoneBonus += 10;    // 第一周坚持
    if (days >= 30) milestoneBonus += 25;   // 一个月习惯
    if (days >= 90) milestoneBonus += 50;   // 季度忠诚
    if (days >= 365) milestoneBonus += 100; // 年度成就
    
    return baseScore + milestoneBonus;
  }

  /**
   * 蜂蜜燃烧评分算法 - 平方根增长 + 多样化奖励
   */
  private static calculateHoneyScore(honeyBurned: number, actionsUsed: number): number {
    if (honeyBurned === 0) return 0;
    
    // 平方根增长，提高蜂蜜重要性
    const baseScore = Math.sqrt(honeyBurned) * 8;
    
    // 功能多样化奖励 (基于总行动次数估算功能使用多样性)
    // 假设每种功能平均使用10次，最多奖励20分
    const estimatedUniqueFeatures = Math.min(Math.floor(actionsUsed / 10), 10);
    const diversityBonus = Math.min(estimatedUniqueFeatures * 2, 20);
    
    return baseScore + diversityBonus;
  }

  /**
   * 推荐人数评分算法 - 指数增长
   */
  private static calculateReferralScore(activeReferrals: number, totalReferrals: number): number {
    if (activeReferrals === 0) return 0;
    
    // 指数增长体现推荐价值，活跃推荐人更有价值
    const baseScore = Math.pow(activeReferrals, 1.2) * 15;
    
    // 简化评分，暂时不使用质量系数（因为没有总推荐数数据）
    // 未来可以添加质量系数：活跃推荐人比例 * 奖励分数
    
    return baseScore;
  }

  /**
   * 角色加成系数
   */
  private static getRoleMultiplier(role?: string): number {
    const multipliers: Record<string, number> = {
      'keeper': 1.0,
      'worker_bee': 1.05,
      'forager': 1.10,
      'swarm_leader': 1.15,
      'queen_bee': 1.20
    };
    return multipliers[role || 'keeper'] || 1.0;
  }

  /**
   * Update honey burned leaderboard
   */
  private static async updateHoneyBurnedLeaderboard(period: string): Promise<void> {
    const users = await UserModel.find({ 
      isKeeper: true, 
      totalHoneyBurned: { $gt: 0 } 
    })
    .sort({ totalHoneyBurned: -1 })
    .lean();

    const entries = users.map(user => ({
      telegramId: user.telegramId,
      score: user.totalHoneyBurned || 0,
      userName: user.name,
      userRole: user.role
    }));

    await this.saveLeaderboardEntries(LeaderboardType.HONEY_BURNED, period, entries);
  }

  /**
   * Update login streak leaderboard
   */
  private static async updateLoginStreakLeaderboard(period: string): Promise<void> {
    const users = await UserModel.find({ 
      isKeeper: true, 
      consecutiveActiveDays: { $gt: 0 } 
    })
    .sort({ consecutiveActiveDays: -1 })
    .lean();

    const entries = users.map(user => ({
      telegramId: user.telegramId,
      score: user.consecutiveActiveDays || 0,
      userName: user.name,
      userRole: user.role
    }));

    await this.saveLeaderboardEntries(LeaderboardType.LOGIN_STREAK, period, entries);
  }


  /**
   * Update referrals leaderboard
   */
  private static async updateReferralsLeaderboard(period: string): Promise<void> {
    const users = await UserModel.find({ 
      isKeeper: true, 
      activeReferralsCount: { $gt: 0 } 
    })
    .sort({ activeReferralsCount: -1 })
    .lean();

    const entries = users.map(user => ({
      telegramId: user.telegramId,
      score: user.activeReferralsCount || 0,
      userName: user.name,
      userRole: user.role
    }));

    await this.saveLeaderboardEntries(LeaderboardType.REFERRALS, period, entries);
  }

  /**
   * Save leaderboard entries to database
   */
  private static async saveLeaderboardEntries(
    type: LeaderboardType, 
    period: string, 
    entries: Array<{
      telegramId: number;
      score: number;
      scoreBreakdown?: any;
      userName?: string;
      userRole?: string;
    }>
  ): Promise<void> {
    // Remove existing entries for this type and period
    await LeaderboardEntryModel.deleteMany({ type, period });

    // Create new entries with ranks
    const leaderboardEntries = entries.map((entry, index) => ({
      telegramId: entry.telegramId,
      type,
      rank: index + 1,
      score: entry.score,
      period,
      userName: entry.userName,
      userRole: entry.userRole,
      scoreBreakdown: entry.scoreBreakdown,
      calculatedAt: new Date()
    }));

    if (leaderboardEntries.length > 0) {
      await LeaderboardEntryModel.insertMany(leaderboardEntries);
    }

    logger.info(`Saved ${leaderboardEntries.length} entries for ${type} leaderboard, period: ${period}`);
  }

  /**
   * Get leaderboard for a specific type and period
   */
  static async getLeaderboard(
    type: LeaderboardType, 
    period?: string, 
    limit: number = 50
  ): Promise<LeaderboardEntry[]> {
    const queryPeriod = period || this.getCurrentWeekPeriod();
    
    return await LeaderboardEntryModel
      .find({ type, period: queryPeriod })
      .sort({ rank: 1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get user's rank in a specific leaderboard
   */
  static async getUserRank(
    telegramId: number, 
    type: LeaderboardType, 
    period?: string
  ): Promise<{
    rank: number;
    score: number;
    totalParticipants: number;
  } | null> {
    const queryPeriod = period || this.getCurrentWeekPeriod();
    
    const entry = await LeaderboardEntryModel.findOne({ 
      telegramId, 
      type, 
      period: queryPeriod 
    });

    if (!entry) return null;

    const totalParticipants = await LeaderboardEntryModel.countDocuments({ 
      type, 
      period: queryPeriod 
    });

    return {
      rank: entry.rank,
      score: entry.score,
      totalParticipants
    };
  }

  /**
   * Check if user is in top N for a specific leaderboard
   */
  static async isInTopN(
    telegramId: number, 
    type: LeaderboardType, 
    topN: number, 
    period?: string
  ): Promise<boolean> {
    const userRank = await this.getUserRank(telegramId, type, period);
    return userRank ? userRank.rank <= topN : false;
  }

  /**
   * Get current week period string (YYYY-WW format)
   */
  private static getCurrentWeekPeriod(): string {
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + yearStart.getDay() + 1) / 7);
    
    return `${now.getFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
  }

  /**
   * Get all available periods for a leaderboard type
   */
  static async getAvailablePeriods(type: LeaderboardType): Promise<string[]> {
    const periods = await LeaderboardEntryModel.distinct('period', { type });
    return periods.sort().reverse(); // Most recent first
  }

  /**
   * Trigger leaderboard recalculation (called by various events)
   */
  static async triggerRecalculation(reason?: string): Promise<void> {
    // No longer supports manual triggering - leaderboards update daily at midnight
    logger.info('Leaderboard recalculation requested but ignored (daily updates only)', { reason });
  }

  /**
   * Get last update time from cache/database
   */
  private static async getLastUpdateTime(): Promise<number> {
    // Simple implementation - in production, consider using Redis or database
    const entry = await LeaderboardEntryModel.findOne()
      .sort({ calculatedAt: -1 })
      .select('calculatedAt');
    
    return entry ? entry.calculatedAt.getTime() : 0;
  }

  /**
   * Set last update time
   */
  private static async setLastUpdateTime(timestamp: number): Promise<void> {
    // This is handled automatically by the calculatedAt field when saving entries
  }

  /**
   * Cleanup old leaderboard entries (keep last 8 weeks)
   */
  static async cleanupOldEntries(): Promise<void> {
    const weeksToKeep = 8;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (weeksToKeep * 7));
    
    const cutoffPeriod = this.getCurrentWeekPeriod();
    
    // Delete entries older than 8 weeks
    const deleteResult = await LeaderboardEntryModel.deleteMany({
      createdAt: { $lt: cutoffDate }
    });

    if (deleteResult.deletedCount > 0) {
      logger.info(`Cleaned up ${deleteResult.deletedCount} old leaderboard entries`);
    }
  }
}