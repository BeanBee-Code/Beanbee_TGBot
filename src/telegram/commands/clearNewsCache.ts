import { Context } from 'telegraf';
import { NewsCacheModel } from '@/database/models/NewsCache';
import { createLogger } from '@/utils/logger';
import { getTranslation } from '@/i18n';

const logger = createLogger('clear.news.cache');

export async function handleClearNewsCache(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      const backButtonText = await getTranslation(ctx, 'common.back');
      await ctx.reply('❌ Unable to identify user', {
        reply_markup: {
          inline_keyboard: [
            [{ text: backButtonText, callback_data: 'start_edit' }]
          ]
        }
      });
      return;
    }

    // Clear the news cache
    const result = await NewsCacheModel.deleteMany({});
    
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(`✅ News cache cleared! Deleted ${result.deletedCount} entries.\n\nThe next /testsummary will fetch fresh news.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
    
  } catch (error) {
    logger.error('Error clearing news cache:', error);
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply('❌ Error clearing news cache.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
  }
}