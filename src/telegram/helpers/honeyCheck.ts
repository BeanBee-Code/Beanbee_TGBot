import { Context } from 'telegraf';
import { KeeperService, HONEY_COSTS } from '../../services/keeper';
import { HoneyFeature } from '../../database/models/HoneyTransaction';
import { getUserLanguage } from '../../i18n';

/**
 * Format user display name with role badge
 */
export async function formatUserWithBadge(userId: number, userName?: string | null): Promise<string> {
  const badge = await KeeperService.getUserBadge(userId);
  if (userName) {
    return badge ? `${userName} ${badge}` : userName;
  }
  return badge ? `User ${badge}` : 'User';
}

/**
 * Get user's role badge emoji
 */
export async function getUserBadge(userId: number): Promise<string> {
  return await KeeperService.getUserBadge(userId);
}

export async function checkHoneyAndProceed(
  ctx: Context,
  feature: HoneyFeature,
  proceedCallback: () => Promise<void>
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const cost = HONEY_COSTS[feature];
  
  // Check if user has enough honey
  const hasEnough = await KeeperService.hasEnoughHoney(userId, feature);
  
  if (!hasEnough) {
    const balance = await KeeperService.getHoneyBalance(userId);
    const message = lang === 'zh'
      ? `🍯 蜂蜜不足！\n\n需要: ${cost} 🍯\n当前: ${balance} 🍯\n\n请领取每日蜂蜜或完成任务来获取更多蜂蜜。`
      : `🍯 Insufficient Honey!\n\nRequired: ${cost} 🍯\nCurrent: ${balance} 🍯\n\nClaim daily honey or complete tasks to earn more.`;
    
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ 
            text: lang === 'zh' ? '🐝 查看账户' : '🐝 View Account', 
            callback_data: 'account_menu' 
          }],
          [{ 
            text: lang === 'zh' ? '🔙 返回' : '🔙 Back', 
            callback_data: 'main_menu' 
          }]
        ]
      },
      parse_mode: 'Markdown'
    });
    return;
  }

  // Consume honey
  const result = await KeeperService.consumeHoney(userId, feature);
  
  if (!result.success) {
    const message = lang === 'zh'
      ? `❌ 无法使用蜂蜜: ${result.error}`
      : `❌ Failed to use honey: ${result.error}`;
    
    await ctx.reply(message);
    return;
  }

  // Show honey consumption notification with badge
  const badge = await KeeperService.getUserBadge(userId);
  const notification = lang === 'zh'
    ? `✅ 已使用 ${cost} 🍯 | 余额: ${result.balance} 🍯 ${badge}`
    : `✅ Used ${cost} 🍯 | Balance: ${result.balance} 🍯 ${badge}`;
  
  // Check if this is a callback query or a regular message
  if ('callbackQuery' in ctx.update && ctx.update.callbackQuery) {
    await ctx.answerCbQuery(notification, { show_alert: false });
  } else {
    // For regular messages, we don't show the notification
    // The deduction happens silently in the background
  }
  
  // Proceed with the feature
  await proceedCallback();
}

export function getFeatureCostMessage(feature: HoneyFeature, lang: string): string {
  const cost = HONEY_COSTS[feature];
  return lang === 'zh'
    ? `需要 ${cost} 🍯`
    : `Costs ${cost} 🍯`;
}