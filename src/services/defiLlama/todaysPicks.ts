import axios from 'axios';
import Moralis from 'moralis';
import { createLogger } from '../../utils/logger';
import { TodaysPickCacheModel, TodaysPickData } from '../../database/models/TodaysPickCache';
import { t, getUserLanguage } from '../../i18n';
import { Context } from 'telegraf';
import { formatUSDValue } from '../wallet/balance';

const logger = createLogger('services.todaysPicks');

// API endpoints and token addresses
const GECKO_TERMINAL_URL = 'https://api.geckoterminal.com/api/v2/networks/bsc/pools?sort=h24_volume_usd_desc&page=1&include=base_token';
const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const STABLECOIN_ADDRESSES = [
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
];

// NEW CONFIGURATION: Funnel filtering approach
const CANDIDATE_POOL_LIMIT = 200; // Analyze top 200 volume pools for broader candidate pool
const MIN_SAFETY_SCORE = 80;      // Only accept tokens with safety score > 80 (high safety)
const BATCH_SIZE = 10;            // Process tokens in batches to avoid rate limits
const DELAY_MS = 300;             // Delay between API batches (300ms)

// Utility functions for batch processing and rate limiting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const chunkArray = <T>(array: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

export class TodaysPickService {
  constructor() {
    // Ensure Moralis is initialized
    if (!Moralis.Core.isStarted) {
      Moralis.start({ apiKey: process.env.MORALIS_API_KEY! }).catch(error => {
        logger.error('Failed to initialize Moralis in TodaysPickService', { error });
      });
    }
  }

  /**
   * Fetches the top 5 token picks based on safety and real user activity.
   * Uses a funnel approach: broad candidate pool → safety filtering → buyer activity ranking
   */
  public async getTodaysPicks(): Promise<TodaysPickData[]> {
    // Check cache first (24-hour validity)
    const now = new Date();
    const cachedData = await TodaysPickCacheModel.findOne({ 
        key: 'bsc_top_5_safe_picks',
        expiresAt: { $gt: new Date() } 
    });

    if (cachedData) {
      logger.info('Returning "Today\'s Picks" from cache');
      return cachedData.picks;
    }

    logger.info('Cache empty or expired. Fetching fresh "Today\'s Picks"');

    // STEP 1: Get broad candidate pool from high-volume pools
    const topPools = await this.fetchTopPoolsFromGeckoTerminal();
    if (!topPools || topPools.length === 0) {
      throw new Error('Failed to fetch top pools from GeckoTerminal');
    }

    // Extract unique token candidates (avoid WBNB and stablecoins)
    const candidateTokens = new Map<string, { address: string; volume: number }>();
    for (const pool of topPools) {
      const baseTokenAddress = pool.relationships?.base_token?.data?.id.split('_')[1];
      if (
        baseTokenAddress &&
        baseTokenAddress.toLowerCase() !== WBNB_ADDRESS.toLowerCase() &&
        !STABLECOIN_ADDRESSES.includes(baseTokenAddress.toLowerCase())
      ) {
        const lowercasedAddress = baseTokenAddress.toLowerCase();
        if (!candidateTokens.has(lowercasedAddress)) {
          candidateTokens.set(lowercasedAddress, {
            address: baseTokenAddress,
            volume: parseFloat(pool.attributes?.volume_usd?.h24 || '0'),
          });
        }
      }
    }
    const candidates = Array.from(candidateTokens.values());
    logger.info(`Step 1: Found ${candidates.length} candidate tokens from top volume pools.`);

    // STEP 2: Enrich candidates with safety scores and buyer activity data
    const enrichedPicks: any[] = [];
    const batches = chunkArray(candidates, BATCH_SIZE);

    for (const batch of batches) {
      const batchPromises = batch.map(async (candidate) => {
        try {
          // Fetch both safety data (metadata) and buyer activity (analytics) in parallel
          const [metadata, analytics] = await Promise.all([
            this.fetchTokenMetadata([candidate.address]),
            this.fetchTokenAnalytics(candidate.address)
          ]);

          if (metadata && metadata.length > 0 && analytics) {
            return {
              ...metadata[0],
              ...analytics,
              volume24h: candidate.volume, // Keep original pool volume
            };
          }
          return null;
        } catch (error) {
          logger.warn(`Failed to enrich data for ${candidate.address}`, { error });
          return null;
        }
      });
      
      const results = await Promise.all(batchPromises);
      enrichedPicks.push(...results.filter(p => p !== null));
      
      // Rate limiting: wait between batches
      await delay(DELAY_MS);
    }
    logger.info(`Step 2: Enriched ${enrichedPicks.length} tokens with Moralis data.`);

    // STEP 3: Apply safety filter and rank by total trading activity (buyers + sellers)
    const safeAndRankedPicks = enrichedPicks
      .filter(p => p.security_score && p.security_score > MIN_SAFETY_SCORE)
      .sort((a, b) => {
        // Calculate total trading activity (buyers + sellers) for ranking
        const totalActivityA = (a.totalBuyers?.['24h'] || 0) + (a.totalSellers?.['24h'] || 0);
        const totalActivityB = (b.totalBuyers?.['24h'] || 0) + (b.totalSellers?.['24h'] || 0);
        return totalActivityB - totalActivityA;
      });
    
    logger.info(`Step 3: Found ${safeAndRankedPicks.length} tokens with safety score > ${MIN_SAFETY_SCORE}.`);

    // STEP 4: Finalize top 5 picks and cache results (include buyer and seller count data)
    const finalPicks: TodaysPickData[] = safeAndRankedPicks.slice(0, 5).map(p => ({
      tokenAddress: p.address,
      name: p.name,
      symbol: p.symbol,
      price: parseFloat(p.usdPrice || '0'),
      priceChange24h: p.pricePercentChange?.['24h'] || 0,
      volume24h: p.volume24h,
      marketCap: parseFloat(p.market_cap || '0'),
      safetyScore: p.security_score,
      buyerCount24h: p.totalBuyers?.['24h'] || 0, // Add buyer count
      sellerCount24h: p.totalSellers?.['24h'] || 0, // Add seller count
    }));

    // Cache results for 24 hours
    if (finalPicks.length > 0) {
      const expiresAt = new Date(now.getTime() + (24 * 60 * 60 * 1000)); // 24 hours from now
      
      await TodaysPickCacheModel.findOneAndUpdate(
        { key: 'bsc_top_5_safe_picks' },
        { picks: finalPicks, expiresAt },
        { upsert: true, new: true }
      );
      logger.info(`Step 4: Cached ${finalPicks.length} final picks.`);
    }

    return finalPicks;
  }

  /**
   * Fetches top pools from GeckoTerminal API
   * Now fetches up to CANDIDATE_POOL_LIMIT pools for broader analysis
   */
  private async fetchTopPoolsFromGeckoTerminal(): Promise<any[]> {
    try {
      const response = await axios.get(`${GECKO_TERMINAL_URL}&limit=${CANDIDATE_POOL_LIMIT}`);
      return response.data?.data || [];
    } catch (error) {
      logger.error('Error fetching from GeckoTerminal API', { error });
      return [];
    }
  }

  /**
   * Fetches token analytics from Moralis including buyer activity data
   * This provides the totalBuyers['24h'] metric for ranking
   */
  private async fetchTokenAnalytics(address: string): Promise<any | null> {
    try {
        const response = await fetch(`https://deep-index.moralis.io/api/v2.2/tokens/${address}/analytics?chain=0x38`, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                'X-API-Key': process.env.MORALIS_API_KEY!
            }
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (error) {
        logger.error('Error fetching single token analytics from Moralis', { address, error });
        return null;
    }
  }

  /**
   * Fetches metadata for multiple tokens using Moralis batch API
   */
  private async fetchTokenMetadata(addresses: string[]): Promise<any[]> {
    try {
      if (addresses.length === 0) return [];
      const response = await Moralis.EvmApi.token.getTokenMetadata({
        chain: "0x38",
        addresses: addresses,
      });
      return response.raw;
    } catch (error) {
      logger.error('Error fetching multiple token metadata from Moralis', { addresses, error });
      return [];
    }
  }

  /**
   * Formats the picks into a Telegram message (HTML format)
   * Updated to reflect new safety-first ranking approach
   */
  public async formatTodaysPicksMessage(ctx: Context, picks: TodaysPickData[]): Promise<string> {
    const lang = await getUserLanguage(ctx.from!.id);

    if (picks.length === 0) {
      return t(lang, 'todaysPick.noPicks');
    }

    // Create header message explaining the new ranking methodology
    let message = `<b>🔥 Today's Top 5 Safe Picks on BSC</b>\n`;
    message += `<i>(Ranked by 24h Trading Activity, Safety Score > ${MIN_SAFETY_SCORE})</i>\n\n`;

    picks.forEach((pick, index) => {
      const safetyEmoji = this.getSafetyEmoji(pick.safetyScore);
      const priceChangeEmoji = pick.priceChange24h >= 0 ? '📈' : '📉';
      const priceChangeSign = pick.priceChange24h >= 0 ? '+' : '';
      const riskSummary = this.getSafetySummary(pick.safetyScore, lang);
      const dexScreenerUrl = `https://dexscreener.com/bsc/${pick.tokenAddress}`;

      const totalActivity = (pick.buyerCount24h || 0) + (pick.sellerCount24h || 0);
      
      message += `<b>${index + 1}. <a href="${dexScreenerUrl}">${pick.name} (${pick.symbol})</a></b>\n`;
      message += `  💰 <b>Price:</b> ${formatUSDValue(pick.price)}\n`;
      message += `  ${priceChangeEmoji} <b>24h Change:</b> ${priceChangeSign}${pick.priceChange24h.toFixed(2)}%\n`;
      message += `  🛒 <b>24h Buyers:</b> ${pick.buyerCount24h?.toLocaleString() || 'N/A'}\n`;
      message += `  🏪 <b>24h Sellers:</b> ${pick.sellerCount24h?.toLocaleString() || 'N/A'}\n`;
      message += `  📊 <b>24h Volume:</b> ${formatUSDValue(pick.volume24h)}\n`;
      message += `  🏦 <b>Market Cap:</b> ${formatUSDValue(pick.marketCap)}\n`;
      message += `  ${safetyEmoji} <b>Safety:</b> ${riskSummary} (${pick.safetyScore}/100)\n`;
      message += `  📍 <code>${pick.tokenAddress}</code>\n\n`;
    });

    message += `\n<i>${t(lang, 'todaysPick.disclaimer')}</i>`;
    return message;
  }

  /**
   * Returns appropriate emoji based on safety score
   * Updated for high safety standards (all picks are > 80)
   */
  private getSafetyEmoji(score: number): string {
    if (score >= 90) return '🟢'; // Very Safe
    if (score > 80) return '🟡'; // Safe
    return '🟠'; // Moderate (shouldn't occur with MIN_SAFETY_SCORE = 80)
  }

  /**
   * Returns a short summary based on the safety score
   * For high-safety picks (> 80)
   */
  private getSafetySummary(score: number, lang: 'en' | 'zh'): string {
    if (score >= 90) return lang === 'zh' ? '非常安全' : 'Very Safe';
    if (score > 80) return lang === 'zh' ? '比较安全' : 'Safe';
    return lang === 'zh' ? '中等风险' : 'Moderate Risk';
  }

  /**
   * Generates DexScreener URL for a token
   */
  private getDexScreenerUrl(tokenAddress: string): string {
    return `https://dexscreener.com/bsc/${tokenAddress}`;
  }

  /**
   * Formats picks for AI consumption without requiring a Context object
   * Updated to reflect new safety-first selection criteria
   * @returns Object with formatted picks data for AI to process
   */
  public async formatPicksForAI(picks: TodaysPickData[]): Promise<any> {
    // Return empty result if no picks
    if (!picks || picks.length === 0) {
        return { hasData: false, count: 0, picks: [] };
    }

    // Format each pick for AI consumption
    const formattedPicks = picks.map(pick => ({
        name: pick.name,
        symbol: pick.symbol,
        address: pick.tokenAddress,
        price: pick.price,
        priceFormatted: formatUSDValue(pick.price),
        priceChange24h: pick.priceChange24h,
        volume24h: pick.volume24h,
        volumeFormatted: formatUSDValue(pick.volume24h),
        marketCap: pick.marketCap,
        marketCapFormatted: formatUSDValue(pick.marketCap),
        safetyScore: pick.safetyScore,
        buyerCount24h: pick.buyerCount24h || 0,
        sellerCount24h: pick.sellerCount24h || 0,
        totalActivity24h: (pick.buyerCount24h || 0) + (pick.sellerCount24h || 0),
        riskLevel: pick.safetyScore >= 90 ? 'Very Safe' : 'Safe', // All picks are > 80
        dexScreenerUrl: `https://dexscreener.com/bsc/${pick.tokenAddress}`
    }));

    return { hasData: true, count: formattedPicks.length, picks: formattedPicks };
  }
}