import { Context } from 'telegraf';
import { RugAlertsService } from '../../services/rugAlerts';
import { getTranslation } from '@/i18n';
import { createLogger } from '@/utils/logger';

const logger = createLogger('telegram.menus.rugAlerts');

export async function handleRugAlertsMenu(ctx: Context, rugAlertsService: RugAlertsService) {
  const userId = ctx.from!.id;
  logger.info('User initiated rug alerts analysis', { userId });

  const session = global.userSessions.get(userId);
  logger.info('Current session state', {
    userId,
    hasSession: !!session,
    waitingForTokenInput: session?.rugAlerts?.waitingForTokenInput
  });

  try {
    // Set waiting input state
    if (!session) {
      logger.info('Creating new session', { userId });
      global.userSessions.set(userId, {
        client: null as any,
        rugAlerts: { waitingForTokenInput: true }
      });
    } else {
      logger.info('Updating existing session', { userId });
      
      // Clear all other waiting states to avoid conflicts
      delete session.waitingForWalletInput;
      delete session.waitingForWalletAddress;
      delete session.waitingForTokenAddress;
      delete session.waitingForTokenSearchInput;
      if (session.trading) {
        delete session.trading.waitingForTokenInput;
        delete session.trading.waitingForAmountInput;
      }
      if (session.transfer) {
        delete session.transfer.waitingForAmountInput;
      }
      if (session.autoTradeSetup) {
        delete session.autoTradeSetup.waitingForInput;
      }
      
      if (!session.rugAlerts) {
        session.rugAlerts = {};
      }
      session.rugAlerts.waitingForTokenInput = true;
    }

    const backText = await getTranslation(ctx, 'rugAlerts.back');
    
    const keyboard = {
      inline_keyboard: [
        [{ text: backText, callback_data: 'start_edit' }]
      ]
    };

    logger.info('Attempting to send message', { userId });

    // Try to delete the previous message first
    try {
      await ctx.deleteMessage().catch((error: Error) => {
        logger.info('Could not delete previous message', { userId, error: error.message });
      });
    } catch (error) {
      logger.info('Error deleting message', { userId, error });
    }

    // Build message using translations
    const title = await getTranslation(ctx, 'rugAlerts.title');
    const enterAddress = await getTranslation(ctx, 'rugAlerts.enterAddress');
    const whatWeAnalyze = await getTranslation(ctx, 'rugAlerts.whatWeAnalyze');
    const holderDistribution = await getTranslation(ctx, 'rugAlerts.holderDistribution');
    const topHolders = await getTranslation(ctx, 'rugAlerts.topHolders');
    const contractStatus = await getTranslation(ctx, 'rugAlerts.contractStatus');
    const riskFactors = await getTranslation(ctx, 'rugAlerts.riskFactors');
    const exampleAddress = await getTranslation(ctx, 'rugAlerts.exampleAddress');
    const cakeExample = await getTranslation(ctx, 'rugAlerts.cakeExample');
    const note = await getTranslation(ctx, 'rugAlerts.note');

    const message = `${title}

${enterAddress}

${whatWeAnalyze}
${holderDistribution}
${topHolders}
${contractStatus}
${riskFactors}

**${exampleAddress}**
\`0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82\` ${cakeExample}

${note}`;

    // Send new message
    const sentMessage = await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });

    logger.info('Successfully sent message', { userId, messageId: sentMessage.message_id });

  } catch (error) {
    logger.error('Error sending message', { userId, error });

    // Try to send error message to user
    try {
      const errorMessage = await getTranslation(ctx, 'rugAlerts.errorAnalyzing');
      await ctx.reply(errorMessage);
    } catch (e) {
      logger.error('Failed to send error message', { userId, error: e });
    }
  }
}

export async function handleAnalyzeCakeToken(ctx: Context, rugAlertsService: RugAlertsService) {
  const userId = ctx.from!.id;
  const session = global.userSessions.get(userId);

  if (!session?.rugAlerts) {
    await ctx.answerCbQuery('Please start rug alerts analysis first');
    return;
  }

  // Clear waiting input state
  session.rugAlerts.waitingForTokenInput = false;

  // Analyze CAKE token as example
  const cakeTokenAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
  await rugAlertsService.handleTokenInput(ctx, cakeTokenAddress);
}