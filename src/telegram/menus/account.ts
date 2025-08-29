import { Markup, Context } from 'telegraf';
import { KeeperService, KeeperRole } from '../../services/keeper';
import { UserService } from '../../services/user';
import { getUserLanguage, t } from '../../i18n';

export async function accountMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const keeperStatus = await KeeperService.getKeeperStatus(userId);

  if (!keeperStatus.isKeeper) {
    // Provide guidance on how to become a keeper
    const message = lang === 'zh' 
      ? `🐝 *欢迎来到 BNB Copilot！*\n\n` +
        `您还不是 Keeper。要成为 Keeper 并开始赚取蜂蜜，请：\n\n` +
        `1️⃣ 连接您的钱包\n` +
        `2️⃣ 系统会自动授予您基础 Keeper 身份\n` +
        `3️⃣ 开始赚取每日蜂蜜奖励！\n\n` +
        `*连接钱包后您将获得：*\n` +
        `• 🧪 基础 Keeper 身份\n` +
        `• 🍯 每日 10 蜂蜜基础奖励\n` +
        `• 🎁 20 蜂蜜欢迎奖励\n` +
        `• 🔓 解锁高级功能使用权限`
      : `🐝 *Welcome to BNB Copilot!*\n\n` +
        `You're not a Keeper yet. To become a Keeper and start earning honey:\n\n` +
        `1️⃣ Connect your wallet\n` +
        `2️⃣ You'll automatically receive basic Keeper status\n` +
        `3️⃣ Start earning daily honey rewards!\n\n` +
        `*After connecting your wallet, you'll receive:*\n` +
        `• 🧪 Basic Keeper status\n` +
        `• 🍯 10 daily honey base reward\n` +
        `• 🎁 20 honey welcome bonus\n` +
        `• 🔓 Access to premium features`;

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback(
            lang === 'zh' ? '🔗 连接钱包' : '🔗 Connect Wallet', 
            'connect_wallet'
          )],
          [Markup.button.callback(t(lang, 'mainMenu.back'), 'main_menu')]
        ]
      },
      parse_mode: 'Markdown'
    });
    return;
  }

  const roleInfo = KeeperService.getRoleInfo(keeperStatus.role!);
  const isZh = lang === 'zh';

  // Format progress bars
  const formatProgress = (current: number, required: number): string => {
    const percentage = Math.min((current / required) * 100, 100);
    const filled = Math.floor(percentage / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${required}`;
  };

  // Build account status message
  let message = `${roleInfo.emoji} *${isZh ? '身份状态' : 'Identity Status'}*\n\n`;
  
  // Current role
  message += `${isZh ? '当前角色' : 'Current Role'}: *${roleInfo.emoji} ${isZh ? roleInfo.nameCn : roleInfo.name}*\n`;
  
  // Honey status with balance
  message += `\n🍯 *${isZh ? '蜂蜜状态' : 'Honey Status'}*\n`;
  message += `${isZh ? '当前余额' : 'Current Balance'}: ${keeperStatus.dailyHoney || 0} 🍯\n`;
  message += `${isZh ? '累计获得' : 'Total Earned'}: ${keeperStatus.totalHoney || 0} 🍯\n`;
  
  // Activity status
  message += `\n📊 *${isZh ? '活跃状态' : 'Activity Status'}*\n`;
  message += `${isZh ? '连续活跃' : 'Consecutive Days'}: ${keeperStatus.consecutiveDays || 0} ${isZh ? '天' : 'days'}\n`;
  message += `${isZh ? '工具使用' : 'Tools Used'}: ${keeperStatus.totalActionsUsed || 0} ${isZh ? '次' : 'times'}\n`;
  message += `${isZh ? '活跃推荐' : 'Active Referrals'}: ${keeperStatus.activeReferrals || 0}\n`;

  // Progress to next role
  if (keeperStatus.nextRole && keeperStatus.progressToNextRole) {
    const nextRoleInfo = KeeperService.getRoleInfo(keeperStatus.nextRole);
    message += `\n📈 *${isZh ? '升级进度' : 'Upgrade Progress'}* → ${nextRoleInfo.emoji} ${isZh ? nextRoleInfo.nameCn : nextRoleInfo.name}\n`;
    
    const progress = keeperStatus.progressToNextRole;
    // Display different progress based on role
    for (const [key, value] of Object.entries(progress)) {
      if (value && typeof value === 'object' && 'current' in value && 'required' in value) {
        const progressValue = value as { current: number | boolean; required: number | boolean };
        let label = key;
        switch (key) {
          case 'streak': label = isZh ? '连续天数' : 'Streak'; break;
          case 'honeyBurned': label = isZh ? '燃烧蜂蜜' : 'Honey Burned'; break;
          case 'nectrStaked': label = isZh ? 'NECTR质押' : 'NECTR Staked'; break;
          case 'actionsUsed': label = isZh ? '使用次数' : 'Actions Used'; break;
          case 'referrals': label = isZh ? '推荐人数' : 'Referrals'; break;
          case 'leaderboardTop50': label = isZh ? '排行榜前50' : 'Top 50'; break;
        }
        if (key === 'leaderboardTop50') {
          message += `${label}: ${progressValue.current ? '✅' : '❌'}\n`;
        } else if (key === 'nectrStaked') {
          // NECTR staking coming soon
          message += `${label}: ${isZh ? '🔜 即将推出' : '🔜 Coming Soon'}\n`;
        } else if (typeof progressValue.current === 'number' && typeof progressValue.required === 'number') {
          message += `${label}: ${formatProgress(progressValue.current, progressValue.required)}\n`;
        }
      }
    }
  } else {
    message += `\n✨ ${isZh ? '您已达到最高等级！' : 'You have reached the highest level!'}`;
  }

  // Role benefits
  message += `\n\n💎 *${isZh ? '角色权益' : 'Role Benefits'}*\n`;
  switch (keeperStatus.role) {
    case KeeperRole.KEEPER:
      message += isZh 
        ? '• 每日 10 🍯 基础奖励\n• 访问所有基础功能\n• 🧪 守护者徽章'
        : '• Daily 10 🍯 base rewards\n• Access to all basic features\n• 🧪 Keeper badge';
      break;
    case KeeperRole.WORKER_BEE:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🐝 工蜂徽章\n• 优先功能测试机会'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🐝 Worker Bee badge\n• Priority feature testing access';
      break;
    case KeeperRole.FORAGER:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🍄 采集者徽章\n• 🔜 专属命令: /freshalpha\n• 🔜 5% 蜂蜜/NECTR 兑换折扣'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🍄 Forager badge\n• 🔜 Exclusive command: /freshalpha\n• 🔜 5% Honey/NECTR swap discount';
      break;
    case KeeperRole.SWARM_LEADER:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🧭 蜂群领袖徽章\n• 🔜 专属命令: /airdrops, /watchwhales\n• 新功能抢先体验'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🧭 Swarm Leader badge\n• 🔜 Exclusive commands: /airdrops, /watchwhales\n• Early access to new features';
      break;
    case KeeperRole.QUEEN_BEE:
      message += isZh
        ? '• 每日 15 🍯 奖励 (+5 奖励)\n• 👑 蜂后徽章\n• 🔜 专属命令: /autoalerts, /vaultoptimizer\n• 🔜 20% 蜂蜜/NECTR 兑换折扣'
        : '• Daily 15 🍯 rewards (+5 bonus)\n• 👑 Queen Bee badge\n• 🔜 Exclusive commands: /autoalerts, /vaultoptimizer\n• 🔜 20% Honey/NECTR swap discount';
      break;
  }

  const keyboard = {
    inline_keyboard: [
      [Markup.button.callback(
        isZh ? '💰 蜂蜜充值' : '💰 Honey Recharge', 
        'honey_recharge'
      )],
      [
        Markup.button.callback(
          isZh ? '📜 蜂蜜记录' : '📜 Honey History', 
          'honey_history'
        ),
        Markup.button.callback(
          isZh ? '❓ 了解蜂蜜' : '❓ About Honey', 
          'honey_info'
        )
      ],
      [
        Markup.button.callback(
          isZh ? '🏆 排行榜' : '🏆 Leaderboard', 
          'leaderboard_menu'
        )
      ],
      [
        Markup.button.callback(
          isZh ? '💎 NECTR兑换 🔜' : '💎 NECTR Exchange 🔜', 
          'nectr_exchange'
        )
      ],
      [Markup.button.callback(t(lang, 'mainMenu.back'), 'main_menu')]
    ]
  };

  await ctx.reply(message, { 
    reply_markup: keyboard, 
    parse_mode: 'Markdown' 
  });
}

export async function accountMenuEdit(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const lang = await getUserLanguage(userId);
  const keeperStatus = await KeeperService.getKeeperStatus(userId);

  if (!keeperStatus.isKeeper) {
    // Provide guidance on how to become a keeper
    const message = lang === 'zh' 
      ? `🐝 *欢迎来到 BNB Copilot！*\n\n` +
        `您还不是 Keeper。要成为 Keeper 并开始赚取蜂蜜，请：\n\n` +
        `1️⃣ 连接您的钱包\n` +
        `2️⃣ 系统会自动授予您基础 Keeper 身份\n` +
        `3️⃣ 开始赚取每日蜂蜜奖励！\n\n` +
        `*连接钱包后您将获得：*\n` +
        `• 🧪 基础 Keeper 身份\n` +
        `• 🍯 每日 10 蜂蜜基础奖励\n` +
        `• 🎁 20 蜂蜜欢迎奖励\n` +
        `• 🔓 解锁高级功能使用权限`
      : `🐝 *Welcome to BNB Copilot!*\n\n` +
        `You're not a Keeper yet. To become a Keeper and start earning honey:\n\n` +
        `1️⃣ Connect your wallet\n` +
        `2️⃣ You'll automatically receive basic Keeper status\n` +
        `3️⃣ Start earning daily honey rewards!\n\n` +
        `*After connecting your wallet, you'll receive:*\n` +
        `• 🧪 Basic Keeper status\n` +
        `• 🍯 10 daily honey base reward\n` +
        `• 🎁 20 honey welcome bonus\n` +
        `• 🔓 Access to premium features`;

    await ctx.editMessageText(message, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback(
            lang === 'zh' ? '🔗 连接钱包' : '🔗 Connect Wallet', 
            'connect_wallet'
          )],
          [Markup.button.callback(t(lang, 'mainMenu.back'), 'main_menu')]
        ]
      },
      parse_mode: 'Markdown'
    });
    return;
  }

  const roleInfo = KeeperService.getRoleInfo(keeperStatus.role!);
  const isZh = lang === 'zh';

  // Format progress bars
  const formatProgress = (current: number, required: number): string => {
    const percentage = Math.min((current / required) * 100, 100);
    const filled = Math.floor(percentage / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${required}`;
  };

  // Build account status message
  let message = `${roleInfo.emoji} *${isZh ? '身份状态' : 'Identity Status'}*\n\n`;
  
  // Current role
  message += `${isZh ? '当前角色' : 'Current Role'}: *${roleInfo.emoji} ${isZh ? roleInfo.nameCn : roleInfo.name}*\n`;
  
  // Honey status with balance
  message += `\n🍯 *${isZh ? '蜂蜜状态' : 'Honey Status'}*\n`;
  message += `${isZh ? '当前余额' : 'Current Balance'}: ${keeperStatus.dailyHoney || 0} 🍯\n`;
  message += `${isZh ? '累计获得' : 'Total Earned'}: ${keeperStatus.totalHoney || 0} 🍯\n`;
  
  // Activity status
  message += `\n📊 *${isZh ? '活跃状态' : 'Activity Status'}*\n`;
  message += `${isZh ? '连续活跃' : 'Consecutive Days'}: ${keeperStatus.consecutiveDays || 0} ${isZh ? '天' : 'days'}\n`;
  message += `${isZh ? '工具使用' : 'Tools Used'}: ${keeperStatus.totalActionsUsed || 0} ${isZh ? '次' : 'times'}\n`;
  message += `${isZh ? '活跃推荐' : 'Active Referrals'}: ${keeperStatus.activeReferrals || 0}\n`;

  // Progress to next role
  if (keeperStatus.nextRole && keeperStatus.progressToNextRole) {
    const nextRoleInfo = KeeperService.getRoleInfo(keeperStatus.nextRole);
    message += `\n📈 *${isZh ? '升级进度' : 'Upgrade Progress'}* → ${nextRoleInfo.emoji} ${isZh ? nextRoleInfo.nameCn : nextRoleInfo.name}\n`;
    
    const progress = keeperStatus.progressToNextRole;
    // Display different progress based on role
    for (const [key, value] of Object.entries(progress)) {
      if (value && typeof value === 'object' && 'current' in value && 'required' in value) {
        const progressValue = value as { current: number | boolean; required: number | boolean };
        let label = key;
        switch (key) {
          case 'streak': label = isZh ? '连续天数' : 'Streak'; break;
          case 'honeyBurned': label = isZh ? '燃烧蜂蜜' : 'Honey Burned'; break;
          case 'nectrStaked': label = isZh ? 'NECTR质押' : 'NECTR Staked'; break;
          case 'actionsUsed': label = isZh ? '使用次数' : 'Actions Used'; break;
          case 'referrals': label = isZh ? '推荐人数' : 'Referrals'; break;
          case 'leaderboardTop50': label = isZh ? '排行榜前50' : 'Top 50'; break;
        }
        if (key === 'leaderboardTop50') {
          message += `${label}: ${progressValue.current ? '✅' : '❌'}\n`;
        } else if (key === 'nectrStaked') {
          // NECTR staking coming soon
          message += `${label}: ${isZh ? '🔜 即将推出' : '🔜 Coming Soon'}\n`;
        } else if (typeof progressValue.current === 'number' && typeof progressValue.required === 'number') {
          message += `${label}: ${formatProgress(progressValue.current, progressValue.required)}\n`;
        }
      }
    }
  } else {
    message += `\n✨ ${isZh ? '您已达到最高等级！' : 'You have reached the highest level!'}`;
  }

  // Role benefits
  message += `\n\n💎 *${isZh ? '角色权益' : 'Role Benefits'}*\n`;
  switch (keeperStatus.role) {
    case KeeperRole.KEEPER:
      message += isZh 
        ? '• 每日 10 🍯 基础奖励\n• 访问所有基础功能\n• 🧪 守护者徽章'
        : '• Daily 10 🍯 base rewards\n• Access to all basic features\n• 🧪 Keeper badge';
      break;
    case KeeperRole.WORKER_BEE:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🐝 工蜂徽章\n• 优先功能测试机会'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🐝 Worker Bee badge\n• Priority feature testing access';
      break;
    case KeeperRole.FORAGER:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🍄 采集者徽章\n• 🔜 专属命令: /freshalpha\n• 🔜 5% 蜂蜜/NECTR 兑换折扣'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🍄 Forager badge\n• 🔜 Exclusive command: /freshalpha\n• 🔜 5% Honey/NECTR swap discount';
      break;
    case KeeperRole.SWARM_LEADER:
      message += isZh
        ? '• 每日 11 🍯 奖励 (+1 奖励)\n• 🧭 蜂群领袖徽章\n• 🔜 专属命令: /airdrops, /watchwhales\n• 新功能抢先体验'
        : '• Daily 11 🍯 rewards (+1 bonus)\n• 🧭 Swarm Leader badge\n• 🔜 Exclusive commands: /airdrops, /watchwhales\n• Early access to new features';
      break;
    case KeeperRole.QUEEN_BEE:
      message += isZh
        ? '• 每日 15 🍯 奖励 (+5 奖励)\n• 👑 蜂后徽章\n• 🔜 专属命令: /autoalerts, /vaultoptimizer\n• 🔜 20% 蜂蜜/NECTR 兑换折扣'
        : '• Daily 15 🍯 rewards (+5 bonus)\n• 👑 Queen Bee badge\n• 🔜 Exclusive commands: /autoalerts, /vaultoptimizer\n• 🔜 20% Honey/NECTR swap discount';
      break;
  }

  const keyboard = {
    inline_keyboard: [
      [Markup.button.callback(
        isZh ? '💰 蜂蜜充值' : '💰 Honey Recharge', 
        'honey_recharge'
      )],
      [
        Markup.button.callback(
          isZh ? '📜 蜂蜜记录' : '📜 Honey History', 
          'honey_history'
        ),
        Markup.button.callback(
          isZh ? '❓ 了解蜂蜜' : '❓ About Honey', 
          'honey_info'
        )
      ],
      [
        Markup.button.callback(
          isZh ? '🏆 排行榜' : '🏆 Leaderboard', 
          'leaderboard_menu'
        )
      ],
      [
        Markup.button.callback(
          isZh ? '💎 NECTR兑换 🔜' : '💎 NECTR Exchange 🔜', 
          'nectr_exchange'
        )
      ],
      [Markup.button.callback(t(lang, 'mainMenu.back'), 'main_menu')]
    ]
  };

  await ctx.editMessageText(message, { 
    reply_markup: keyboard, 
    parse_mode: 'Markdown' 
  });
}