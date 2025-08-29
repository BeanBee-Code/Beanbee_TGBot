import { Context } from 'telegraf';
import { createLogger } from '@/utils/logger';

const logger = createLogger('honey.parser');

export interface HoneyCommand {
  action: 'claim' | 'history' | 'info' | 'recharge' | 'leaderboard' | 'account' | 'nectr_exchange';
  subAction?: 'overall' | 'honey_burned' | 'login_streak' | 'referrals' | 'my_ranks';
}

/**
 * Parse natural language text to extract honey-related commands
 */
export function parseHoneyCommand(text: string): HoneyCommand | null {
  const lowerText = text.toLowerCase().trim();
  
  // Check recharge patterns FIRST (higher priority)
  const rechargePatterns = [
    /buy.*honey/i,
    /purchase.*honey/i,
    /recharge.*honey/i,
    /honey.*recharge/i,
    /honey.*buy/i,
    /honey.*purchase/i,
    /top.*up.*honey/i,
    /add.*honey/i,
    /get.*more.*honey/i,
    /need.*more.*honey/i,
    /i.*want.*to.*recharge.*honey/i,
    /i.*want.*to.*buy.*honey/i,
    /i.*want.*to.*purchase.*honey/i,
    /购买.*蜂蜜/i,
    /充值.*蜂蜜/i,
    /蜂蜜.*充值/i,
    /蜂蜜.*购买/i
  ];
  
  if (rechargePatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected honey recharge command', { text });
    return { action: 'recharge' };
  }
  
  // Claim honey patterns
  const claimPatterns = [
    /claim.*honey/i,
    /get.*honey/i,
    /collect.*honey/i,
    /daily.*honey/i,
    /honey.*claim/i,
    /give.*me.*honey/i,
    /i.*want.*honey/i,
    /领取.*蜂蜜/i,
    /蜂蜜.*领取/i,
    /每日.*蜂蜜/i
  ];
  
  if (claimPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected claim honey command', { text });
    return { action: 'claim' };
  }
  
  // Honey history patterns
  const historyPatterns = [
    /honey.*history/i,
    /history.*honey/i,
    /honey.*transaction/i,
    /honey.*record/i,
    /show.*honey.*history/i,
    /check.*honey.*history/i,
    /蜂蜜.*历史/i,
    /蜂蜜.*记录/i,
    /查看.*蜂蜜.*记录/i
  ];
  
  if (historyPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected honey history command', { text });
    return { action: 'history' };
  }
  
  // Honey info patterns
  const infoPatterns = [
    /what.*is.*honey/i,
    /honey.*info/i,
    /info.*honey/i,
    /explain.*honey/i,
    /honey.*system/i,
    /how.*honey.*work/i,
    /honey.*guide/i,
    /什么.*是.*蜂蜜/i,
    /蜂蜜.*说明/i,
    /蜂蜜.*系统/i
  ];
  
  if (infoPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected honey info command', { text });
    return { action: 'info' };
  }
  
  
  // NECTR exchange patterns
  const nectrPatterns = [
    /nectr.*exchange/i,
    /exchange.*nectr/i,
    /nectr.*honey/i,
    /honey.*nectr/i,
    /nectr.*swap/i,
    /nectr.*兑换/i,
    /兑换.*nectr/i
  ];
  
  if (nectrPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected NECTR exchange command', { text });
    return { action: 'nectr_exchange' };
  }
  
  // Leaderboard patterns with sub-actions
  const leaderboardPatterns = [
    { pattern: /overall.*leaderboard|leaderboard.*overall|总.*排行榜|排行榜.*总/i, subAction: 'overall' as const },
    { pattern: /honey.*burn.*leaderboard|burn.*honey.*leaderboard|蜂蜜.*燃烧.*排行|燃烧.*蜂蜜.*排行/i, subAction: 'honey_burned' as const },
    { pattern: /login.*streak.*leaderboard|streak.*leaderboard|连续.*登录.*排行|登录.*连续.*排行/i, subAction: 'login_streak' as const },
    { pattern: /referral.*leaderboard|leaderboard.*referral|推荐.*排行|排行.*推荐/i, subAction: 'referrals' as const },
    { pattern: /my.*rank|rank.*me|我的.*排名|排名.*我的/i, subAction: 'my_ranks' as const }
  ];
  
  for (const { pattern, subAction } of leaderboardPatterns) {
    if (pattern.test(lowerText)) {
      logger.info('Detected specific leaderboard command', { text, subAction });
      return { action: 'leaderboard', subAction };
    }
  }
  
  // General leaderboard patterns
  const generalLeaderboardPatterns = [
    /show.*leaderboard/i,
    /leaderboard/i,
    /ranking/i,
    /top.*users/i,
    /top.*players/i,
    /显示.*排行榜/i,
    /排行榜/i,
    /排名/i
  ];
  
  if (generalLeaderboardPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected general leaderboard command', { text });
    return { action: 'leaderboard' };
  }
  
  // Account menu patterns (for honey balance check)
  const accountPatterns = [
    /honey.*balance/i,
    /check.*honey/i,
    /how.*much.*honey/i,
    /my.*honey/i,
    /show.*account/i,
    /account.*menu/i,
    /蜂蜜.*余额/i,
    /查看.*蜂蜜/i,
    /我的.*蜂蜜/i,
    /账户.*菜单/i
  ];
  
  if (accountPatterns.some(pattern => pattern.test(lowerText))) {
    logger.info('Detected account menu command', { text });
    return { action: 'account' };
  }
  
  return null;
}

/**
 * Execute the parsed honey command
 */
export async function executeHoneyCommand(ctx: Context, command: HoneyCommand): Promise<void> {
  logger.info('Executing honey command', { command });
  
  // For text-based commands, we need to handle responses differently
  // since answerCbQuery is not available for regular messages
  
  switch (command.action) {
    case 'claim':
      // Import the necessary services directly to avoid callback-specific code
      const { KeeperService } = await import('../../services/keeper');
      const { getUserLanguage } = await import('@/i18n');
      
      const userId = ctx.from?.id;
      if (!userId) {
        await ctx.reply('❌ User ID not found');
        return;
      }
      
      const lang = await getUserLanguage(userId);
      
      try {
        const result = await KeeperService.claimDailyHoney(userId);
        
        if (result.success) {
          const keeperStatus = await KeeperService.getKeeperStatus(userId);
          
          const roleEmojis = {
            'keeper': '🧪',
            'worker_bee': '🐝', 
            'forager': '🍄',
            'swarm_leader': '🧭',
            'queen_bee': '👑'
          };
          
          const emoji = roleEmojis[keeperStatus.role as keyof typeof roleEmojis] || '🍯';
          
          let message = lang === 'zh'
            ? `${emoji} 太棒了！成功领取 ${result.amount} 蜂蜜！\n\n🎉 继续保持，明天再来领取更多奖励！`
            : `${emoji} Awesome! Successfully claimed ${result.amount} honey!\n\n🎉 Keep it up, come back tomorrow for more rewards!`;
          
          const consecutiveDays = keeperStatus.consecutiveDays || 0;
          if (consecutiveDays >= 7) {
            message += lang === 'zh' 
              ? `\n\n🔥 哇！连续 ${consecutiveDays} 天签到！你真是太厉害了！` 
              : `\n\n🔥 Wow! ${consecutiveDays} days streak! You're amazing!`;
          } else if (consecutiveDays >= 3) {
            message += lang === 'zh'
              ? `\n\n⭐ 连续 ${consecutiveDays} 天！加油继续！`
              : `\n\n⭐ ${consecutiveDays} days in a row! Keep going!`;
          }
          
          // Show updated balance
          const balance = await KeeperService.getHoneyBalance(userId);
          message += lang === 'zh'
            ? `\n\n💰 当前余额: ${balance} 🍯`
            : `\n\n💰 Current balance: ${balance} 🍯`;
          
          await ctx.reply(message, { parse_mode: 'Markdown' });
        } else {
          if (result.nextClaimTime) {
            const hoursLeft = Math.ceil((result.nextClaimTime.getTime() - Date.now()) / (1000 * 60 * 60));
            const minutesLeft = Math.ceil((result.nextClaimTime.getTime() - Date.now()) / (1000 * 60));
            
            let message = '';
            if (hoursLeft <= 1) {
              const mins = minutesLeft % 60;
              message = lang === 'zh' 
                ? `⏰ 还需要等 ${mins} 分钟才能再次领取！\n\n💡 明天记得回来哦！`
                : `⏰ Need to wait ${mins} more minutes!\n\n💡 Remember to come back tomorrow!`;
            } else {
              message = lang === 'zh'
                ? `⏰ 还需要等 ${hoursLeft} 小时才能再次领取！\n\n🗓️ 每天都可以领取蜂蜜奖励哦！`
                : `⏰ Need to wait ${hoursLeft} more hours!\n\n🗓️ You can claim honey rewards every day!`;
            }
            
            await ctx.reply(message, { parse_mode: 'Markdown' });
          } else {
            const message = lang === 'zh'
              ? `😅 抱歉，出现了一点小问题！\n\n🔄 请稍后再试一下！`
              : `😅 Sorry, something went wrong!\n\n🔄 Please try again in a moment!`;
            
            await ctx.reply(message, { parse_mode: 'Markdown' });
          }
        }
      } catch (error) {
        logger.error('Error claiming honey via text', { error, userId });
        const errorMsg = lang === 'zh' ? '😓 系统繁忙，请稍后再试！' : '😓 System busy, please try again!';
        await ctx.reply(errorMsg);
      }
      break;
      
    case 'history':
      const { handleHoneyHistory } = await import('../handlers/account');
      await handleHoneyHistory(ctx);
      break;
      
    case 'info':
      const { handleHoneyInfo } = await import('../handlers/account');
      await handleHoneyInfo(ctx);
      break;
      
    case 'recharge':
      const { honeyRechargeMenu } = await import('../menus/honeyRecharge');
      await honeyRechargeMenu(ctx);
      break;
      
    case 'nectr_exchange':
      const { handleNectrExchange } = await import('../handlers/account');
      await handleNectrExchange(ctx);
      break;
      
    case 'leaderboard':
      if (command.subAction) {
        // Handle specific leaderboard
        switch (command.subAction) {
          case 'overall':
          case 'honey_burned':
          case 'login_streak':
          case 'referrals':
            const { handleSpecificLeaderboard } = await import('../menus/leaderboard');
            const { LeaderboardType } = await import('../../database/models/Leaderboard');
            const typeMap = {
              'overall': LeaderboardType.OVERALL,
              'honey_burned': LeaderboardType.HONEY_BURNED,
              'login_streak': LeaderboardType.LOGIN_STREAK,
              'referrals': LeaderboardType.REFERRALS
            };
            await handleSpecificLeaderboard(ctx, typeMap[command.subAction]);
            break;
            
          case 'my_ranks':
            const { handleMyRanks } = await import('../menus/leaderboard');
            await handleMyRanks(ctx);
            break;
        }
      } else {
        // Show leaderboard menu
        const { handleLeaderboardMenu } = await import('../menus/leaderboard');
        await handleLeaderboardMenu(ctx);
      }
      break;
      
    case 'account':
      const { handleAccountMenu } = await import('../handlers/account');
      await handleAccountMenu(ctx);
      break;
  }
}