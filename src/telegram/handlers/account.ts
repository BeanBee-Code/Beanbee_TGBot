import { Context } from 'telegraf';
import { accountMenu, accountMenuEdit } from '../menus/account';
import { KeeperService } from '../../services/keeper';
import { getUserLanguage } from '../../i18n';
import { createLogger } from '@/utils/logger';
import { escapeMarkdown } from '@/utils/markdown';

const logger = createLogger('telegram.account');

export async function handleAccountMenu(ctx: Context) {
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    // Ignore timeout errors
  }
  
  try {
    await accountMenuEdit(ctx);
  } catch (error) {
    await accountMenu(ctx);
  }
}

export async function handleClaimHoney(ctx: Context) {
  logger.info('🍯 handleClaimHoney called', { userId: ctx.from?.id });
  
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('No userId found in handleClaimHoney');
    try {
      await ctx.answerCbQuery('❌ User ID not found');
      logger.info('Sent user ID not found response');
    } catch (error) {
      logger.error('Failed to answer callback query for missing userId', { error });
    }
    return;
  }

  const lang = await getUserLanguage(userId);
  
  try {
    logger.info('Processing honey claim request', { userId });
    const result = await KeeperService.claimDailyHoney(userId);
    logger.info('Honey claim result', { userId, success: result.success, amount: result.amount });

    if (result.success) {
      logger.info('🎉 Honey claim successful, preparing success message', { userId });
      const keeperStatus = await KeeperService.getKeeperStatus(userId);
      const roleInfo = KeeperService.getRoleInfo(keeperStatus.role!);
      const badge = await KeeperService.getUserBadge(userId);
      
      // Create clear, encouraging messages
      const getSuccessMessage = (role: string, amount: number, isZh: boolean) => {
        const roleEmojis = {
          'keeper': '🧪',
          'worker_bee': '🐝', 
          'forager': '🍄',
          'swarm_leader': '🧭',
          'queen_bee': '👑'
        };
        
        const emoji = roleEmojis[role as keyof typeof roleEmojis] || '🍯';
        
        if (isZh) {
          return `${emoji} 太棒了！成功领取 ${amount} 蜂蜜！\n\n🎉 继续保持，明天再来领取更多奖励！`;
        } else {
          return `${emoji} Awesome! Successfully claimed ${amount} honey!\n\n🎉 Keep it up, come back tomorrow for more rewards!`;
        }
      };
      
      const baseMessage = getSuccessMessage(keeperStatus.role!, result.amount || 0, lang === 'zh');
      const consecutiveDays = keeperStatus.consecutiveDays || 0;
      
      // Add streak bonus for long-term users
      let streakBonus = '';
      if (consecutiveDays >= 7) {
        streakBonus = lang === 'zh' 
          ? `\n🔥 哇！连续 ${consecutiveDays} 天签到！你真是太厉害了！` 
          : `\n🔥 Wow! ${consecutiveDays} days streak! You're amazing!`;
      } else if (consecutiveDays >= 3) {
        streakBonus = lang === 'zh'
          ? `\n⭐ 连续 ${consecutiveDays} 天！加油继续！`
          : `\n⭐ ${consecutiveDays} days in a row! Keep going!`;
      }
      
      const finalMessage = `${baseMessage}${streakBonus}`;
      
      logger.info('🚀 About to send success response', { userId, messageLength: finalMessage.length });
      await ctx.answerCbQuery(finalMessage, { show_alert: true });
      logger.info('✅ Success response sent successfully', { userId });
      
      // Refresh the account menu to show updated honey count
      await accountMenuEdit(ctx);
    } else {
      if (result.nextClaimTime) {
        const hoursLeft = Math.ceil((result.nextClaimTime.getTime() - Date.now()) / (1000 * 60 * 60));
        const minutesLeft = Math.ceil((result.nextClaimTime.getTime() - Date.now()) / (1000 * 60));
        
        // Simple, clear cooldown messages
        const getCooldownMessage = (hours: number, minutes: number, isZh: boolean) => {
          if (hours <= 1) {
            const mins = minutes % 60;
            return isZh 
              ? `⏰ 还需要等 ${mins} 分钟才能再次领取！\n\n💡 明天记得回来哦！`
              : `⏰ Need to wait ${mins} more minutes!\n\n💡 Remember to come back tomorrow!`;
          } else {
            return isZh
              ? `⏰ 还需要等 ${hours} 小时才能再次领取！\n\n🗓️ 每天都可以领取蜂蜜奖励哦！`
              : `⏰ Need to wait ${hours} more hours!\n\n🗓️ You can claim honey rewards every day!`;
          }
        };
        
        const message = getCooldownMessage(hoursLeft, minutesLeft, lang === 'zh');
        logger.info('🕒 About to send cooldown response', { userId, hoursLeft, messageLength: message.length });
        await ctx.answerCbQuery(message, { show_alert: true });
        logger.info('✅ Cooldown response sent successfully', { userId, hoursLeft });
      } else {
        const message = lang === 'zh'
          ? `😅 抱歉，出现了一点小问题！\n\n🔄 请稍后再试一下！`
          : `😅 Sorry, something went wrong!\n\n🔄 Please try again in a moment!`;
        
        logger.info('❌ About to send error response', { userId });
        await ctx.answerCbQuery(message, { show_alert: true });
        logger.info('✅ Error response sent successfully', { userId });
      }
    }
  } catch (error) {
    logger.error('💥 Error in handleClaimHoney:', { error, userId });
    try {
      const fallbackMsg = lang === 'zh' ? '😓 系统繁忙，请稍后再试！' : '😓 System busy, please try again!';
      logger.info('🔄 Sending fallback error response', { userId });
      await ctx.answerCbQuery(fallbackMsg);
      logger.info('✅ Fallback error response sent', { userId });
    } catch (fallbackError) {
      logger.error('💥 Even fallback response failed:', { error: fallbackError, userId });
    }
  }
}

export async function handleKeeperLeaderboard(ctx: Context) {
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    // Ignore timeout errors
  }
  
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  
  // TODO: Implement leaderboard functionality
  const message = lang === 'zh'
    ? '🚧 排行榜功能即将推出！'
    : '🚧 Leaderboard coming soon!';
  
  await ctx.answerCbQuery(message, { show_alert: true });
}

export async function handleHoneyHistory(ctx: Context) {
  // Check if this is a callback query (from button) or regular message
  const isCallback = 'callbackQuery' in ctx && ctx.callbackQuery;
  
  if (isCallback) {
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug('answerCbQuery error (ignored):', error);
    }
  }
  
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const lang = await getUserLanguage(userId);
    const history = await KeeperService.getHoneyHistory(userId, 10);
    
    if (history.length === 0) {
      const message = lang === 'zh'
        ? '📜 暂无蜂蜜交易记录'
        : '📜 No honey transaction history yet';
      
      const replyMarkup = {
        inline_keyboard: [
          [{ 
            text: lang === 'zh' ? '🔙 返回' : '🔙 Back', 
            callback_data: 'account_menu' 
          }]
        ]
      };
      
      if (isCallback) {
        await ctx.editMessageText(message, {
          reply_markup: replyMarkup
        });
      } else {
        await ctx.reply(message, {
          reply_markup: replyMarkup
        });
      }
      return;
    }

    // Format transaction history
    const isZh = lang === 'zh';
    let message = `📜 *${isZh ? '蜂蜜交易记录' : 'Honey Transaction History'}*\n\n`;
    
    const typeLabels = {
      daily_claim: isZh ? '每日领取' : 'Daily Claim',
      task_reward: isZh ? '任务奖励' : 'Task Reward',
      referral_bonus: isZh ? '推荐奖励' : 'Referral Bonus',
      feature_usage: isZh ? '功能使用' : 'Feature Usage',
      nectr_exchange: isZh ? 'NECTR兑换' : 'NECTR Exchange',
      admin_grant: isZh ? '系统赠送' : 'Admin Grant',
      bnb_purchase: isZh ? 'BNB购买' : 'BNB Purchase'
    };

    const featureLabels = {
      wallet_scan: isZh ? '钱包扫描' : 'Wallet Scan',
      token_analysis: isZh ? '代币分析' : 'Token Analysis',
      rug_alert: isZh ? '跑路预警' : 'Rug Alert',
      strategy_execution: isZh ? '策略执行' : 'Strategy Execution',
      price_alert: isZh ? '价格预警' : 'Price Alert',
      trade_alert: isZh ? '交易预警' : 'Trade Alert',
      yield_tips: isZh ? '收益提示' : 'Yield Tips',
      market_sentiment: isZh ? '市场情绪' : 'Market Sentiment'
    };

    history.forEach((tx: any) => {
      const date = new Date(tx.timestamp);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
      const amount = tx.amount > 0 ? `+${tx.amount}` : tx.amount;
      const rawType = tx.type;
      const type = typeLabels[rawType as keyof typeof typeLabels] || escapeMarkdown(rawType);
      
      message += `${dateStr} | ${amount} 🍯 | ${type}`;
      
      if (tx.feature) {
        const rawFeature = tx.feature;
        const feature = featureLabels[rawFeature as keyof typeof featureLabels] || escapeMarkdown(rawFeature);
        message += ` (${feature})`;
      }
      
      message += `\n${isZh ? '余额' : 'Balance'}: ${tx.balanceAfter} 🍯\n\n`;
    });

    const replyMarkup = {
      inline_keyboard: [
        [{ 
          text: lang === 'zh' ? '🔙 返回账户' : '🔙 Back to Account', 
          callback_data: 'account_menu' 
        }]
      ]
    };
    
    if (isCallback) {
      await ctx.editMessageText(message, {
        reply_markup: replyMarkup,
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.reply(message, {
        reply_markup: replyMarkup,
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    logger.error('Error in handleHoneyHistory:', error);
    const errorMessage = ctx.from ? 
      await getUserLanguage(ctx.from.id) === 'zh' ? 
        '❌ 获取蜂蜜记录时出错，请稍后再试' : 
        '❌ Error fetching honey history, please try again later' :
      '❌ Error fetching honey history';
    
    try {
      await ctx.editMessageText(errorMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ 
              text: ctx.from && await getUserLanguage(ctx.from.id) === 'zh' ? '🔙 返回' : '🔙 Back', 
              callback_data: 'account_menu' 
            }]
          ]
        }
      });
    } catch (editError) {
      // If edit fails, try reply
      await ctx.reply(errorMessage);
    }
  }
}

export async function handleNectrExchange(ctx: Context) {
  // Check if this is a callback query (from button) or regular message
  const isCallback = 'callbackQuery' in ctx && ctx.callbackQuery;
  
  if (isCallback) {
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      // Ignore timeout errors
    }
  }
  
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const isZh = lang === 'zh';
  
  const message = isZh
    ? `💎 *NECTR 兑换系统*\n\n` +
      `🔜 *即将推出！*\n\n` +
      `📋 *功能预览：*\n` +
      `• 💱 使用 NECTR 代币兑换蜂蜜\n` +
      `• 🎁 特殊兑换比例和奖励\n` +
      `• ⏰ 限时兑换活动\n` +
      `• 👑 VIP 专属兑换优惠\n` +
      `• 🔒 质押 NECTR 解锁高级角色\n\n` +
      `🚀 *即将支持的功能：*\n` +
      `• Worker Bee: 质押 1,000 NECTR\n` +
      `• Queen Bee: 质押 10,000 NECTR\n` +
      `• 质押奖励和加成\n\n` +
      `📢 敬请期待更多信息！`
    : `💎 *NECTR Exchange System*\n\n` +
      `🔜 *Coming Soon!*\n\n` +
      `📋 *Features Preview:*\n` +
      `• 💱 Exchange NECTR tokens for Honey\n` +
      `• 🎁 Special exchange rates and bonuses\n` +
      `• ⏰ Limited-time exchange events\n` +
      `• 👑 VIP exclusive exchange benefits\n` +
      `• 🔒 Stake NECTR to unlock advanced roles\n\n` +
      `🚀 *Upcoming Features:*\n` +
      `• Worker Bee: Stake 1,000 NECTR\n` +
      `• Queen Bee: Stake 10,000 NECTR\n` +
      `• Staking rewards and bonuses\n\n` +
      `📢 Stay tuned for more information!`;
  
  const replyMarkup = {
    inline_keyboard: [
      [{ 
        text: isZh ? '🔙 返回账户' : '🔙 Back to Account', 
        callback_data: 'account_menu' 
      }]
    ]
  };
  
  if (isCallback) {
    await ctx.editMessageText(message, {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  } else {
    await ctx.reply(message, {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  }
}

export async function handleHoneyInfo(ctx: Context) {
  // Check if this is a callback query (from button) or regular message
  const isCallback = 'callbackQuery' in ctx && ctx.callbackQuery;
  
  if (isCallback) {
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      // Ignore timeout errors
    }
  }
  
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const isZh = lang === 'zh';
  const balance = await KeeperService.getHoneyBalance(userId);
  
  const message = isZh
    ? `🍯 *蜂蜜系统说明*\n\n` +
      `*什么是蜂蜜？*\n` +
      `蜂蜜是 BeanBee 的核心资源，用于解锁高级功能。\n\n` +
      `*如何获得蜂蜜？*\n` +
      `• 🎁 每日领取（基础 10 + 角色奖励）\n` +
      `• 🎯 完成任务\n` +
      `  - 首次连接钱包: +20 🍯\n` +
      `  - 首次交易: +10 🍯\n` +
      `• 🤝 推荐奖励\n` +
      `  - 好友加入: +15 🍯\n` +
      `  - 好友首次交易: +20 🍯\n` +
      `• 💎 NECTR 代币兑换 🔜（即将推出）\n\n` +
      `*蜂蜜用途*\n` +
      `• 钱包扫描 (2🍯) - 分析钱包持仓和收益\n` +
      `• 跑路预警 (3🍯) - 智能检测代币风险\n` +
      `• 收益提示 (2🍯) - 发现 DeFi 机会\n` +
      `• 市场情绪 (2🍯) - AI 分析市场趋势\n` +
      `• 更多功能开发中...\n\n` +
      `*角色体系*\n` +
      `• 🧪 守护者 (Keeper): 10 🍯/天\n` +
      `• 🐝 工蜂 (Worker Bee): 11 🍯/天 (+1)\n` +
      `• 🍄 采集者 (Forager): 11 🍯/天 (+1)\n` +
      `  🔜 专属命令: /freshalpha\n` +
      `• 🧭 蜂群领袖 (Swarm Leader): 11 🍯/天 (+1)\n` +
      `  🔜 专属命令: /airdrops, /watchwhales\n` +
      `• 👑 蜂后 (Queen Bee): 15 🍯/天 (+5)\n` +
      `  🔜 专属命令: /autoalerts, /vaultoptimizer\n\n` +
      `*升级条件*\n` +
      `• Worker Bee: 7天连续+100蜂蜜燃烧 或 1,000 NECTR质押 🔜\n` +
      `• Forager: 500次工具使用 或 10个成功推荐\n` +
      `• Swarm Leader: 20+推荐 或 蜂蜜燃烧Top 50\n` +
      `• Queen Bee: 10,000 NECTR质押 🔜 或 50个成功推荐\n\n` +
      `💡 *提示*: 保持活跃、使用功能、邀请朋友都能帮助升级！\n\n` +
      `当前余额: ${balance} 🍯`
    : `🍯 *Honey System Guide*\n\n` +
      `*What is Honey?*\n` +
      `Honey is BeanBee's core resource for unlocking premium features.\n\n` +
      `*How to Earn Honey?*\n` +
      `• 🎁 Daily claim (base 10 + role bonus)\n` +
      `• 🎯 Complete tasks\n` +
      `  - First wallet connection: +20 🍯\n` +
      `  - First trade: +10 🍯\n` +
      `• 🤝 Referral rewards\n` +
      `  - Friend joins: +15 🍯\n` +
      `  - Friend's first trade: +20 🍯\n` +
      `• 💎 NECTR token exchange 🔜 (coming soon)\n\n` +
      `*Honey Usage*\n` +
      `• Wallet Scan (2🍯) - Analyze wallet holdings & profits\n` +
      `• Rug Alerts (3🍯) - Smart token risk detection\n` +
      `• Yield Tips (2🍯) - Discover DeFi opportunities\n` +
      `• Market Sentiment (2🍯) - AI market trend analysis\n` +
      `• More features in development...\n\n` +
      `*Role System*\n` +
      `• 🧪 Keeper: 10 🍯/day\n` +
      `• 🐝 Worker Bee: 11 🍯/day (+1)\n` +
      `• 🍄 Forager: 11 🍯/day (+1)\n` +
      `  🔜 Exclusive command: /freshalpha\n` +
      `• 🧭 Swarm Leader: 11 🍯/day (+1)\n` +
      `  🔜 Exclusive commands: /airdrops, /watchwhales\n` +
      `• 👑 Queen Bee: 15 🍯/day (+5)\n` +
      `  🔜 Exclusive commands: /autoalerts, /vaultoptimizer\n\n` +
      `*Upgrade Requirements*\n` +
      `• Worker Bee: 7-day streak + 100 honey burned OR 1,000 NECTR staked 🔜\n` +
      `• Forager: 500 tool uses OR 10 successful referrals\n` +
      `• Swarm Leader: 20+ referrals OR Top 50 honey burners\n` +
      `• Queen Bee: 10,000 NECTR staked 🔜 OR 50 successful referrals\n\n` +
      `💡 *Tip*: Stay active, use features & invite friends to level up!\n\n` +
      `Current Balance: ${balance} 🍯`;
  
  const replyMarkup = {
    inline_keyboard: [
      [{ 
        text: isZh ? '🔙 返回账户' : '🔙 Back to Account', 
        callback_data: 'account_menu' 
      }]
    ]
  };
  
  // Use appropriate method based on context type
  if (isCallback) {
    await ctx.editMessageText(message, {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  } else {
    await ctx.reply(message, {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  }
}