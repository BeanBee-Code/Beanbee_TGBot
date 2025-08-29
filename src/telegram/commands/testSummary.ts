import { Context, Telegraf } from 'telegraf';
import { DailySummaryService } from '@/services/notifications/dailySummary';
import { createLogger } from '@/utils/logger';
import { getTranslation } from '@/i18n';

const logger = createLogger('test.summary');

export async function handleTestSummary(ctx: Context & { telegram: any }): Promise<void> {
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

    await ctx.reply('🔄 Generating test daily summary...');

    // Create a mock Telegraf instance with just the telegram property we need
    const mockBot = {
      telegram: ctx.telegram,
      context: ctx
    } as any as Telegraf;
    
    // Create a daily summary service instance with the mock bot
    const summaryService = new DailySummaryService(mockBot);
    
    // Generate the summary
    const summary = await summaryService.generateDailySummary(telegramId);
    
    if (!summary) {
      const backButtonText = await getTranslation(ctx, 'common.back');
      await ctx.reply('❌ Unable to generate summary. Please ensure you have a connected wallet.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: backButtonText, callback_data: 'start_edit' }]
          ]
        }
      });
      return;
    }

    // Send the summary
    await ctx.reply(summary, {
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
    });

  } catch (error) {
    logger.error('Error generating test summary:', error);
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply('❌ Error generating test summary. Please try again later.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
  }
}