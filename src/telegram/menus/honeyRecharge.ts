import { Markup, Context } from 'telegraf';
import { HoneyRechargeService } from '@/services/honey/recharge';
import { createLogger } from '@/utils/logger';
import { UserModel } from '@/database/models/User';

const log = createLogger('HoneyRechargeMenu');

/**
 * Main honey recharge menu - shows available packages
 */
export async function honeyRechargeMenu(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    // Get user's current BNB balance
    const bnbBalance = await HoneyRechargeService.getUserBNBBalance(telegramId);

    // Get user's current honey balance
    const user = await UserModel.findOne({ telegramId });
    const honeyBalance = user?.dailyHoney || 0;

    // Get purchase statistics
    const stats = await HoneyRechargeService.getUserPurchaseStats(telegramId);

    let message = `🍯 *Honey Recharge System*\n\n`;
    message += `Current Balance:\n`;
    message += `🍯 Honey: ${honeyBalance.toLocaleString()}\n`;
    message += `💰 BNB: ${parseFloat(bnbBalance).toFixed(4)}\n\n`;

    if (stats.purchaseCount > 0) {
      message += `📊 *Purchase History:*\n`;
      message += `🍯 Total Purchased: ${stats.totalPurchased.toLocaleString()}\n`;
      message += `💰 Total Spent: ${stats.totalSpent} BNB\n`;
      message += `🛒 Purchases: ${stats.purchaseCount}\n\n`;
    }

    message += `💳 *Available Packages:*\n\n`;

    // Create buttons for each package
    const packageButtons = [];
    for (let i = 0; i < HoneyRechargeService.HONEY_PACKAGES.length; i++) {
      const pkg = HoneyRechargeService.HONEY_PACKAGES[i];
      const displayText = await HoneyRechargeService.formatPackageDisplay(pkg);
      message += `**Package ${i + 1}:**\n${displayText}\n\n`;

      // Check if user has enough BNB for this package
      const hasBalance = await HoneyRechargeService.validateBNBBalance(telegramId, pkg.bnbAmount);
      const buttonText = hasBalance ?
        `Buy ${pkg.honeyAmount.toLocaleString()}🍯 (${pkg.bnbAmount} BNB)` :
        `❌ ${pkg.honeyAmount.toLocaleString()}🍯 (${pkg.bnbAmount} BNB)`;

      packageButtons.push([Markup.button.callback(buttonText, `honey_buy_${i}`)]);
    }

    message += `⚠️ *Important:*\n`;
    message += `• Payments are sent from your **trading wallet**\n`;
    message += `• Ensure you have enough BNB in your trading wallet to cover the cost + gas fees (≈0.00005 BNB)\n`;
    message += `• Honey is credited instantly after confirmation\n`;

    const keyboard = Markup.inlineKeyboard([
      ...packageButtons,
      [Markup.button.callback('💸 Fund Trading Wallet from Main Wallet', 'fund_trading_wallet_from_recharge')],
      [Markup.button.callback('📊 Purchase History', 'honey_history')],
      [Markup.button.callback('❓ Help', 'honey_help')],
      [Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]
    ]);

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
    log.error('Error displaying honey recharge menu:', error);
    await ctx.reply('❌ Error loading honey recharge menu. Please try again.');
  }
}

/**
 * Handle honey purchase confirmation
 */
export async function handleHoneyPurchase(ctx: Context, packageIndex: number): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // Validate package index
    if (packageIndex < 0 || packageIndex >= HoneyRechargeService.HONEY_PACKAGES.length) {
      await ctx.answerCbQuery('❌ Invalid package selected');
      return;
    }

    const selectedPackage = HoneyRechargeService.HONEY_PACKAGES[packageIndex];

    // Check if user has trading wallet
    const user = await UserModel.findOne({ telegramId });
    if (!user?.tradingWalletAddress) {
      await ctx.answerCbQuery('❌ Trading wallet required');
      await ctx.reply('⚠️ You need to set up a trading wallet first. Use /wallet command to create one.');
      return;
    }

    // Double-check BNB balance
    const hasBalance = await HoneyRechargeService.validateBNBBalance(telegramId, selectedPackage.bnbAmount);
    if (!hasBalance) {
      await ctx.answerCbQuery('❌ Insufficient BNB balance');
      await ctx.reply('⚠️ Insufficient BNB balance (including gas fees). Please add more BNB to your trading wallet.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back', callback_data: 'honey_recharge' }]
          ]
        }
      });
      return;
    }

    // Show confirmation dialog
    let confirmMessage = `🍯 *Honey Purchase Confirmation*\n\n`;
    confirmMessage += `**Package Details:**\n`;
    confirmMessage += `🍯 Honey Amount: ${selectedPackage.honeyAmount.toLocaleString()}\n`;
    confirmMessage += `💰 BNB Cost: ${selectedPackage.bnbAmount} BNB\n\n`;
    confirmMessage += `**Transaction Details:**\n`;
    confirmMessage += `📤 From: Your trading wallet\n`;
    confirmMessage += `📥 To: \`${HoneyRechargeService['MAIN_DEPOSIT_ADDRESS']}\`\n`;
    confirmMessage += `⛽ Gas Fee: ~0.00005 BNB additional\n\n`;
    confirmMessage += `⚠️ *This action cannot be undone*`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm Purchase', `honey_confirm_${packageIndex}`)],
      [Markup.button.callback('❌ Cancel', 'honey_recharge')]
    ]);

    await ctx.editMessageText(confirmMessage, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    log.error('Error handling honey purchase:', error);
    await ctx.answerCbQuery('❌ Error processing purchase');
  }
}

/**
 * Execute honey purchase
 */
export async function executeHoneyPurchase(ctx: Context, packageIndex: number): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    await ctx.answerCbQuery('Processing purchase...');

    // Show processing message
    await ctx.editMessageText('⏳ Processing your honey purchase...\n\nThis may take up to 30 seconds.', {
      parse_mode: 'Markdown'
    });

    // Execute the purchase
    const result = await HoneyRechargeService.purchaseHoney(telegramId, packageIndex);

    if (result.success) {
      let successMessage = `✅ *Honey Purchase Successful!*\n\n`;
      successMessage += `🍯 Honey Credited: ${result.honeyAmount?.toLocaleString()}\n`;
      successMessage += `📄 Transaction: \`${result.transactionHash}\`\n\n`;
      successMessage += `You can view this transaction on BSCScan:\n`;
      successMessage += `https://bscscan.com/tx/${result.transactionHash}\n\n`;
      successMessage += `Your honey has been added to your account! 🎉`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🍯 Buy More Honey', 'honey_recharge')],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ]);

      await ctx.editMessageText(successMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });

    } else {
      let errorMessage = `❌ *Purchase Failed*\n\n`;
      errorMessage += `Error: ${result.error}\n\n`;
      errorMessage += `Please try again or contact support if the issue persists.`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Try Again', 'honey_recharge')],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ]);

      await ctx.editMessageText(errorMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    }

  } catch (error) {
    log.error('Error executing honey purchase:', error);
    await ctx.editMessageText('❌ An unexpected error occurred during purchase. Please try again.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Try Again', 'honey_recharge')],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ]).reply_markup
    });
  }
}

/**
 * Show honey purchase history
 */
export async function showHoneyHistory(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const stats = await HoneyRechargeService.getUserPurchaseStats(telegramId);

    let message = `📊 *Honey Purchase History*\n\n`;

    if (stats.purchaseCount === 0) {
      message += `No honey purchases yet.\n\n`;
      message += `Start by purchasing your first honey package! 🍯`;
    } else {
      message += `🍯 **Total Honey Purchased:** ${stats.totalPurchased.toLocaleString()}\n`;
      message += `💰 **Total BNB Spent:** ${stats.totalSpent} BNB\n`;
      message += `🛒 **Number of Purchases:** ${stats.purchaseCount}\n\n`;

      const avgHoneyPerPurchase = Math.round(stats.totalPurchased / stats.purchaseCount);
      const avgBNBPerPurchase = (parseFloat(stats.totalSpent) / stats.purchaseCount).toFixed(4);

      message += `📈 **Average per Purchase:**\n`;
      message += `🍯 ${avgHoneyPerPurchase.toLocaleString()} honey\n`;
      message += `💰 ${avgBNBPerPurchase} BNB\n`;
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🍯 Buy More Honey', 'honey_recharge')],
      [Markup.button.callback('🔙 Back', 'honey_recharge')]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    log.error('Error showing honey history:', error);
    await ctx.answerCbQuery('❌ Error loading purchase history');
  }
}

/**
 * Show honey recharge help
 */
export async function showHoneyHelp(ctx: Context): Promise<void> {
  let message = `❓ *Honey Recharge Help*\n\n`;
  message += `**What is Honey?**\n`;
  message += `🍯 Honey is the premium currency used to access advanced features in the bot.\n\n`;
  message += `**How does recharging work?**\n`;
  message += `1️⃣ Select a honey package\n`;
  message += `2️⃣ Confirm the purchase\n`;
  message += `3️⃣ BNB is sent from your trading wallet to our secure address\n`;
  message += `4️⃣ Honey is instantly credited to your account\n\n`;
  message += `**Packages Available:**\n`;
  message += `• 100 Honey = 0.0013 BNB (Base price)\n`;
  message += `• 1,000 Honey = 0.012 BNB (+25% more Honey)\n`;
  message += `• 5,000 Honey = 0.05 BNB (+46% more Honey)\n`;
  message += `• 15,000 Honey = 0.1 BNB (+115% more Honey)\n\n`;
  message += `**Requirements:**\n`;
  message += `• Active trading wallet\n`;
  message += `• Sufficient BNB balance (+ gas fees)\n\n`;
  message += `**Security:**\n`;
  message += `• All transactions are on-chain and verifiable\n`;
  message += `• Your private keys never leave your device\n`;
  message += `• Fixed deposit address ensures security\n\n`;
  message += `**Support:**\n`;
  message += `If you experience any issues, please contact our support team.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🍯 Start Purchasing', 'honey_recharge')],
    [Markup.button.callback('🔙 Back', 'honey_recharge')]
  ]);

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup
  });
}