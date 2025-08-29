import { Context, Markup } from 'telegraf';
import { t, getUserLanguage, getTranslation } from '@/i18n';
import { sentimentService } from '@/services/sentiment';
import { createLogger } from '@/utils/logger';

const log = createLogger('sentiment-menu');

export async function handleSentimentMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  const lang = await getUserLanguage(userId);

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang, 'sentiment.quickAnalysis'), 'sentiment_quick'),
      Markup.button.callback(t(lang, 'sentiment.detailed'), 'sentiment_detailed')
    ],
    [
      Markup.button.callback(t(lang, 'sentiment.1h'), 'sentiment_1h'),
      Markup.button.callback(t(lang, 'sentiment.24h'), 'sentiment_24h'),
      Markup.button.callback(t(lang, 'sentiment.7d'), 'sentiment_7d')
    ],
    [Markup.button.callback(t(lang, 'common.back'), 'main_menu')]
  ]);

  const message = t(lang, 'sentiment.menuTitle');
  
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    }
  } catch (error) {
    log.error('Error showing sentiment menu:', error);
  }
}

export async function handleSentimentAnalysis(ctx: Context, timeframe: '1h' | '24h' | '7d' | '30d' = '24h', detailed: boolean = false) {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  const lang = await getUserLanguage(userId);

  try {
    // Show loading message
    const loadingMsg = await ctx.reply(t(lang, 'sentiment.analyzing'), {
      parse_mode: 'Markdown'
    });

    // Perform sentiment analysis
    const sentimentData = await sentimentService.analyzeBSCSentiment(timeframe, lang);

    // Format report based on type
    const report = detailed 
      ? sentimentService.formatSentimentReport(sentimentData, lang, timeframe)
      : sentimentService.formatQuickSentimentSummary(sentimentData, lang, timeframe);

    // Delete loading message
    await ctx.deleteMessage(loadingMsg.message_id);

    // Send report with appropriate buttons
    const keyboard = detailed
      ? Markup.inlineKeyboard([
          [
            Markup.button.callback(t(lang, 'sentiment.refresh'), `sentiment_${timeframe}`),
            Markup.button.callback(t(lang, 'common.back'), 'sentiment_menu')
          ]
        ])
      : Markup.inlineKeyboard([
          [
            Markup.button.callback(t(lang, 'sentiment.detailed'), `sentiment_detailed`),
            Markup.button.callback(t(lang, 'sentiment.refresh'), `sentiment_${timeframe}`)
          ],
          [Markup.button.callback(t(lang, 'common.back'), 'sentiment_menu')]
        ]);

    await ctx.reply(report, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    log.error('Error analyzing sentiment:', {
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error,
      userId,
      timeframe,
      detailed,
      timestamp: new Date().toISOString()
    });
    
    // Send error message with more details in development
    let errorMessage = t(lang, 'sentiment.error');
    if (process.env.NODE_ENV === 'development' && error instanceof Error) {
      errorMessage += `\n\n_Debug: ${error.message}_`;
    }
    
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(errorMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
  }
}

