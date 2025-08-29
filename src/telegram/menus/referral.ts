import { Context, Markup } from 'telegraf';
import { UserModel } from '../../database/models/User';
import { getUserLanguage, getTranslation } from '../../i18n';
import { getBNBPrice } from '../../services/wallet/tokenPriceCache';
import { FixedNumber } from 'ethers';

const MIN_CLAIM_BNB = '0.01';

export async function generateReferralCode(user: any): Promise<string> {
  if (user.referralCode) return user.referralCode;

  let code: string;
  let existingUser: any;

  do {
    code = Math.random().toString(36).substring(2, 9);
    existingUser = await UserModel.findOne({ referralCode: code });
  } while (existingUser);

  user.referralCode = code;
  await user.save();
  return code;
}

export async function isCircularReferral(currentUser: any, targetUserId: string): Promise<boolean> {
  let checkedUser: any = currentUser;
  const visitedUsers = new Set<string>();

  while (checkedUser?.referrer) {
    const referrerId = checkedUser.referrer.toString();

    if (visitedUsers.has(referrerId) || referrerId === targetUserId) {
      return true;
    }

    visitedUsers.add(referrerId);
    checkedUser = await UserModel.findById(referrerId);
    if (!checkedUser) break;
  }

  return false;
}

export async function getReferralStatistics(user: any): Promise<{
  firstHand: number;
  secondHand: number;
  thirdHand: number;
  total: number;
}> {
  // First-hand referrals (direct referrals)
  const firstHandReferrals = await UserModel.find({ referrer: user._id });
  const firstHandCount = firstHandReferrals.length;

  // Second-hand referrals (referrals of my referrals)
  const secondHandPromises = firstHandReferrals.map(async (referral) => {
    return await UserModel.find({ referrer: referral._id });
  });
  const secondHandResults = await Promise.all(secondHandPromises);
  const secondHandCount = secondHandResults.reduce((total, arr) => total + arr.length, 0);

  // Third-hand referrals (referrals of second-hand referrals)
  const allSecondHand = secondHandResults.flat();
  const thirdHandPromises = allSecondHand.map(async (referral) => {
    return await UserModel.find({ referrer: referral._id });
  });
  const thirdHandResults = await Promise.all(thirdHandPromises);
  const thirdHandCount = thirdHandResults.reduce((total, arr) => total + arr.length, 0);

  return {
    firstHand: firstHandCount,
    secondHand: secondHandCount,
    thirdHand: thirdHandCount,
    total: firstHandCount + secondHandCount + thirdHandCount
  };
}

/**
 * Main referral menu
 */
export async function handleReferralMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await UserModel.findOne({ telegramId: userId });
  if (!user) {
    const lang = await getUserLanguage(userId);
    const errorMessage = lang === 'zh' ? '❌ 未找到用户。请先启动机器人。' : '❌ User not found. Please start the bot first.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(errorMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
    return;
  }

  const lang = await getUserLanguage(userId);
  const referralCode = await generateReferralCode(user);
  const stats = await getReferralStatistics(user);
  const bnbPrice = await getBNBPrice();

  const unclaimedBNB = FixedNumber.fromString(user.unclaimedReferralBNB || '0');
  const unclaimedUSD = unclaimedBNB.mulUnsafe(FixedNumber.fromString(bnbPrice.toString())).toUnsafeFloat();

  const botUsername = "beanbee_bot"; // Replace with your bot's username
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;

  const message = lang === 'zh'
    ? `🎯 *您的推荐信息*\n\n` +
    `💰 *未领取奖励:*\n` +
    `*${unclaimedBNB.toString()} BNB* (≈ $${unclaimedUSD.toFixed(2)})\n\n` +
    `📎 *您的推荐链接:*\n\`${referralLink}\`\n\n` +
    `🔗 *您的推荐代码:* \`${referralCode}\`\n\n` +
    `📊 *详细统计:* (总计 ${stats.total} 推荐)\n` +
    `• 🥇 一级: ${stats.firstHand} 人 (${user.referralPercents.firstHand}% 奖励)\n` +
    `• 🥈 二级: ${stats.secondHand} 人 (${user.referralPercents.secondHand}% 奖励)\n` +
    `• 🥉 三级: ${stats.thirdHand} 人 (${user.referralPercents.thirdHand}% 奖励)\n\n` +
    `分享您的链接以赚取BNB奖励！🎁`
    : `🎯 **Your Referral Information**\n\n` +
    `💰 **Unclaimed Earnings:**\n` +
    `*${unclaimedBNB.toString()} BNB* (≈ $${unclaimedUSD.toFixed(2)})\n\n` +
    `📎 **Your referral link:**\n\`${referralLink}\`\n\n` +
    `🔗 **Your referral code:** \`${referralCode}\`\n\n` +
    `📊 **Detailed Statistics:** (${stats.total} total referrals)\n` +
    `• 🥇 First-hand: ${stats.firstHand} people (${user.referralPercents.firstHand}% reward)\n` +
    `• 🥈 Second-hand: ${stats.secondHand} people (${user.referralPercents.secondHand}% reward)\n` +
    `• 🥉 Third-hand: ${stats.thirdHand} people (${user.referralPercents.thirdHand}% reward)\n\n` +
    `Share your link to earn BNB rewards! 🎁`;

  const keyboardButtons = [];

  if (!unclaimedBNB.isZero()) {
    keyboardButtons.push([Markup.button.callback(
      `🛠️ ${lang === 'zh' ? '管理收益' : 'Manage Earnings'} (${unclaimedBNB.toUnsafeFloat().toFixed(4)} BNB)`,
      'manage_referral_earnings'
    )]);
  }

  keyboardButtons.push(
    [Markup.button.callback(lang === 'zh' ? '🎫 输入推荐代码' : '🎫 Enter Referral Code', 'redeem_code')],
    [Markup.button.callback(lang === 'zh' ? '🔙 返回主菜单' : '🔙 Back to Main Menu', 'main_menu')]
  );

  const keyboard = Markup.inlineKeyboard(keyboardButtons);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

/**
 * Handles the "Manage Earnings" button, showing withdraw/convert options
 */
export async function handleManageReferralEarnings(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await UserModel.findOne({ telegramId: userId });
  if (!user) return;

  const lang = await getUserLanguage(userId);
  const unclaimedBNB = FixedNumber.fromString(user.unclaimedReferralBNB || '0');
  const canWithdraw = unclaimedBNB.gte(FixedNumber.fromString(MIN_CLAIM_BNB));

  const message = lang === 'zh' ?
    `🛠️ *管理您的推荐收益*\n\n` +
    `您当前有 *${unclaimedBNB.toString()} BNB* 未领取。\n\n` +
    `您可以将其转换为Honey以使用高级功能，或${canWithdraw ? '将其提取到您的主钱包' : `达到 ${MIN_CLAIM_BNB} BNB 时可提取到您的主钱包`}。` :
    `🛠️ *Manage Your Referral Earnings*\n\n` +
    `You currently have *${unclaimedBNB.toString()} BNB* unclaimed.\n\n` +
    `You can convert it to Honey for premium features, or ${canWithdraw ? 'withdraw it to your main wallet' : `claim it to your main wallet when you reach ${MIN_CLAIM_BNB} BNB`}.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`💸 ${lang === 'zh' ? '转换为Honey' : 'Convert to Honey'} (1 BNB = 150,000 🍯)`, 'convert_ref_honey_setup')],
    [Markup.button.callback(`🏦 ${lang === 'zh' ? '提现BNB' : 'Withdraw BNB'} (${lang === 'zh' ? '最低' : 'Min'} ${MIN_CLAIM_BNB} BNB)`, 'withdraw_ref_bnb_setup', !canWithdraw)],
    [Markup.button.callback(lang === 'zh' ? '🔙 返回' : '🔙 Back', 'referral_menu')]
  ]);

  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
}

/**
 * Shows amount selection for converting BNB to Honey
 */
export async function handleConvertSetup(ctx: Context) {
  await showAmountSelection(ctx, 'convert');
}

/**
 * Shows amount selection for withdrawing BNB
 */
export async function handleWithdrawSetup(ctx: Context) {
  await showAmountSelection(ctx, 'withdraw');
}

async function showAmountSelection(ctx: Context, action: 'convert' | 'withdraw') {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await UserModel.findOne({ telegramId: userId });
  if (!user) return;

  const lang = await getUserLanguage(userId);
  const unclaimedBNB = user.unclaimedReferralBNB;
  const unclaimedBNBFixed = FixedNumber.fromString(unclaimedBNB || '0');

  // Calculate honey amounts for different percentages
  const HONEY_PER_BNB = 150000;
  const honey25 = Math.floor(unclaimedBNBFixed.mulUnsafe(FixedNumber.fromValue(25)).divUnsafe(FixedNumber.fromValue(100)).mulUnsafe(FixedNumber.fromValue(HONEY_PER_BNB)).toUnsafeFloat());
  const honey50 = Math.floor(unclaimedBNBFixed.mulUnsafe(FixedNumber.fromValue(50)).divUnsafe(FixedNumber.fromValue(100)).mulUnsafe(FixedNumber.fromValue(HONEY_PER_BNB)).toUnsafeFloat());
  const honey100 = Math.floor(unclaimedBNBFixed.mulUnsafe(FixedNumber.fromValue(HONEY_PER_BNB)).toUnsafeFloat());

  // Calculate BNB amounts for percentage buttons
  const bnb25 = unclaimedBNBFixed.mulUnsafe(FixedNumber.fromValue(25)).divUnsafe(FixedNumber.fromValue(100)).toString();
  const bnb50 = unclaimedBNBFixed.mulUnsafe(FixedNumber.fromValue(50)).divUnsafe(FixedNumber.fromValue(100)).toString();
  const bnb100 = unclaimedBNBFixed.toString();

  const message = action === 'convert' ?
    (lang === 'zh' ?
      `💸 *转换为Honey*\n\n您想转换多少BNB？\n可用余额: ${unclaimedBNB} BNB\n\n` +
      `兑换比例: 1 BNB = 150,000 🍯\n\n` +
      `选择转换百分比：\n` +
      `• 25% = ${parseFloat(bnb25).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey25.toLocaleString()} 🍯\n` +
      `• 50% = ${parseFloat(bnb50).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey50.toLocaleString()} 🍯\n` +
      `• 100% = ${parseFloat(bnb100).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey100.toLocaleString()} 🍯` :
      `💸 *Convert to Honey*\n\nHow much BNB would you like to convert?\nAvailable: ${unclaimedBNB} BNB\n\n` +
      `Conversion rate: 1 BNB = 150,000 🍯\n\n` +
      `Select conversion percentage:\n` +
      `• 25% = ${parseFloat(bnb25).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey25.toLocaleString()} 🍯\n` +
      `• 50% = ${parseFloat(bnb50).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey50.toLocaleString()} 🍯\n` +
      `• 100% = ${parseFloat(bnb100).toPrecision(15).replace(/\.?0+$/, '')} BNB → ${honey100.toLocaleString()} 🍯`) :
    (lang === 'zh' ? `🏦 *提现BNB*\n\n您想提取多少BNB？\n可用余额: ${unclaimedBNB} BNB\n最低提现: ${MIN_CLAIM_BNB} BNB` : `🏦 *Withdraw BNB*\n\nHow much BNB would you like to withdraw?\nAvailable: ${unclaimedBNB} BNB\nMinimum: ${MIN_CLAIM_BNB} BNB`);

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('25%', `${action}_ref_bnb_percent_25`),
      Markup.button.callback('50%', `${action}_ref_bnb_percent_50`),
      Markup.button.callback('100%', `${action}_ref_bnb_percent_100`),
    ],
    [Markup.button.callback(lang === 'zh' ? '✏️ 自定义金额' : '✏️ Custom Amount', `${action}_ref_bnb_custom`)],
    [Markup.button.callback(lang === 'zh' ? '🔙 返回' : '🔙 Back', 'manage_referral_earnings')]
  ]);

  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
}

export async function handleRedeemCode(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);

  const message = lang === 'zh'
    ? '请输入您要兑换的推荐代码：'
    : 'Enter the referral code you want to redeem:';

  await ctx.reply(message, {
    reply_markup: {
      force_reply: true
    }
  });

  // Set user session to expect referral code input
  // @ts-ignore - userSessions is defined globally
  if (global.userSessions) {
    const session = global.userSessions.get(userId);
    if (session) {
      session.waitingForReferralCode = true;
      global.userSessions.set(userId, session);
    }
  }
}

export async function processRedeemCode(ctx: Context, code: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await UserModel.findOne({ telegramId: userId });
  if (!user) {
    const lang = await getUserLanguage(userId);
    const errorMessage = lang === 'zh' ? '❌ 未找到用户。' : '❌ User not found.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(errorMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'start_edit' }]
        ]
      }
    });
    return;
  }

  const lang = await getUserLanguage(userId);

  // Validation checks
  if (user.referrer) {
    const message = lang === 'zh'
      ? '❌ 您已经有推荐人了。'
      : '❌ You already have a referrer.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'referral_menu' }]
        ]
      }
    });
    return;
  }

  if (user.referralCode === code) {
    const message = lang === 'zh'
      ? '❌ 您不能使用自己的推荐代码。'
      : '❌ You cannot use your own referral code.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'referral_menu' }]
        ]
      }
    });
    return;
  }

  const referrer = await UserModel.findOne({ referralCode: code });
  if (!referrer) {
    const message = lang === 'zh'
      ? '❌ 无效的推荐代码。'
      : '❌ Invalid referral code.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'referral_menu' }]
        ]
      }
    });
    return;
  }

  // Check for circular referrals
  if (await isCircularReferral(referrer, user._id.toString())) {
    const message = lang === 'zh'
      ? '❌ 不允许循环推荐。'
      : '❌ Circular referrals are not allowed.';
    const backButtonText = await getTranslation(ctx, 'common.back');
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: backButtonText, callback_data: 'referral_menu' }]
        ]
      }
    });
    return;
  }

  // Set referrer
  user.referrer = referrer._id;
  await user.save();

  const message = lang === 'zh'
    ? `✅ 成功兑换来自 ${referrer.name || '用户'} 的推荐代码！\n\n🎁 您已获得推荐奖励资格！`
    : `✅ Successfully redeemed referral code from ${referrer.name || 'user'}!\n\n🎁 You are now eligible for referral rewards!`;

  const backButtonText = await getTranslation(ctx, 'common.back');
  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: backButtonText, callback_data: 'referral_menu' }]
      ]
    }
  });

  // Clear session state
  // @ts-ignore - userSessions is defined globally
  if (global.userSessions) {
    const session = global.userSessions.get(userId);
    if (session) {
      delete session.waitingForReferralCode;
      global.userSessions.set(userId, session);
    }
  }
}