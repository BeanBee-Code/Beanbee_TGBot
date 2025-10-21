// src/services/rugAlerts/index.ts
import { Context } from 'telegraf';
import { TokenAnalyzer, RugAlertAnalysis, TokenHolderAnalysis, TokenHolder, LiquidityAnalysis, TradingActivityAnalysis, HoneypotAnalysis } from './tokenAnalyzer';
import { createLogger } from '@/utils/logger';
import { getTranslation, getUserLanguage, t, Language } from '@/i18n';

const logger = createLogger('rugAlerts');

export class RugAlertsService {
  private tokenAnalyzer: TokenAnalyzer;

  constructor() {
    this.tokenAnalyzer = new TokenAnalyzer();
  }
  
  // Public method to analyze a token (wrapper for handleTokenInput)
  async analyzeToken(ctx: Context, tokenAddress: string) {
    await this.handleTokenInput(ctx, tokenAddress);
  }

  async handleTokenInput(ctx: Context, tokenAddress: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    if (!session) return;

    // Clear waiting state
    if (session.rugAlerts) {
      session.rugAlerts.waitingForTokenInput = false;
    }

    // Validate token address
    if (!this.tokenAnalyzer.isValidTokenAddress(tokenAddress)) {
      await ctx.reply(
        '❌ Invalid token address format. Please enter a valid BSC token address (0x...).\n\n' +
        'Example: `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      // Show loading message
      const loadingMsg = await ctx.reply('🔍 Analyzing token for rug pull risks... Please wait...');

      // Perform analysis
      const analysis = await this.tokenAnalyzer.analyzeToken(tokenAddress);

      // Delete loading message
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }

      if (!analysis) {
        const backButtonText = await getTranslation(ctx, 'common.back');
        await ctx.reply(
          '❌ Could not analyze this token. This might be because:\n\n' +
          '• Token does not exist on BSC\n' +
          '• Contract is not accessible\n' +
          '• Token has no holders data available\n\n' +
          'Please verify the contract address and try again.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: backButtonText, callback_data: 'start_edit' }]
              ]
            }
          }
        );
        return;
      }

      // Send comprehensive analysis in a single message
      await this.sendComprehensiveAnalysis(ctx, analysis);

    } catch (error) {
      logger.error('Error analyzing token', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
      const backButtonText = await getTranslation(ctx, 'common.back');
      await ctx.reply(
        '❌ Error analyzing token. Please check the address and try again.\n\n' +
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: backButtonText, callback_data: 'start_edit' }]
            ]
          }
        }
      );
    }
  }

  generateNaturalSummary(analysis: RugAlertAnalysis, lang: Language = 'en'): string {
    const { metadata, holderAnalysis, liquidityAnalysis, tradingActivity, honeypotAnalysis, safetyScore, scSecurityAnalysis } = analysis;

    let summary = '';

    // Start with token name and overall assessment
    const safetyLevel = this.getSafetyLevel(safetyScore);
    const safetyEmoji = this.getSafetyEmoji(safetyScore);

    // Check for critical SC vulnerabilities first
    if (scSecurityAnalysis && scSecurityAnalysis.hasData && scSecurityAnalysis.securityIssues.critical.length > 0) {
      summary = `🚨 **CRITICAL SECURITY WARNING**: ${metadata.name} (${metadata.symbol}) has ${scSecurityAnalysis.securityIssues.critical.length} critical smart contract vulnerabilit${scSecurityAnalysis.securityIssues.critical.length > 1 ? 'ies' : 'y'}! This token may be unsafe to trade.\n\n`;
    } else if (honeypotAnalysis.isHoneypot) {
      summary = `🚫 **WARNING**: ${metadata.name} (${metadata.symbol}) is a HONEYPOT! You cannot sell this token after buying. Do NOT invest in this token.\n\n`;
    } else if (safetyScore >= 70) {
      summary = `${safetyEmoji} ${metadata.name} (${metadata.symbol}) appears to be relatively safe with a score of ${safetyScore}/100. `;
    } else if (safetyScore >= 50) {
      summary = `${safetyEmoji} ${metadata.name} (${metadata.symbol}) has moderate risk with a score of ${safetyScore}/100. `;
    } else {
      summary = `${safetyEmoji} ${metadata.name} (${metadata.symbol}) shows high risk indicators with a score of ${safetyScore}/100. `;
    }
    
    // Add key insights
    const insights = [];
    
    // Honeypot status
    if (!honeypotAnalysis.isHoneypot) {
      if (honeypotAnalysis.sellTax && honeypotAnalysis.sellTax > 10) {
        insights.push(`has a high sell tax of ${honeypotAnalysis.sellTax}%`);
      }
      
      // Holder concentration
      if (holderAnalysis.top10ConcentrationExcludingLP > 50) {
        insights.push('is heavily concentrated among top holders');
      } else if (holderAnalysis.top10ConcentrationExcludingLP < 20) {
        insights.push('has good holder distribution');
      }
      
      // Liquidity status
      if (!liquidityAnalysis.hasLiquidity) {
        insights.push('has no liquidity pool');
      } else if (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD < 10000) {
        insights.push(`has very low liquidity ($${this.formatNumber(liquidityAnalysis.liquidityUSD)})`);
      } else if (liquidityAnalysis.lpTokenBurned) {
        insights.push('has permanently locked liquidity');
      } else if (!liquidityAnalysis.lpTokenLocked && !liquidityAnalysis.lpTokenBurned) {
        insights.push('has unlocked liquidity that can be removed');
      }
      
      // Contract status
      if (!metadata.verified) {
        insights.push('has an unverified contract');
      }
      if (!metadata.renounced) {
        insights.push('ownership is not renounced');
      }
      
      // Trading activity
      if (!tradingActivity.hasActiveTrading) {
        insights.push('shows little to no trading activity');
      } else if (tradingActivity.volume24h && tradingActivity.volume24h > 100000) {
        insights.push(`has high trading volume ($${this.formatNumber(tradingActivity.volume24h)}/24h)`);
      }
      
      // Age
      if (metadata.createdAt) {
        const ageInDays = Math.floor((Date.now() - metadata.createdAt.getTime()) / (1000 * 60 * 60 * 24));
        if (ageInDays < 7) {
          insights.push(`is very new (${ageInDays} days old)`);
        }
      }
    }
    
    // Combine insights into natural sentences
    if (insights.length > 0) {
      summary += `The token ${insights[0]}`;
      if (insights.length === 2) {
        summary += ` and ${insights[1]}`;
      } else if (insights.length > 2) {
        for (let i = 1; i < insights.length - 1; i++) {
          summary += `, ${insights[i]}`;
        }
        summary += `, and ${insights[insights.length - 1]}`;
      }
      summary += '. ';
    }
    
    // Add recommendation
    if (honeypotAnalysis.isHoneypot) {
      summary += '\n\n⛔ **DO NOT BUY** - This is a scam token.';
    } else if (safetyScore >= 70) {
      summary += '\n\n✅ This token appears relatively safe for trading, but always DYOR (Do Your Own Research).';
    } else if (safetyScore >= 50) {
      summary += '\n\n⚠️ **Exercise caution** - There are some risk factors to consider. Only invest what you can afford to lose.';
    } else {
      summary += '\n\n🚨 **High Risk** - Multiple red flags detected. Consider avoiding this token.';
    }
    
    // Add key metrics
    summary += '\n\n📊 **Key Metrics (BSC Chain):**\n';
    summary += `• Holders: ${holderAnalysis.totalHolders.toLocaleString()}\n`;
    if (liquidityAnalysis.liquidityUSD) {
      summary += `• Liquidity: ${this.formatNumber(liquidityAnalysis.liquidityUSD)}\n`;
    }
    if (tradingActivity.volume24h) {
      summary += `• 24h Volume: ${this.formatNumber(tradingActivity.volume24h)}\n`;
    }
    summary += `• Top 10 Hold: ${holderAnalysis.top10ConcentrationExcludingLP.toFixed(1)}%`;
    
    // Add BSC disclaimer
    summary += `\n\n_${t(lang, 'rugAlerts.bscOnlyDisclaimer')}_`;
    
    return summary;
  }

  private async sendComprehensiveAnalysis(ctx: Context, analysis: RugAlertAnalysis) {
    const { metadata, holderAnalysis, liquidityAnalysis, tradingActivity, honeypotAnalysis, safetyScore, safetyScoreDetails, recommendations } = analysis;

    const userId = ctx.from!.id;
    const lang = await getUserLanguage(userId);
    
    // Generate natural language summary
    const summary = this.generateNaturalSummary(analysis, lang);
    
    // Send summary with details button
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 View Detailed Report', callback_data: `rug_details:${metadata.address}` }],
        [{ text: '🔙 Back', callback_data: 'start_edit' }]
      ]
    };
    
    // Store the full analysis in session for later retrieval
    const session = global.userSessions.get(userId);
    if (session) {
      if (!session.rugAlerts) {
        session.rugAlerts = {};
      }
      session.rugAlerts.lastAnalysis = analysis;
    }
    
    await ctx.reply(summary, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  }

  async sendDetailedAnalysis(ctx: Context, tokenAddress: string) {
    const userId = ctx.from!.id;
    const session = global.userSessions.get(userId);
    const lang = await getUserLanguage(userId);
    
    if (!session?.rugAlerts?.lastAnalysis || session.rugAlerts.lastAnalysis.metadata.address !== tokenAddress) {
      await ctx.answerCbQuery('Analysis data not found. Please run the analysis again.');
      return;
    }
    
    const analysis = session.rugAlerts.lastAnalysis;
    const { metadata, holderAnalysis, liquidityAnalysis, tradingActivity, honeypotAnalysis, safetyScore, safetyScoreDetails, recommendations } = analysis;

    // Build comprehensive message
    let message = '';
    
    try {

    // Honeypot warning if detected
    if (honeypotAnalysis.isHoneypot) {
      message += '🚫 **HONEYPOT DETECTED**\n';
      message += `⚠️ ${honeypotAnalysis.cannotSellReason || 'This token cannot be sold!'}\n`;
      message += "**DO NOT BUY THIS TOKEN**\n\n";
      message += `────────────────────\n\n`;
    }

    // Header
    message += `🚨 *RUG ALERT ANALYSIS (${t(lang, 'common.bscLabel')})*\n`;
    message += `────────────────────\n\n`;
    
    // Token Info Section
    message += `📊 *TOKEN INFO*\n`;
    message += `• Name: ${metadata.name}\n`;
    message += `• Symbol: ${metadata.symbol}\n`;
    message += `• Contract: \`${metadata.address}\`\n`;
    message += `• [View on BSCScan](https://bscscan.com/token/${metadata.address})\n`;
    message += `• Decimals: ${metadata.decimals}\n`;
    message += `• Total Supply: ${this.formatSupply(metadata.totalSupply, metadata.decimals)}\n`;
    message += `• Verified: ${metadata.verified ? '✅ Yes' : '❌ No'}\n`;
    message += `• Ownership: ${metadata.renounced ? '✅ Renounced' : '⚠️ Active'}\n`;
    if (metadata.createdAt) {
      const ageInDays = Math.floor((Date.now() - metadata.createdAt.getTime()) / (1000 * 60 * 60 * 24));
      const ageText = ageInDays === 0 ? 
        `${Math.floor((Date.now() - metadata.createdAt.getTime()) / (1000 * 60 * 60))} hours` : 
        `${ageInDays} days`;
      message += `• Age: ${ageText}\n`;
    }
    message += `\n`;

    // Safety Score Section with detailed breakdown
    const safetyEmoji = this.getSafetyEmoji(safetyScore);
    const safetyLevel = this.getSafetyLevel(safetyScore);
    message += `🎯 *SAFETY SCORE*\n`;
    message += `${safetyEmoji} ${safetyScore}/100 (${safetyLevel})\n\n`;
    
    message += `📊 *Safety Breakdown:*\n`;
    message += `• Holders: ${safetyScoreDetails.holders}/15 • Liquidity: ${safetyScoreDetails.liquidity}/20 • Verification: ${safetyScoreDetails.verification}/10\n`;
    message += `• Ownership: ${safetyScoreDetails.ownership}/10 • Trading: ${safetyScoreDetails.trading}/10 • Age: ${safetyScoreDetails.age}/10\n`;
    message += `• Honeypot: ${safetyScoreDetails.honeypot}/10 • Diamond Hands: ${safetyScoreDetails.diamondHands || 0}/5\n`;
    message += `\n`;

    // Swap Analysis Section
    message += `🔄 *SWAP ANALYSIS*\n`;
    if (honeypotAnalysis.isHoneypot) {
      message += `❌ Token is NOT sellable (honeypot detected)\n`;
      if (honeypotAnalysis.cannotSellReason) {
        message += `Reason: ${honeypotAnalysis.cannotSellReason}\n`;
      }
    } else {
      message += `✅ Token appears to be sellable\n`;
    }
    if (honeypotAnalysis.buyTax !== undefined || honeypotAnalysis.sellTax !== undefined) {
      message += `\n💸 *Tax Analysis:*\n`;
      if (honeypotAnalysis.buyTax !== undefined) {
        message += `Buy Tax: ${honeypotAnalysis.buyTax}%\n`;
      }
      if (honeypotAnalysis.sellTax !== undefined) {
        if (honeypotAnalysis.sellTax >= 100) {
          message += `Sell Tax: ❌ 100% (CANNOT SELL)\n`;
        } else {
          message += `Sell Tax: ${honeypotAnalysis.sellTax}%\n`;
        }
      }
    }
    message += `\n`;

    // Smart Contract Security Section (HAPI Labs)
    if (analysis.scSecurityAnalysis && analysis.scSecurityAnalysis.hasData) {
      const scAnalysis = analysis.scSecurityAnalysis;

      // Overall SC risk level with score
      const scRiskEmoji = scAnalysis.riskLevel === 'SAFE' ? '✅' :
                          scAnalysis.riskLevel === 'LOW' ? '🟢' :
                          scAnalysis.riskLevel === 'MEDIUM' ? '🟡' :
                          scAnalysis.riskLevel === 'HIGH' ? '🟠' : '🔴';

      message += `🛡️ *SMART CONTRACT SECURITY* (HAPI Labs)\n`;
      message += `${scRiskEmoji} ${scAnalysis.riskLevel} — ${scAnalysis.securityScore}/15\n`;

      // Critical vulnerabilities
      if (scAnalysis.securityIssues.critical.length > 0) {
        message += `\n🚨 *CRITICAL:* ${scAnalysis.securityIssues.critical.map((i: string) => i.split(':')[0]).join(', ')}\n`;
      }

      // High-risk patterns
      if (scAnalysis.securityIssues.high.length > 0) {
        const highRiskNames = scAnalysis.securityIssues.high.slice(0, 3).map((i: string) => i.split(':')[0]);
        const remaining = scAnalysis.securityIssues.high.length - 3;
        message += `⚠️ *High-Risk:* ${highRiskNames.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}\n`;
      }

      // Medium-risk issues (condensed)
      if (scAnalysis.securityIssues.medium.length > 0) {
        message += `ℹ️ *Medium-Risk:* ${scAnalysis.securityIssues.medium.length} detected\n`;
      }

      // Positive security features (only if no critical issues)
      if (scAnalysis.positiveFeatures.length > 0 && scAnalysis.securityIssues.critical.length === 0 && scAnalysis.securityIssues.high.length === 0) {
        message += `✅ ${scAnalysis.positiveFeatures.slice(0, 2).join(' • ')}\n`;
      }

      message += `\n`;
    } else {
      // SC security screening not available
      message += `🛡️ *SMART CONTRACT SECURITY*\n`;
      message += `ℹ️ Advanced screening unavailable (Basic analysis above)\n\n`;
    }

    // Holder Analysis Section
    message += `👥 *HOLDER ANALYSIS*\n`;
    message += `• Total Holders: ${holderAnalysis.totalHolders.toLocaleString()}\n`;
    message += `• Top 10 Concentration: ${holderAnalysis.top10Concentration.toFixed(2)}%\n`;
    message += `• Top 10 (excl. LPs): ${holderAnalysis.top10ConcentrationExcludingLP.toFixed(2)}%\n`;
    
    if (holderAnalysis.creatorBalance !== undefined || holderAnalysis.ownerBalance !== undefined) {
      message += `\n💼 *Special Wallets:*\n`;
      if (holderAnalysis.creatorBalance !== undefined && holderAnalysis.creatorBalance > 0) {
        // Find the creator address from top holders
        const creatorHolder = holderAnalysis.top10Holders.find((h: TokenHolder) => h.holderType === 'creator');
        if (creatorHolder) {
          const addressShort = `${creatorHolder.address.slice(0, 6)}...${creatorHolder.address.slice(-4)}`;
          message += `• Creator: ${holderAnalysis.creatorBalance.toFixed(2)}% [${addressShort}](https://bscscan.com/address/${creatorHolder.address})\n`;
        } else {
          message += `• Creator Wallet: ${holderAnalysis.creatorBalance.toFixed(2)}%\n`;
        }
      }
      if (holderAnalysis.ownerBalance !== undefined && holderAnalysis.ownerBalance > 0) {
        // Find the owner address from top holders
        const ownerHolder = holderAnalysis.top10Holders.find((h: TokenHolder) => h.holderType === 'owner');
        if (ownerHolder) {
          const addressShort = `${ownerHolder.address.slice(0, 6)}...${ownerHolder.address.slice(-4)}`;
          message += `• Owner: ${holderAnalysis.ownerBalance.toFixed(2)}% [${addressShort}](https://bscscan.com/address/${ownerHolder.address})\n`;
        } else {
          message += `• Owner Wallet: ${holderAnalysis.ownerBalance.toFixed(2)}%\n`;
        }
      }
    }
    message += `\n`;

    // Liquidity Analysis Section
    message += `💧 *LIQUIDITY ANALYSIS*\n`;
    if (!liquidityAnalysis.hasLiquidity) {
      message += `❌ No liquidity pool found\n`;
      message += `⚠️ Cannot trade this token on DEXs\n`;
    } else {
      message += `✅ ${liquidityAnalysis.liquidityPools.length} liquidity pool(s) found\n`;

      // Use single liquidity source: prefer tradingActivity (DexScreener) over liquidityAnalysis
      const liquidityUSD = (tradingActivity.totalLiquidityUsd && tradingActivity.totalLiquidityUsd > 0)
        ? tradingActivity.totalLiquidityUsd
        : liquidityAnalysis.liquidityUSD;

      if (liquidityUSD) {
        message += `💰 Total Liquidity: $${this.formatNumber(liquidityUSD)}\n`;

        // Liquidity health check
        if (liquidityUSD < 1000) {
          message += `⚠️ EXTREMELY LOW - High slippage expected\n`;
        } else if (liquidityUSD < 10000) {
          message += `⚠️ VERY LOW - Significant slippage expected\n`;
        } else if (liquidityUSD < 50000) {
          message += `⚠️ LOW - Moderate slippage expected\n`;
        } else if (liquidityUSD < 100000) {
          message += `✅ ADEQUATE - Normal trading conditions\n`;
        } else {
          message += `✅ GOOD - Healthy liquidity\n`;
        }
      }
      
      message += `\n🔒 *LP Token Security:*\n`;
      if (liquidityAnalysis.lpTokenBurned) {
        message += `✅ LP tokens burned (permanent liquidity)\n`;
      } else if (liquidityAnalysis.lpTokenLocked) {
        message += `✅ LP tokens locked on ${liquidityAnalysis.lockPlatform || 'Unknown platform'}\n`;
        if (liquidityAnalysis.lockDuration) {
          message += `Lock Duration: ${liquidityAnalysis.lockDuration} days\n`;
        }
      } else {
        message += `❌ LP tokens NOT secured\n`;
        message += `⚠️ Liquidity can be removed at any time\n`;
      }
      
      // Show liquidity pools if multiple
      if (liquidityAnalysis.liquidityPools.length > 0) {
        message += `\n📊 *Liquidity Distribution:*\n`;
        liquidityAnalysis.liquidityPools.slice(0, 3).forEach((pool: any, index: number) => {
          const poolAddressShort = `${pool.address.slice(0, 6)}...${pool.address.slice(-4)}`;
          message += `${index + 1}. ${pool.dex}: $${this.formatNumber(pool.liquidityUSD)} [${poolAddressShort}](https://bscscan.com/address/${pool.address})\n`;
        });
        if (liquidityAnalysis.liquidityPools.length > 3) {
          message += `...and ${liquidityAnalysis.liquidityPools.length - 3} more pools\n`;
        }
      }
    }
    message += `\n`;

    // Trading Activity Section - Condensed
    message += `📈 *TRADING ACTIVITY (24H)*\n`;

    // Build compact stats line
    const stats: string[] = [];
    if (tradingActivity.txCount24h !== undefined) {
      stats.push(`${this.formatNumber(tradingActivity.txCount24h)} tx`);
    }
    if (tradingActivity.uniqueTraders24h !== undefined) {
      stats.push(`${this.formatNumber(tradingActivity.uniqueTraders24h)} traders`);
    }
    if (tradingActivity.volume24h !== undefined && tradingActivity.volume24h > 0) {
      stats.push(`$${this.formatNumber(tradingActivity.volume24h)} vol`);
    }
    if (tradingActivity.priceChange24h !== undefined && tradingActivity.priceChange24h !== null) {
      const priceChange = Number(tradingActivity.priceChange24h);
      if (!isNaN(priceChange)) {
        const priceChangeEmoji = priceChange >= 0 ? '📈' : '📉';
        stats.push(`${priceChangeEmoji}${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}%`);
      }
    }

    if (stats.length > 0) {
      const statusIcon = tradingActivity.hasActiveTrading ? '✅' : '⚠️';
      message += `${statusIcon} ${stats.join(' • ')}\n`;
    } else {
      message += `⚠️ No trading activity detected\n`;
    }
    
    // Liquidity Efficiency Analysis (if volume data available)
    if (tradingActivity.volume24h && tradingActivity.volume24h > 0) {
      // Use same liquidity source as above
      const liquidityUSD = (tradingActivity.totalLiquidityUsd && tradingActivity.totalLiquidityUsd > 0)
        ? tradingActivity.totalLiquidityUsd
        : liquidityAnalysis.liquidityUSD;

      if (liquidityUSD) {
        const ratio = liquidityUSD / tradingActivity.volume24h;

        // Use existing efficiency if available, otherwise calculate
        let efficiency = tradingActivity.liquidityEfficiency;
        if (!efficiency) {
          if (ratio >= 20) efficiency = 'ADEQUATE';
          else if (ratio >= 5) efficiency = 'GOOD';
          else if (ratio >= 3) efficiency = 'EXCELLENT';
          else efficiency = 'CRITICAL';
        }

        const efficiencyMap: Record<string, { emoji: string; text: string }> = {
          'EXCELLENT': { emoji: '🟢', text: 'Optimal trading' },
          'GOOD': { emoji: '🟢', text: 'Healthy efficiency' },
          'ADEQUATE': { emoji: '🟡', text: 'Standard coverage' },
          'POOR': { emoji: '🟠', text: 'May be excessive' },
          'CRITICAL': { emoji: '🔴', text: 'Insufficient' }
        };

        const effInfo = efficiencyMap[efficiency] || { emoji: '❓', text: 'Unknown' };
        message += `🔁 Liq/Vol Ratio: ${ratio.toFixed(1)}x ${effInfo.emoji} ${effInfo.text}\n`;
      }
    }
    message += `\n`;

    // Top Holders Section
    message += `🏆 *TOP 10 HOLDERS*\n`;
    holderAnalysis.top10Holders.forEach((holder: TokenHolder, index: number) => {
      const rank = index + 1;
      const addressShort = `${holder.address.slice(0, 6)}...${holder.address.slice(-4)}`;
      
      // Icons for holder types
      let icon = '';
      if (holder.holderType === 'liquidity') {
        icon = ' 💧';
      } else if (holder.holderType === 'creator') {
        icon = ' 👨‍💻';
      } else if (holder.holderType === 'owner') {
        icon = ' 👤';
      } else if (holder.isContract) {
        icon = ' 🤖';
      } else if (holder.isWhale) {
        icon = ' 🐳';
      } else if (holder.isHugeValue) {
        icon = ' 🐬';
      }
      
      // Add diamond hands emoji if applicable
      if (holder.isDiamondHands) {
        icon += '💎';
      }
      
      // Add portfolio value for whales and holding time for diamond hands
      let holderInfo = `${rank}. ${holder.percentage.toFixed(2)}%${icon} [${addressShort}](https://bscscan.com/address/${holder.address})`;
      
      // Add additional info
      const extraInfo: string[] = [];
      if (holder.isWhale && holder.portfolioValue) {
        extraInfo.push(`$${this.formatNumber(holder.portfolioValue)} portfolio`);
      }
      if (holder.isHugeValue && holder.hugeValueAmount) {
        extraInfo.push(`$${this.formatNumber(holder.hugeValueAmount)} max tx`);
      }
      if (holder.isDiamondHands && holder.holdingDays) {
        extraInfo.push(`${holder.holdingDays}d holding`);
      }
      
      if (extraInfo.length > 0) {
        holderInfo += ` (${extraInfo.join(', ')})`;
      }
      
      message += `${holderInfo}\n`;
    });
    message += `\nLegend: 💧=LP 👨‍💻=Creator 👤=Owner 🤖=Contract 🐳=Whale 🐬=Huge Value 💎=Diamond Hands\n\n`;

    // Risk Assessment Section
    message += `⚠️ *RISK ASSESSMENT*\n`;
    
    if (holderAnalysis.riskFactors.length > 0) {
      message += `\n🚩 *Risk Factors:*\n`;
      holderAnalysis.riskFactors.forEach((factor: string) => {
        message += `• ${factor}\n`;
      });
    }
    
    message += `\n💡 *Recommendations:*\n`;
    recommendations.forEach((rec: string) => {
      message += `${rec}\n`;
    });
    
    message += `\n⚠️ *Disclaimer:* This analysis is based on on-chain data for the BSC network only. Not financial advice.`;

    // Character limit check - Telegram has a 4096 character limit
    if (message.length > 4000) {
      // Truncate holder list if message is too long
      const lines = message.split('\n');
      const holderStartIndex = lines.findIndex(line => line.includes('TOP 10 HOLDERS'));
      const riskStartIndex = lines.findIndex(line => line.includes('RISK ASSESSMENT'));
      
      if (holderStartIndex > -1 && riskStartIndex > -1) {
        // Keep only top 5 holders
        const beforeHolders = lines.slice(0, holderStartIndex + 1);
        const holders = lines.slice(holderStartIndex + 1, holderStartIndex + 6);
        const afterHolders = lines.slice(riskStartIndex);
        
        message = [...beforeHolders, ...holders, '...and 5 more holders', '', ...afterHolders].join('\n');
      }
    }

    // Send everything in one message with back button
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 View Summary', callback_data: `rug_summary:${metadata.address}` }],
        [{ text: '🔍 Analyze Another Token', callback_data: 'rug_alerts' }],
        [{ text: '🔙 Back to Menu', callback_data: 'start_edit' }]
      ]
    };

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    } catch (error) {
      logger.error('Error building analysis message', { error: error instanceof Error ? error.message : String(error) });
      await ctx.answerCbQuery('Error displaying detailed analysis');
    }
  }

  private formatSupply(totalSupply: string, decimals: number): string {
    try {
      const supply = BigInt(totalSupply);
      const divisor = BigInt(10 ** decimals);
      const formatted = Number(supply / divisor);
      
      if (formatted >= 1e12) {
        return `${(formatted / 1e12).toFixed(2)}T`;
      } else if (formatted >= 1e9) {
        return `${(formatted / 1e9).toFixed(2)}B`;
      } else if (formatted >= 1e6) {
        return `${(formatted / 1e6).toFixed(2)}M`;
      } else if (formatted >= 1e3) {
        return `${(formatted / 1e3).toFixed(2)}K`;
      }
      return formatted.toLocaleString();
    } catch {
      return 'Unknown';
    }
  }

  private formatNumber(num: number): string {
    if (num >= 1e9) {
      return `${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
      return `${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
      return `${(num / 1e3).toFixed(2)}K`;
    }
    return num.toFixed(2);
  }

  private getSafetyEmoji(safetyScore: number): string {
    if (safetyScore >= 80) return '🟢';
    if (safetyScore >= 60) return '🟡';
    if (safetyScore >= 40) return '🟠';
    if (safetyScore >= 20) return '🔴';
    return '🔴';
  }

  private getSafetyLevel(safetyScore: number): string {
    if (safetyScore >= 80) return 'HIGH SAFETY';
    if (safetyScore >= 60) return 'MODERATE SAFETY';
    if (safetyScore >= 40) return 'MEDIUM RISK';
    if (safetyScore >= 20) return 'HIGH RISK';
    return 'CRITICAL RISK';
  }
}