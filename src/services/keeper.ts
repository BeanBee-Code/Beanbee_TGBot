import { UserModel, User } from '../database/models/User';
import { Types } from 'mongoose';
import { HoneyTransactionModel, HoneyTransactionType, HoneyFeature } from '../database/models/HoneyTransaction';

export enum KeeperRole {
  KEEPER = 'keeper',
  WORKER_BEE = 'worker_bee',
  FORAGER = 'forager',
  SWARM_LEADER = 'swarm_leader',
  QUEEN_BEE = 'queen_bee'
}

export interface RoleRequirements {
  streak?: number;
  honeyBurned?: number;
  nectrStaked?: number;
  actionsUsed?: number;
  referrals?: number;
  leaderboardTop?: number;
}

export const ROLE_REQUIREMENTS: Record<KeeperRole, RoleRequirements> = {
  [KeeperRole.KEEPER]: {
    // Default role - no requirements
  },
  [KeeperRole.WORKER_BEE]: {
    // 7-day streak + 100 Honey burned OR 1,000 NECTR staked
    streak: 7,
    honeyBurned: 100,
    nectrStaked: 1000 // Alternative requirement
  },
  [KeeperRole.FORAGER]: {
    // 500 actions used OR 10 successful referrals
    actionsUsed: 500,
    referrals: 10 // Alternative requirement
  },
  [KeeperRole.SWARM_LEADER]: {
    // 20+ referrals OR Leaderboard Top 50 in Honey burned
    referrals: 20,
    leaderboardTop: 50 // Alternative requirement for honey burned leaderboard
  },
  [KeeperRole.QUEEN_BEE]: {
    // Stake 10,000+ NECTR or 50 successful referrals
    nectrStaked: 10000,
    referrals: 50 // Alternative requirement
  }
};

export const DAILY_HONEY_BASE = 10;
export const ROLE_HONEY_BONUS: Record<KeeperRole, number> = {
  [KeeperRole.KEEPER]: 0,      // Base amount only
  [KeeperRole.WORKER_BEE]: 1,  // +1 honey daily
  [KeeperRole.FORAGER]: 1,     // +1 honey daily (same as Worker Bee)
  [KeeperRole.SWARM_LEADER]: 1, // +1 honey daily (same as previous)
  [KeeperRole.QUEEN_BEE]: 5    // +5 honey daily (total bonus, not cumulative)
};

// Honey costs for different features
export const HONEY_COSTS: Record<HoneyFeature, number> = {
  [HoneyFeature.WALLET_SCAN]: 2,
  [HoneyFeature.TOKEN_ANALYSIS]: 3,
  [HoneyFeature.RUG_ALERT]: 3,
  [HoneyFeature.STRATEGY_EXECUTION]: 5,
  [HoneyFeature.PRICE_ALERT]: 1,
  [HoneyFeature.TRADE_ALERT]: 1,
  [HoneyFeature.YIELD_TIPS]: 2,
  [HoneyFeature.MARKET_SENTIMENT]: 2,
  [HoneyFeature.AI_QUERY]: 1 // Cost for natural language AI queries
};

// Honey rewards for tasks
export const HONEY_REWARDS = {
  FIRST_WALLET_CONNECT: 20,
  FIRST_TRADE: 10,
  DAILY_LOGIN: 5,
  REFERRAL_JOINED: 15,
  REFERRAL_TRADED: 20
};

export class KeeperService {
  /**
   * Initialize keeper rewards when user connects wallet for the first time
   * Note: Users are already Keepers by default, this just handles first wallet bonus
   */
  static async initializeKeeper(telegramId: number): Promise<void> {
    const user = await UserModel.findOne({ telegramId });
    // Ensure user exists and is already a keeper (set by findOrCreateUser)
    if (!user || !user.isKeeper) return;

    // Check if user has already received first wallet connection bonus
    const hasReceivedBonus = await HoneyTransactionModel.exists({
      telegramId,
      type: HoneyTransactionType.TASK_REWARD,
      'metadata.task': 'FIRST_WALLET_CONNECT' // Track using metadata
    });

    if (!hasReceivedBonus) {
      // Give first wallet connection bonus
      await this.rewardHoney(
        telegramId, 
        HONEY_REWARDS.FIRST_WALLET_CONNECT, 
        HoneyTransactionType.TASK_REWARD,
        'First wallet connection bonus',
        { task: 'FIRST_WALLET_CONNECT' } // Add metadata to track this specific reward
      );
    }
  }

  /**
   * Claim daily honey rewards
   */
  static async claimDailyHoney(telegramId: number): Promise<{ 
    success: boolean; 
    amount?: number; 
    error?: string;
    nextClaimTime?: Date;
  }> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) {
      return { success: false, error: 'User is not a Keeper' };
    }

    const now = new Date();
    const lastClaim = user.lastHoneyClaimDate;
    
    if (lastClaim) {
      const hoursSinceLastClaim = (now.getTime() - lastClaim.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastClaim < 24) {
        const nextClaimTime = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000);
        return { 
          success: false, 
          error: 'Daily honey already claimed', 
          nextClaimTime 
        };
      }
    }

    const bonus = ROLE_HONEY_BONUS[user.role as KeeperRole] || 0;
    const honeyAmount = DAILY_HONEY_BASE + bonus;

    await UserModel.updateOne(
      { telegramId },
      {
        $inc: {
          dailyHoney: honeyAmount,
          totalHoneyEarned: honeyAmount
        },
        lastHoneyClaimDate: now
      }
    );

    // Record transaction
    await HoneyTransactionModel.create({
      user: user._id,
      telegramId,
      type: HoneyTransactionType.DAILY_CLAIM,
      amount: honeyAmount,
      balanceAfter: user.dailyHoney + honeyAmount,
      description: `Daily honey claim (${user.role} +${bonus} bonus)`,
      timestamp: now
    });

    return { success: true, amount: honeyAmount };
  }

  /**
   * Update daily activity streak
   */
  static async updateActivityStreak(telegramId: number): Promise<void> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) return;

    const now = new Date();
    const lastActive = user.lastActiveDate;
    
    let consecutiveDays = user.consecutiveActiveDays || 0;
    
    if (lastActive) {
      const daysSinceLastActive = Math.floor(
        (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
      );
      
      if (daysSinceLastActive === 1) {
        consecutiveDays += 1;
      } else if (daysSinceLastActive > 1) {
        consecutiveDays = 1;
      }
      // If same day, don't update
    } else {
      consecutiveDays = 1;
    }

    await UserModel.updateOne(
      { telegramId },
      {
        lastActiveDate: now,
        consecutiveActiveDays: consecutiveDays
      }
    );

    // Check for role upgrade
    await this.checkAndUpgradeRole(telegramId);
    
    // Trigger leaderboard update
    try {
      const { LeaderboardService } = await import('./leaderboard');
      await LeaderboardService.triggerRecalculation('activity_streak_updated');
    } catch (error) {
      // Don't fail the main operation if leaderboard update fails
    }
  }


  /**
   * Update active referrals count
   */
  static async updateActiveReferrals(telegramId: number): Promise<void> {
    const user = await UserModel.findOne({ telegramId });
    if (!user) return;

    // Count active referrals (users who connected wallet in last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeReferrals = await UserModel.countDocuments({
      referrer: (user as any)._id,
      walletAddress: { $exists: true },
      lastConnected: { $gte: thirtyDaysAgo }
    });

    await UserModel.updateOne(
      { telegramId },
      { activeReferralsCount: activeReferrals }
    );

    // Check for role upgrade
    await this.checkAndUpgradeRole(telegramId);
    
    // Trigger leaderboard update
    try {
      const { LeaderboardService } = await import('./leaderboard');
      await LeaderboardService.triggerRecalculation('referrals_updated');
    } catch (error) {
      // Don't fail the main operation if leaderboard update fails
    }
  }

  /**
   * Check if user qualifies for role upgrade
   */
  static async checkAndUpgradeRole(telegramId: number): Promise<{
    upgraded: boolean;
    newRole?: KeeperRole;
  }> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) {
      return { upgraded: false };
    }

    const currentRole = user.role as KeeperRole;
    
    // Don't check if already at highest role
    if (currentRole === KeeperRole.QUEEN_BEE) {
      return { upgraded: false };
    }

    // Check Worker Bee requirements: (7-day streak + 100 Honey burned) OR 1,000 NECTR staked
    if (currentRole === KeeperRole.KEEPER) {
      const hasStreak = user.consecutiveActiveDays >= 7;
      const hasHoneyBurned = (user.totalHoneyBurned || 0) >= 100;
      const hasNectrStaked = (user.nectrStaked || 0) >= 1000;
      
      if ((hasStreak && hasHoneyBurned) || hasNectrStaked) {
        await UserModel.updateOne(
          { telegramId },
          { role: KeeperRole.WORKER_BEE, roleUpgradedAt: new Date() }
        );
        return { upgraded: true, newRole: KeeperRole.WORKER_BEE };
      }
    }

    // Check Forager requirements: 500 actions used OR 10 successful referrals
    if (currentRole === KeeperRole.WORKER_BEE) {
      const hasActionsUsed = (user.totalActionsUsed || 0) >= 500;
      const hasReferrals = user.activeReferralsCount >= 10;
      
      if (hasActionsUsed || hasReferrals) {
        await UserModel.updateOne(
          { telegramId },
          { role: KeeperRole.FORAGER, roleUpgradedAt: new Date() }
        );
        return { upgraded: true, newRole: KeeperRole.FORAGER };
      }
    }

    // Check Swarm Leader requirements: 20+ referrals OR Leaderboard Top 50 in Honey burned
    if (currentRole === KeeperRole.FORAGER) {
      const hasReferrals = user.activeReferralsCount >= 20;
      const isTopHoneyBurner = await this.isInTopHoneyBurners(telegramId, 50);
      
      if (hasReferrals || isTopHoneyBurner) {
        await UserModel.updateOne(
          { telegramId },
          { role: KeeperRole.SWARM_LEADER, roleUpgradedAt: new Date() }
        );
        return { upgraded: true, newRole: KeeperRole.SWARM_LEADER };
      }
    }

    // Check Queen Bee requirements: Stake 10,000+ NECTR OR 50 successful referrals
    if (currentRole === KeeperRole.SWARM_LEADER) {
      const hasHighNectrStaked = (user.nectrStaked || 0) >= 10000;
      const hasManyReferrals = user.activeReferralsCount >= 50;
      
      if (hasHighNectrStaked || hasManyReferrals) {
        await UserModel.updateOne(
          { telegramId },
          { role: KeeperRole.QUEEN_BEE, roleUpgradedAt: new Date() }
        );
        return { upgraded: true, newRole: KeeperRole.QUEEN_BEE };
      }
    }

    return { upgraded: false };
  }

  /**
   * Get keeper identity status
   */
  static async getKeeperStatus(telegramId: number): Promise<{
    isKeeper: boolean;
    role?: KeeperRole;
    dailyHoney?: number;
    totalHoney?: number;
    consecutiveDays?: number;
    totalActionsUsed?: number;
    activeReferrals?: number;
    nextRole?: KeeperRole;
    progressToNextRole?: any;
  }> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) {
      return { isKeeper: false };
    }

    const currentRole = user.role as KeeperRole;
    const roles = [KeeperRole.KEEPER, KeeperRole.WORKER_BEE, KeeperRole.FORAGER, KeeperRole.SWARM_LEADER, KeeperRole.QUEEN_BEE];
    const currentIndex = roles.indexOf(currentRole);
    
    let nextRole: KeeperRole | undefined;
    let progressToNextRole: any = {};
    
    // Determine next role and progress based on current role
    switch (currentRole) {
      case KeeperRole.KEEPER:
        nextRole = KeeperRole.WORKER_BEE;
        progressToNextRole = {
          streak: { current: user.consecutiveActiveDays, required: 7 },
          honeyBurned: { current: user.totalHoneyBurned || 0, required: 100 },
          nectrStaked: { current: user.nectrStaked || 0, required: 1000 }
        };
        break;
      
      case KeeperRole.WORKER_BEE:
        nextRole = KeeperRole.FORAGER;
        progressToNextRole = {
          actionsUsed: { current: user.totalActionsUsed || 0, required: 500 },
          referrals: { current: user.activeReferralsCount, required: 10 }
        };
        break;
      
      case KeeperRole.FORAGER:
        nextRole = KeeperRole.SWARM_LEADER;
        const isTop50 = await this.isInTopHoneyBurners(telegramId, 50);
        progressToNextRole = {
          referrals: { current: user.activeReferralsCount, required: 20 },
          leaderboardTop50: { current: isTop50, required: true }
        };
        break;
      
      case KeeperRole.SWARM_LEADER:
        nextRole = KeeperRole.QUEEN_BEE;
        progressToNextRole = {
          nectrStaked: { current: user.nectrStaked || 0, required: 10000 },
          referrals: { current: user.activeReferralsCount, required: 50 }
        };
        break;
    }

    return {
      isKeeper: true,
      role: currentRole,
      dailyHoney: user.dailyHoney,
      totalHoney: user.totalHoneyEarned,
      consecutiveDays: user.consecutiveActiveDays,
      totalActionsUsed: user.totalActionsUsed,
      activeReferrals: user.activeReferralsCount,
      nextRole,
      progressToNextRole
    };
  }

  /**
   * Get role display information
   */
  static getRoleInfo(role: KeeperRole): {
    emoji: string;
    name: string;
    nameCn: string;
  } {
    const roleInfo = {
      [KeeperRole.KEEPER]: { emoji: '🧪', name: 'Keeper', nameCn: '守护者' },
      [KeeperRole.WORKER_BEE]: { emoji: '🐝', name: 'Worker Bee', nameCn: '工蜂' },
      [KeeperRole.FORAGER]: { emoji: '🍄', name: 'Forager', nameCn: '采集者' },
      [KeeperRole.SWARM_LEADER]: { emoji: '🧭', name: 'Swarm Leader', nameCn: '蜂群领袖' },
      [KeeperRole.QUEEN_BEE]: { emoji: '👑', name: 'Queen Bee', nameCn: '蜂后' }
    };
    
    return roleInfo[role] || roleInfo[KeeperRole.KEEPER];
  }

  /**
   * Get user badge to display in interactions
   */
  static async getUserBadge(telegramId: number): Promise<string> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) return '';
    
    const role = user.role as KeeperRole;
    const roleInfo = this.getRoleInfo(role);
    return roleInfo.emoji;
  }

  /**
   * Check if user has enough honey for a feature
   */
  static async hasEnoughHoney(telegramId: number, feature: HoneyFeature): Promise<boolean> {
    const user = await UserModel.findOne({ telegramId });
    if (!user) return false;
    
    const cost = HONEY_COSTS[feature] || 0;
    return user.dailyHoney >= cost;
  }

  /**
   * Consume honey for feature usage
   */
  static async consumeHoney(
    telegramId: number, 
    feature: HoneyFeature,
    metadata?: Record<string, any>
  ): Promise<{
    success: boolean;
    balance?: number;
    error?: string;
  }> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) {
      return { success: false, error: 'User is not a Keeper' };
    }

    const cost = HONEY_COSTS[feature] || 0;
    if (user.dailyHoney < cost) {
      return { 
        success: false, 
        error: `Insufficient honey. Need ${cost}, have ${user.dailyHoney}` 
      };
    }

    const newBalance = user.dailyHoney - cost;
    
    // Update user balance and track burned honey
    await UserModel.updateOne(
      { telegramId },
      { 
        dailyHoney: newBalance,
        $inc: { totalHoneyBurned: cost }
      }
    );

    // Record transaction
    await HoneyTransactionModel.create({
      user: user._id,
      telegramId,
      type: HoneyTransactionType.FEATURE_USAGE,
      amount: -cost,
      balanceAfter: newBalance,
      feature,
      description: `Used ${feature}`,
      metadata,
      timestamp: new Date()
    });

    // Track action usage
    await this.trackActionUsed(telegramId);
    
    // Trigger leaderboard update for honey burned
    try {
      const { LeaderboardService } = await import('./leaderboard');
      await LeaderboardService.triggerRecalculation('honey_burned');
    } catch (error) {
      // Don't fail the main operation if leaderboard update fails
    }

    return { success: true, balance: newBalance };
  }

  /**
   * Reward honey to user
   */
  static async rewardHoney(
    telegramId: number,
    amount: number,
    type: HoneyTransactionType,
    description: string,
    metadata?: Record<string, any>
  ): Promise<{
    success: boolean;
    balance?: number;
    error?: string;
  }> {
    const user = await UserModel.findOne({ telegramId });
    if (!user || !user.isKeeper) {
      return { success: false, error: 'User is not a Keeper' };
    }

    const newBalance = user.dailyHoney + amount;
    
    // Update user balance
    await UserModel.updateOne(
      { telegramId },
      { 
        $inc: { 
          dailyHoney: amount,
          totalHoneyEarned: amount 
        }
      }
    );

    // Record transaction
    await HoneyTransactionModel.create({
      user: user._id,
      telegramId,
      type,
      amount,
      balanceAfter: newBalance,
      description,
      metadata,
      timestamp: new Date()
    });

    return { success: true, balance: newBalance };
  }

  /**
   * Get honey transaction history
   */
  static async getHoneyHistory(
    telegramId: number, 
    limit: number = 10
  ): Promise<any[]> {
    return await HoneyTransactionModel
      .find({ telegramId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get honey balance
   */
  static async getHoneyBalance(telegramId: number): Promise<number> {
    const user = await UserModel.findOne({ telegramId });
    return user?.dailyHoney || 0;
  }

  /**
   * Check if user is in top honey burners
   */
  static async isInTopHoneyBurners(telegramId: number, topN: number): Promise<boolean> {
    // Try to get from leaderboard first (more efficient)
    try {
      const { LeaderboardService } = await import('./leaderboard');
      const { LeaderboardType } = await import('../database/models/Leaderboard');
      return await LeaderboardService.isInTopN(telegramId, LeaderboardType.HONEY_BURNED, topN);
    } catch (error) {
      // Fallback to direct database query
      const users = await UserModel.find({ isKeeper: true, totalHoneyBurned: { $gt: 0 } })
        .sort({ totalHoneyBurned: -1 })
        .limit(topN)
        .select('telegramId');
      
      return users.some(u => u.telegramId === telegramId);
    }
  }

  /**
   * Track action usage
   */
  static async trackActionUsed(telegramId: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      { $inc: { totalActionsUsed: 1 } }
    );
    
    // Check for role upgrade
    await this.checkAndUpgradeRole(telegramId);
    
    // Trigger leaderboard update
    try {
      const { LeaderboardService } = await import('./leaderboard');
      await LeaderboardService.triggerRecalculation('actions_used');
    } catch (error) {
      // Don't fail the main operation if leaderboard update fails
    }
  }

  /**
   * Update honey burned stats
   */
  static async updateHoneyBurned(telegramId: number, amount: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      { $inc: { totalHoneyBurned: amount } }
    );
    
    // Check for role upgrade
    await this.checkAndUpgradeRole(telegramId);
  }
}