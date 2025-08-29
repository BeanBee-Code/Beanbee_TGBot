import { Context, Markup } from 'telegraf';
import { LeaderboardService } from '../../services/leaderboard';
import { LeaderboardType } from '../../database/models/Leaderboard';
import { KeeperService } from '../../services/keeper';
import { getUserLanguage } from '../../i18n';

export async function handleLeaderboardMenu(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const isZh = lang === 'zh';

  const message = isZh 
    ? `🏆 *BeanBee 排行榜*\n\n选择要查看的排行榜类型：\n\n⏰ _排行榜每日凌晨 00:00 更新_`
    : `🏆 *BeanBee Leaderboard*\n\nSelect the leaderboard type to view:\n\n⏰ _Leaderboard updates daily at 00:00_`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        isZh ? '🏅 总排行榜' : '🏅 Overall',
        'leaderboard_overall'
      ),
      Markup.button.callback(
        isZh ? '🔥 蜂蜜燃烧' : '🔥 Honey Burned',
        'leaderboard_honey'
      )
    ],
    [
      Markup.button.callback(
        isZh ? '⚡ 连续登录' : '⚡ Login Streak',
        'leaderboard_streak'
      ),
      Markup.button.callback(
        isZh ? '👥 推荐人数' : '👥 Referrals',
        'leaderboard_referrals'
      )
    ],
    [
      Markup.button.callback(
        isZh ? '📊 我的排名' : '📊 My Ranks',
        'leaderboard_my_ranks'
      )
    ],
    [
      Markup.button.callback(
        isZh ? '◀️ 返回' : '◀️ Back',
        'account_menu'
      )
    ]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } catch (error) {
      // Handle "message is not modified" error by ignoring it
      if (error instanceof Error && error.message.includes('message is not modified')) {
        // Message is already the same, just answer the callback query
        await ctx.answerCbQuery().catch(() => {});
        return;
      }
      throw error; // Re-throw other errors
    }
  } else {
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  }
}

export async function handleSpecificLeaderboard(
  ctx: Context, 
  type: LeaderboardType
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const isZh = lang === 'zh';

  try {
    const leaderboard = await LeaderboardService.getLeaderboard(type, undefined, 10);
    const userRank = await LeaderboardService.getUserRank(userId, type);

    let title = '';
    let emptyMessage = '';
    
    switch (type) {
      case LeaderboardType.OVERALL:
        title = isZh ? '🏅 总排行榜 (前10名)' : '🏅 Overall Leaderboard (Top 10)';
        emptyMessage = isZh ? '暂无排行榜数据' : 'No leaderboard data available';
        break;
      case LeaderboardType.HONEY_BURNED:
        title = isZh ? '🔥 蜂蜜燃烧排行榜 (前10名)' : '🔥 Honey Burned Leaderboard (Top 10)';
        emptyMessage = isZh ? '暂无蜂蜜燃烧数据' : 'No honey burning data available';
        break;
      case LeaderboardType.LOGIN_STREAK:
        title = isZh ? '⚡ 连续登录排行榜 (前10名)' : '⚡ Login Streak Leaderboard (Top 10)';
        emptyMessage = isZh ? '暂无连续登录数据' : 'No login streak data available';
        break;
      case LeaderboardType.REFERRALS:
        title = isZh ? '👥 推荐人数排行榜 (前10名)' : '👥 Referrals Leaderboard (Top 10)';
        emptyMessage = isZh ? '暂无推荐数据' : 'No referrals data available';
        break;
    }

    let message = `${title}\n`;
    message += isZh ? '_每日凌晨 00:00 更新_\n\n' : '_Updates daily at 00:00_\n\n';

    if (leaderboard.length === 0) {
      message += emptyMessage;
    } else {
      for (const entry of leaderboard) {
        const rankEmoji = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : '🏆';
        const roleInfo = entry.userRole ? KeeperService.getRoleInfo(entry.userRole as any) : null;
        const roleEmoji = roleInfo?.emoji || '';
        const displayName = entry.userName || `User${entry.telegramId}`;
        
        let scoreText = '';
        if (type === LeaderboardType.OVERALL) {
          scoreText = `${entry.score} ${isZh ? '分' : 'pts'}`;
          // 显示原始数据详情
          if (entry.scoreBreakdown) {
            const breakdown = entry.scoreBreakdown;
            const details = [];
            
            // 检查是否有新格式的原始数据字段
            const hasNewFormat = typeof breakdown.loginStreak === 'number' && 
                                 typeof breakdown.honeyBurned === 'number' && 
                                 typeof breakdown.referrals === 'number';
            
            if (hasNewFormat) {
              // 使用新格式的原始数据
              if (breakdown.loginStreak > 0) {
                details.push(`${isZh ? '登录' : 'Login'}: ${breakdown.loginStreak}${isZh ? '天' : 'd'}`);
              }
              
              if (breakdown.honeyBurned > 0) {
                details.push(`${isZh ? '蜂蜜' : 'Honey'}: ${breakdown.honeyBurned}`);
              }
              
              if (breakdown.referrals > 0) {
                details.push(`${isZh ? '推荐' : 'Ref'}: ${breakdown.referrals}`);
              }
            } else {
              // 兼容旧格式 - 这种情况下需要重新计算排行榜
              details.push(`${isZh ? '⚠️ 需要重新计算' : '⚠️ Need recalculation'}`);
            }
            
            // 显示角色名称
            if (entry.userRole && entry.userRole !== 'keeper') {
              const roleNames: Record<string, { zh: string, en: string }> = {
                'worker_bee': { zh: '工蜂', en: 'Worker' },
                'forager': { zh: '采集者', en: 'Forager' },
                'swarm_leader': { zh: '领袖', en: 'Leader' },
                'queen_bee': { zh: '蜂后', en: 'Queen' }
              };
              const roleName = roleNames[entry.userRole];
              if (roleName) {
                details.push(`${isZh ? '角色' : 'Role'}: ${isZh ? roleName.zh : roleName.en}`);
              }
            }
            
            if (details.length > 0) {
              scoreText += ` (${details.join(', ')})`;
            }
          }
        } else if (type === LeaderboardType.HONEY_BURNED) {
          scoreText = `${entry.score} 🍯`;
        } else if (type === LeaderboardType.LOGIN_STREAK) {
          scoreText = `${entry.score} ${isZh ? '天' : 'days'}`;
        } else if (type === LeaderboardType.REFERRALS) {
          scoreText = `${entry.score} ${isZh ? '人' : 'refs'}`;
        }

        message += `${rankEmoji} #${entry.rank} ${roleEmoji}${displayName}: ${scoreText}\n`;
      }
    }

    // Add user's rank if not in top 10
    if (userRank && userRank.rank > 10) {
      message += `\n${isZh ? '---\n📍 你的排名' : '---\n📍 Your Rank'}\n`;
      const roleInfo = await KeeperService.getKeeperStatus(userId);
      const roleEmoji = roleInfo.role ? KeeperService.getRoleInfo(roleInfo.role).emoji : '';
      
      let scoreText = '';
      if (type === LeaderboardType.OVERALL) {
        scoreText = `${userRank.score.toFixed(1)} ${isZh ? '分' : 'pts'}`;
      } else if (type === LeaderboardType.HONEY_BURNED) {
        scoreText = `${userRank.score} 🍯`;
      } else if (type === LeaderboardType.LOGIN_STREAK) {
        scoreText = `${userRank.score} ${isZh ? '天' : 'days'}`;
      } else if (type === LeaderboardType.REFERRALS) {
        scoreText = `${userRank.score} ${isZh ? '人' : 'refs'}`;
      }

      message += `🏆 #${userRank.rank} ${roleEmoji}${isZh ? '你' : 'You'}: ${scoreText}\n`;
      message += `${isZh ? '共' : 'Total'} ${userRank.totalParticipants} ${isZh ? '位参与者' : 'participants'}`;
    } else if (userRank) {
      message += `\n${isZh ? '🎉 你在前10名！' : '🎉 You\'re in the top 10!'}`;
    } else {
      message += `\n${isZh ? '📊 你还没有数据，开始使用功能来获得排名吧！' : '📊 You don\'t have data yet. Start using features to get ranked!'}`;
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          isZh ? '◀️ 返回排行榜' : '◀️ Back to Leaderboard',
          'leaderboard_menu'
        )
      ]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    const errorMessage = isZh 
      ? '❌ 获取排行榜数据时出错，请稍后再试'
      : '❌ Error getting leaderboard data, please try again later';
    
    await ctx.editMessageText(errorMessage, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(isZh ? '◀️ 返回' : '◀️ Back', 'leaderboard_menu')]
      ]).reply_markup
    });
  }
}

export async function handleMyRanks(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const isZh = lang === 'zh';

  try {
    const [overallRank, honeyRank, streakRank, referralsRank] = await Promise.all([
      LeaderboardService.getUserRank(userId, LeaderboardType.OVERALL),
      LeaderboardService.getUserRank(userId, LeaderboardType.HONEY_BURNED),
      LeaderboardService.getUserRank(userId, LeaderboardType.LOGIN_STREAK),
      LeaderboardService.getUserRank(userId, LeaderboardType.REFERRALS)
    ]);

    const keeperStatus = await KeeperService.getKeeperStatus(userId);
    const roleEmoji = keeperStatus.role ? KeeperService.getRoleInfo(keeperStatus.role).emoji : '🧪';

    let message = `📊 ${isZh ? '我的排名' : 'My Rankings'}\n${roleEmoji} ${isZh ? '身份' : 'Role'}: ${keeperStatus.role ? (isZh ? KeeperService.getRoleInfo(keeperStatus.role).nameCn : KeeperService.getRoleInfo(keeperStatus.role).name) : (isZh ? '守护者' : 'Keeper')}\n\n`;

    const formatRank = (rank: any, label: string, unit: string) => {
      if (!rank) {
        return `${label}: ${isZh ? '未上榜' : 'Not ranked'}\n`;
      }
      return `${label}: #${rank.rank}/${rank.totalParticipants} (${rank.score}${unit})\n`;
    };

    message += formatRank(overallRank, isZh ? '🏅 总排行榜' : '🏅 Overall', isZh ? '分' : 'pts');
    message += formatRank(honeyRank, isZh ? '🔥 蜂蜜燃烧' : '🔥 Honey Burned', '🍯');
    message += formatRank(streakRank, isZh ? '⚡ 连续登录' : '⚡ Login Streak', isZh ? '天' : ' days');
    message += formatRank(referralsRank, isZh ? '👥 推荐人数' : '👥 Referrals', isZh ? '人' : ' refs');
    
    // 添加评分说明
    message += `\n💡 ${isZh ? '评分说明' : 'Scoring Info'}:\n`;
    message += isZh 
      ? `• 总排行榜 = 登录分 + 蜂蜜分 + 推荐分 + 角色加成\n• 🔜 NECTR质押将成为未来主要评分标准\n• ⏰ 排行榜每日凌晨 00:00 更新`
      : `• Overall = Login + Honey + Referral + Role Bonus\n• 🔜 NECTR staking will be main scoring in future\n• ⏰ Leaderboard updates daily at 00:00`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          isZh ? '◀️ 返回排行榜' : '◀️ Back to Leaderboard',
          'leaderboard_menu'
        )
      ]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    const errorMessage = isZh 
      ? '❌ 获取排名数据时出错，请稍后再试'
      : '❌ Error getting ranking data, please try again later';
    
    await ctx.editMessageText(errorMessage, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(isZh ? '◀️ 返回' : '◀️ Back', 'leaderboard_menu')]
      ]).reply_markup
    });
  }
}

