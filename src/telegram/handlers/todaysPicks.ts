import { Context } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { TodaysPickService } from '../../services/defiLlama/todaysPicks';
import { createLogger } from '../../utils/logger';
import { t, getUserLanguage } from '../../i18n';

const logger = createLogger('handlers.todaysPicks');

/**
 * Handles the "Today's Picks" button click
 */
export async function handleTodaysPicks(ctx: Context): Promise<void> {
  try {
    const lang = await getUserLanguage(ctx.from!.id);
    
    // Send loading message
    const loadingMessage = t(lang, 'todaysPick.loading');
    const message = await ctx.reply(loadingMessage);

    // Fetch today's picks
    const todaysPickService = new TodaysPickService();
    const picks = await todaysPickService.getTodaysPicks();
    const formattedMessage = await todaysPickService.formatTodaysPicksMessage(ctx, picks);

    // Create inline keyboard with back button
    const backButton = t(lang, 'tokenSearch.backToMainMenu');
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: backButton, callback_data: 'start' }]
      ]
    };

    // Edit the loading message with the results and keyboard
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      message.message_id,
      undefined,
      formattedMessage,
      { 
        parse_mode: 'HTML', 
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard
      }
    );
  } catch (error) {
    logger.error('Error handling todays_pick callback', { error });
    const lang = await getUserLanguage(ctx.from!.id);
    const errorMessage = t(lang, 'todaysPick.error');
    await ctx.reply(errorMessage);
  }
}