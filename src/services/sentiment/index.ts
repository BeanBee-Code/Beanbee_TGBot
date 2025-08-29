import { createLogger } from '@/utils/logger';
import axios from 'axios';
import { tavilyNewsService } from '../news/tavilyService';
import { geminiAI } from '../ai/geminiService';
import { advancedSentimentAnalyzer } from './advancedAnalyzer';
import { socialMediaSentimentService } from './socialMediaService';
import { SentimentCacheModel } from '@/database/models/SentimentCache';

const log = createLogger('sentiment');

export interface SentimentData {
  overall: {
    score: number; // 0 to 100 (0=Very Bearish, 50=Neutral, 100=Very Bullish)
    label: 'Very Bearish' | 'Bearish' | 'Neutral' | 'Bullish' | 'Very Bullish';
    confidence: number; // 0 to 1
  };
  sources: {
    news: {
      score: number;
      articles: number;
      topHeadlines: string[];
    };
    social: {
      score: number;
      mentions: number;
      trending: boolean;
    };
    market: {
      priceChange24h: number;
      volumeChange24h: number;
      dominance: number;
    };
  };
  insights: string[];
  timestamp: Date;
}

interface CryptoFearGreedData {
  value: string;
  value_classification: string;
  timestamp: string;
}

export class SentimentAnalysisService {
  private static instance: SentimentAnalysisService;
  private fearGreedCache: Map<string, { data: CryptoFearGreedData; timestamp: number }> = new Map();
  private marketMetricsCache: Map<string, { data: any; timestamp: number }> = new Map();
  private sentimentCache: Map<string, { data: SentimentData; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 3600000; // 1 hour
  private readonly SHORT_CACHE_DURATION = 300000; // 5 minutes for sentiment data

  private constructor() {}

  static getInstance(): SentimentAnalysisService {
    if (!SentimentAnalysisService.instance) {
      SentimentAnalysisService.instance = new SentimentAnalysisService();
    }
    return SentimentAnalysisService.instance;
  }

  clearCache(): void {
    this.fearGreedCache.clear();
    this.marketMetricsCache.clear();
    this.sentimentCache.clear();
    log.info('Cleared all sentiment caches');
  }

  async clearDatabaseCache(timeframe?: '1h' | '24h' | '7d' | '30d', lang?: 'en' | 'zh'): Promise<void> {
    try {
      if (timeframe && lang) {
        // Clear specific timeframe and language
        const cacheKey = `sentiment_${timeframe}_${lang}`;
        await SentimentCacheModel.deleteMany({ key: cacheKey });
        log.info(`Cleared database cache for timeframe: ${timeframe}, language: ${lang}`);
      } else if (timeframe) {
        // Clear all languages for specific timeframe
        await SentimentCacheModel.deleteMany({ 
          key: { $regex: `^sentiment_${timeframe}(_.*)?$` }
        });
        log.info(`Cleared database cache for timeframe: ${timeframe} (all languages)`);
      } else if (lang) {
        // Clear specific language for all timeframes
        await SentimentCacheModel.deleteMany({ 
          key: { $regex: `_${lang}$` }
        });
        log.info(`Cleared database cache for language: ${lang} (all timeframes)`);
      } else {
        // Clear everything
        await SentimentCacheModel.deleteMany({});
        log.info('Cleared all sentiment database cache');
      }
    } catch (error) {
      log.error('Failed to clear database cache:', error);
      throw error;
    }
  }

  async analyzeBSCSentiment(timeframe: '1h' | '24h' | '7d' | '30d' = '24h', lang: 'en' | 'zh' = 'en'): Promise<SentimentData> {
    const startTime = Date.now();
    // 👇👇👇 MODIFICATION 1: Create a language-specific cache key 👇👇👇
    const cacheKey = `sentiment_${timeframe}_${lang}`; 
    // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    
    try {
      const cached = this.sentimentCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.SHORT_CACHE_DURATION) {
        log.info('Returning cached sentiment data from memory', { 
          timeframe,
          lang, // Add lang to log
          cacheAge: Date.now() - cached.timestamp,
          cacheKey 
        });
        return cached.data;
      }

      // Check database cache (24 hours for DB cache)
      const dbCacheExpiryTime = 24 * 60 * 60 * 1000; // 24 hours
      const dbCache = await SentimentCacheModel.findOne({
        key: cacheKey,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      // If we have valid DB cache, use it
      if (dbCache && new Date().getTime() - dbCache.dataTimestamp.getTime() < dbCacheExpiryTime) {
        log.info('Returning sentiment data from database cache', {
          timeframe,
          lang, // Add lang to log
          cacheAge: new Date().getTime() - dbCache.dataTimestamp.getTime(),
          cacheKey
        });

        const sentimentData: SentimentData = {
          overall: {
            score: dbCache.overallScore,
            label: dbCache.overallLabel as any,
            confidence: dbCache.confidence
          },
          sources: {
            news: dbCache.newsData,
            social: dbCache.socialData,
            market: dbCache.marketData
          },
          insights: dbCache.insights,
          timestamp: dbCache.dataTimestamp
        };

        // Update in-memory cache
        this.sentimentCache.set(cacheKey, { data: sentimentData, timestamp: Date.now() });
        return sentimentData;
      }

      log.info('Starting BSC sentiment analysis', { 
        timeframe,
        timestamp: new Date().toISOString() 
      });

      // Try to fetch fresh data
      let sentimentData: SentimentData;
      let fetchSuccess = false;
      let dataSourcesValid: Record<string, boolean> = {};

      try {
        // Fetch multiple data sources in parallel
        log.info('Fetching data sources in parallel...');
        const [newsData, fearGreedData, marketData, socialDataRaw] = await Promise.all([
          this.getNewsSentiment(timeframe).catch(err => {
            log.error('Failed to fetch news sentiment:', err);
            return null;
          }),
          this.getFearAndGreedIndex().catch(err => {
            log.error('Failed to fetch fear & greed index:', err);
            return null;
          }),
          this.getMarketMetrics(timeframe).catch(err => {
            log.error('Failed to fetch market metrics:', err);
            return null;
          }),
          this.getSocialMediaSentiment().catch(err => {
            log.error('Failed to fetch social media sentiment:', err);
            return null;
          })
        ]);

        // Check if we have at least some valid data
        if (!newsData && !marketData && !socialDataRaw && !fearGreedData) {
          throw new Error('All data sources failed');
        }

        // Track which data sources succeeded
        dataSourcesValid = {
          news: !!newsData,
          fearGreed: !!fearGreedData,
          market: !!marketData,
          social: !!socialDataRaw
        };
        
        // Only consider fetch successful if we have at least 2 valid data sources
        const validSourceCount = Object.values(dataSourcesValid).filter(v => v).length;
        const hasMinimumValidData = validSourceCount >= 2;

        // Use fallback values for failed sources
        const finalNewsData = newsData || { score: 50, articles: 0, topHeadlines: [] };
        const finalFearGreedData = fearGreedData || 50;
        const finalMarketData = marketData || { priceChange24h: 0, volumeChange24h: 0, dominance: 3.5 };
        const finalSocialData = socialDataRaw || { overall: 0, totalPosts: 0, trending: false };
        
        log.info('Data sources processing complete', {
          validSources: Object.entries(dataSourcesValid).filter(([_, v]) => v).map(([k]) => k),
          invalidSources: Object.entries(dataSourcesValid).filter(([_, v]) => !v).map(([k]) => k),
          newsScore: finalNewsData.score,
          newsArticles: finalNewsData.articles,
          fearGreed: finalFearGreedData,
          priceChange: finalMarketData.priceChange24h,
          volumeChange: finalMarketData.volumeChange24h,
          socialScore: finalSocialData.overall,
          socialPosts: finalSocialData.totalPosts,
          willSaveToDb: hasMinimumValidData
        });

        // Calculate overall sentiment score with social data
        const overallScore = this.calculateOverallScore(finalNewsData, finalFearGreedData, finalMarketData, finalSocialData);
        
        // Generate AI insights
        const insights = await this.generateAIInsights(finalNewsData, finalFearGreedData, finalMarketData, overallScore, timeframe, lang).catch(err => {
          log.error('Failed to generate AI insights:', err);
          return ['Market sentiment analysis based on available data.'];
        });

        sentimentData = {
          overall: {
            score: overallScore,
            label: this.getScoreLabel(overallScore),
            confidence: this.calculateConfidence(finalNewsData, finalMarketData)
          },
          sources: {
            news: finalNewsData,
            social: {
              score: Math.round((finalSocialData.overall + 1) * 50), // Convert -1 to 1 => 0 to 100
              mentions: finalSocialData.totalPosts,
              trending: finalSocialData.trending
            },
            market: finalMarketData
          },
          insights: hasMinimumValidData ? insights : [...insights, 'Note: Limited data sources available.'],
          timestamp: new Date()
        };

        // Only mark as successful if we have enough valid data
        fetchSuccess = hasMinimumValidData;
      } catch (fetchError) {
        log.error('Failed to fetch fresh sentiment data, falling back to DB cache', fetchError);
        
        // If we have any DB cache (even expired), use it
        if (dbCache) {
          log.info('Using expired database cache as fallback', {
            timeframe,
            cacheAge: new Date().getTime() - dbCache.dataTimestamp.getTime()
          });

          sentimentData = {
            overall: {
              score: dbCache.overallScore,
              label: dbCache.overallLabel as any,
              confidence: dbCache.confidence
            },
            sources: {
              news: dbCache.newsData,
              social: dbCache.socialData,
              market: dbCache.marketData
            },
            insights: [...dbCache.insights, 'Note: This data may be outdated due to connection issues.'],
            timestamp: dbCache.dataTimestamp
          };
        } else {
          // No cache available at all, return default data
          log.warn('No cache available, returning default sentiment data');
          sentimentData = {
            overall: {
              score: 50,
              label: 'Neutral',
              confidence: 0.3
            },
            sources: {
              news: { score: 50, articles: 0, topHeadlines: [] },
              social: { score: 50, mentions: 0, trending: false },
              market: { priceChange24h: 0, volumeChange24h: 0, dominance: 3.5 }
            },
            insights: ['Unable to fetch current market sentiment. Please try again later.'],
            timestamp: new Date()
          };
        }
      }

      // Cache the result
      this.sentimentCache.set(cacheKey, { data: sentimentData, timestamp: Date.now() });

      // Save to database only if we have good quality data
      if (fetchSuccess) {
        try {
          await SentimentCacheModel.findOneAndUpdate(
            { key: cacheKey },
            {
              key: cacheKey,
              timeframe,
              overallScore: sentimentData.overall.score,
              overallLabel: sentimentData.overall.label,
              confidence: sentimentData.overall.confidence,
              newsData: sentimentData.sources.news,
              socialData: sentimentData.sources.social,
              marketData: sentimentData.sources.market,
              insights: sentimentData.insights,
              dataTimestamp: sentimentData.timestamp,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // Expire after 7 days
            },
            { upsert: true, new: true }
          );
          log.info('Sentiment data saved to database cache', {
            cacheKey, // Log the new key
            validSources: Object.entries(dataSourcesValid || {})
              .filter(([_, valid]) => valid)
              .map(([source]) => source)
          });
        } catch (dbError) {
          log.error('Failed to save sentiment data to database:', dbError);
        }
      } else {
        log.warn('Not saving to database cache due to insufficient valid data sources', {
          fetchSuccess,
          validSourceCount: Object.values(dataSourcesValid || {}).filter(v => v).length
        });
      }

      log.info('Sentiment analysis completed', {
        timeframe,
        overallScore: sentimentData.overall.score,
        confidence: sentimentData.overall.confidence,
        duration: Date.now() - startTime,
        usedCache: !fetchSuccess
      });
      
      return sentimentData;
    } catch (error) {
      log.error('Critical error in sentiment analysis:', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error,
        timeframe,
        duration: Date.now() - startTime
      });
      
      // Try to return any cached data as last resort
      // First try language-specific cache, then fall back to any cache for this timeframe
      const lastResortCache = await SentimentCacheModel.findOne({
        $or: [
          { key: cacheKey }, // Try language-specific first
          { key: `sentiment_${timeframe}` }, // Fall back to old format
          { key: { $regex: `^sentiment_${timeframe}_` } } // Any language for this timeframe
        ]
      }).sort({ createdAt: -1 });
      
      if (lastResortCache) {
        return {
          overall: {
            score: lastResortCache.overallScore,
            label: lastResortCache.overallLabel as any,
            confidence: lastResortCache.confidence
          },
          sources: {
            news: lastResortCache.newsData,
            social: lastResortCache.socialData,
            market: lastResortCache.marketData
          },
          insights: [...lastResortCache.insights, 'Note: This is cached data due to an error.'],
          timestamp: lastResortCache.dataTimestamp
        };
      }
      
      throw error;
    }
  }

  private async getNewsSentiment(timeframe: string): Promise<{ score: number; articles: number; topHeadlines: string[] }> {
    try {
      // Fetch news content
      const newsContent = await tavilyNewsService.getDailyCryptoNews();
      
      // Parse news content to extract individual articles
      const articles = newsContent.split('\n\n').filter(section => 
        section.includes('•') || section.includes('-')
      );
      
      if (!articles || articles.length === 0) {
        return { score: 0, articles: 0, topHeadlines: [] };
      }

      // Extract headlines and content
      const newsItems = articles.map(article => {
        const lines = article.split('\n');
        const headline = lines[0].replace(/[•\-*]\s*/, '').trim();
        return {
          headline,
          content: article,
          text: `${headline}. ${lines.slice(1).join(' ')}`
        };
      });

      // Use advanced sentiment analyzer
      const sentimentResult = await advancedSentimentAnalyzer.analyzeMultipleSources(
        newsItems.map(item => ({
          text: item.text,
          weight: 1 // Equal weight for all news items
        }))
      );

      // Convert sentiment score from -1 to 1 range to 0 to 100
      // -1 to 1 => 0 to 100 (where 0.0 = 50)
      const score = Math.round((sentimentResult.score + 1) * 50);
      
      // Get top headlines
      const topHeadlines = newsItems.slice(0, 3).map(item => item.headline);

      return {
        score,
        articles: newsItems.length,
        topHeadlines
      };
    } catch (error) {
      log.error('Error in getNewsSentiment:', {
        error: error instanceof Error ? error.message : error,
        timeframe
      });
      return { score: 50, articles: 0, topHeadlines: [] }; // Return neutral, not 0
    }
  }

  private async getFearAndGreedIndex(): Promise<number> {
    try {
      const cacheKey = 'feargreed';
      const cached = this.fearGreedCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
        return parseInt(cached.data.value);
      }

      // Use Alternative.me Fear & Greed Index API
      const response = await axios.get('https://api.alternative.me/fng/', {
        params: { limit: 1 }
      });

      const data = response.data.data[0] as CryptoFearGreedData;
      this.fearGreedCache.set(cacheKey, { data, timestamp: Date.now() });

      // Already in 0-100 scale, just return it
      const fearGreedValue = parseInt(data.value);
      return fearGreedValue;
    } catch (error) {
      log.error('Error in getFearAndGreedIndex:', {
        error: error instanceof Error ? error.message : error,
        apiUrl: 'https://api.alternative.me/fng/'
      });
      return 50; // Return neutral (50) instead of 0
    }
  }

  private async getMarketMetrics(timeframe: string = '24h'): Promise<{ priceChange24h: number; volumeChange24h: number; dominance: number }> {
    try {
      // Check cache first with timeframe-specific key
      const cacheKey = `market_metrics_${timeframe}`;
      const cached = this.marketMetricsCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.SHORT_CACHE_DURATION) {
        return cached.data;
      }

      // Fetch real BNB data from CoinGecko
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'binancecoin',
          vs_currencies: 'usd',
          include_24hr_change: true,
          include_24hr_vol: true,
          include_market_cap: true
        }
      });

      const bnbData = response.data.binancecoin;
      
      // For different timeframes, we need to use different endpoints
      let priceChange = bnbData.usd_24h_change || 0;
      let volumeChange = 0; // CoinGecko doesn't provide volume change in simple endpoint
      
      // For 1h and 7d, we need to fetch from market chart endpoint
      if (timeframe === '1h' || timeframe === '7d') {
        try {
          const days = timeframe === '1h' ? 1 : 7;
          const marketChartResponse = await axios.get(
            `https://api.coingecko.com/api/v3/coins/binancecoin/market_chart`,
            {
              params: {
                vs_currency: 'usd',
                days: days,
                interval: timeframe === '1h' ? 'hourly' : 'daily'
              }
            }
          );
          
          const prices = marketChartResponse.data.prices;
          const volumes = marketChartResponse.data.total_volumes;
          
          if (prices && prices.length >= 2) {
            if (timeframe === '1h') {
              // Compare last hour
              const currentPrice = prices[prices.length - 1][1];
              const hourAgoPrice = prices[Math.max(0, prices.length - 2)][1];
              priceChange = ((currentPrice - hourAgoPrice) / hourAgoPrice) * 100;
            } else if (timeframe === '7d') {
              // Compare 7 days
              const currentPrice = prices[prices.length - 1][1];
              const weekAgoPrice = prices[0][1];
              priceChange = ((currentPrice - weekAgoPrice) / weekAgoPrice) * 100;
            }
          }
          
          if (volumes && volumes.length >= 2) {
            const currentVolume = volumes[volumes.length - 1][1];
            const previousVolume = timeframe === '1h' 
              ? volumes[Math.max(0, volumes.length - 2)][1]
              : volumes[0][1];
            volumeChange = ((currentVolume - previousVolume) / previousVolume) * 100;
          }
        } catch (error) {
          log.warn(`Failed to fetch ${timeframe} market data:`, {
            error: error instanceof Error ? error.message : error,
            timeframe,
            apiEndpoint: 'market_chart'
          });
          // Fall back to 24h data
        }
      }
      
      // Fetch global market data for dominance
      const globalResponse = await axios.get('https://api.coingecko.com/api/v3/global');
      const marketCapPercentage = globalResponse.data.data.market_cap_percentage;
      
      const metrics = {
        priceChange24h: priceChange,
        volumeChange24h: volumeChange,
        dominance: marketCapPercentage.bnb || 3.5
      };

      // Cache the result
      this.marketMetricsCache.set(cacheKey, { data: metrics, timestamp: Date.now() });

      return metrics;
    } catch (error) {
      log.error('Error in getMarketMetrics:', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error,
        timeframe
      });
      
      // Fallback to our existing price service
      try {
        log.info('Attempting fallback price fetch...');
        const { getBNBPrice } = await import('../wallet/balance');
        const currentPrice = await getBNBPrice();
        log.info('Fallback price fetched:', { currentPrice });
        
        // Without historical data, we can't calculate 24h change
        // Return neutral values
        return { 
          priceChange24h: 0, 
          volumeChange24h: 0, 
          dominance: 3.5 
        };
      } catch (fallbackError) {
        log.error('Fallback price fetch also failed:', {
          error: fallbackError instanceof Error ? fallbackError.message : fallbackError
        });
        return { priceChange24h: 0, volumeChange24h: 0, dominance: 3.5 };
      }
    }
  }

  private calculateOverallScore(
    news: { score: number },
    fearGreed: number,
    market: { priceChange24h: number; volumeChange24h: number },
    social: { overall: number }
  ): number {
    // Updated weights to include social sentiment
    const weights = {
      news: 0.25,
      social: 0.25,
      fearGreed: 0.15,
      price: 0.25,
      volume: 0.10
    };

    // Convert market metrics to 0-100 scale (50 = neutral)
    const priceScore = Math.max(0, Math.min(100, 50 + market.priceChange24h * 2.5));
    const volumeScore = Math.max(0, Math.min(100, 50 + market.volumeChange24h * 1.25));
    const socialScore = (social.overall + 1) * 50; // Convert from -1 to 1 => 0 to 100

    const weightedScore = 
      news.score * weights.news +
      socialScore * weights.social +
      fearGreed * weights.fearGreed +
      priceScore * weights.price +
      volumeScore * weights.volume;

    return Math.round(weightedScore);
  }

  private getScoreLabel(score: number): 'Very Bearish' | 'Bearish' | 'Neutral' | 'Bullish' | 'Very Bullish' {
    if (score <= 20) return 'Very Bearish';
    if (score <= 40) return 'Bearish';
    if (score <= 60) return 'Neutral';
    if (score <= 80) return 'Bullish';
    return 'Very Bullish';
  }

  private calculateConfidence(news: { articles: number }, market: { volumeChange24h: number }): number {
    // Higher confidence with more data points
    const newsConfidence = Math.min(1, news.articles / 20);
    const volumeConfidence = Math.abs(market.volumeChange24h) > 10 ? 0.8 : 0.5;
    
    return Math.round((newsConfidence + volumeConfidence) / 2 * 100) / 100;
  }


  private async getSocialMediaSentiment(): Promise<{ overall: number; totalPosts: number; trending: boolean }> {
    try {
      const socialData = await socialMediaSentimentService.getAggregatedSocialSentiment();
      
      return {
        overall: socialData.overall,
        totalPosts: socialData.totalPosts,
        trending: socialData.trending
      };
    } catch (error) {
      log.error('Error in getSocialMediaSentiment:', {
        error: error instanceof Error ? error.message : error
      });
      return { overall: 0, totalPosts: 0, trending: false };
    }
  }

  private async generateAIInsights(
    news: { score: number; articles: number; topHeadlines: string[] },
    fearGreed: number,
    market: { priceChange24h: number; volumeChange24h: number; dominance: number },
    overallScore: number,
    timeframe: '1h' | '24h' | '7d' | '30d' = '24h',
    lang: 'en' | 'zh' = 'en'
  ): Promise<string[]> {
    try {
      // Timeframe-specific prompts in English
      let timeframeContextEn = '';
      if (timeframe === '1h') {
        timeframeContextEn = 'Focus on short-term trading opportunities, scalping setups, and immediate market dynamics.';
      } else if (timeframe === '7d') {
        timeframeContextEn = 'Focus on weekly trends, investment opportunities, and medium-term market structure.';
      } else {
        timeframeContextEn = 'Focus on daily trading setups, swing trade opportunities, and 24-hour market dynamics.';
      }

      // Timeframe-specific prompts in Chinese
      let timeframeContextZh = '';
      if (timeframe === '1h') {
        timeframeContextZh = '专注于短期交易机会、剥头皮设置和即时市场动态。';
      } else if (timeframe === '7d') {
        timeframeContextZh = '专注于周度趋势、投资机会和中期市场结构。';
      } else {
        timeframeContextZh = '专注于日内交易设置、波段交易机会和24小时市场动态。';
      }
      
      const promptEn = `
        Based on the following BSC/BNB market data for ${timeframe} timeframe, provide 3-4 concise bullet point insights:
        
        Overall Sentiment Score: ${overallScore} (${this.getScoreLabel(overallScore)})
        News Sentiment: ${news.score} (based on ${news.articles} articles)
        Fear & Greed Index: ${fearGreed}
        Price Change: ${market.priceChange24h.toFixed(2)}%
        Volume Change: ${market.volumeChange24h.toFixed(2)}%
        
        Recent Headlines:
        ${news.topHeadlines.join('\n')}
        
        ${timeframeContextEn}
        Provide actionable insights for BSC/BNB traders. Keep each insight to one sentence.
      `;

      const promptZh = `
        根据以下 ${timeframe} 时间范围的 BSC/BNB 市场数据，提供3-4个简洁的要点分析：
        
        综合情绪得分: ${overallScore} (${this.translateLabel(this.getScoreLabel(overallScore))})
        新闻情绪: ${news.score} (基于 ${news.articles} 篇文章)
        恐惧与贪婪指数: ${fearGreed}
        价格变动: ${market.priceChange24h.toFixed(2)}%
        交易量变动: ${market.volumeChange24h.toFixed(2)}%
        
        最近头条新闻:
        ${news.topHeadlines.join('\n')}
        
        ${timeframeContextZh}
        
        **重要规则：**
        1. 你必须用简体中文回答。
        2. 每个见解必须以 "• " (一个圆点加一个空格) 开头。
        3. 每个见解只占一行。
        4. 提供3到4个见解。
      `;

      const prompt = lang === 'zh' ? promptZh : promptEn;


      // Use the new generateText method for clean text generation
      const response = await geminiAI.generateText(prompt, lang);
      
      
      // Parse bullet points from response
      const insights = response
        .split('\n')
        // Updated regex to catch Chinese and English bullet points
        .filter((line: string) => /^\s*[•\-*•·]\s*/.test(line.trim()))
        .map((line: string) => line.replace(/^\s*[•\-*•·]\s*/, '').trim())
        .filter((line: string) => line.length > 0)
        .slice(0, 4);
      

      if (insights.length === 0) {
        // Fallback insights logic with explicit language parameter
        log.warn('No insights parsed, using fallback logic.', { lang });
        return this.getTimeframeFallbackInsights(overallScore, news, market, timeframe, lang);
      }

      return insights;
    } catch (error) {
      log.error('Error generating AI insights:', {
        error: error instanceof Error ? error.message : error,
        overallScore,
        newsScore: news.score,
        fearGreed,
        timeframe,
        lang
      });
      // Fallback with language support
      return this.getTimeframeFallbackInsights(overallScore, news, market, timeframe, lang);
    }
  }
  
  private getTimeframeFallbackInsights(
    overallScore: number,
    news: { articles: number },
    market: { priceChange24h: number; volumeChange24h: number },
    timeframe: '1h' | '24h' | '7d' | '30d',
    lang: 'en' | 'zh' // Ensure lang is the last parameter
  ): string[] {
    const sentimentEn = this.getScoreLabel(overallScore).toLowerCase();
    
    if (lang === 'zh') {
        const sentimentZh = this.translateLabel(this.getScoreLabel(overallScore));
        if (timeframe === '1h') {
            return [
                `短期势头为${sentimentZh}`,
                market.volumeChange24h > 5 ? '交易量激增，表明交易活跃' : '交易量低，表明处于区间波动',
                Math.abs(market.priceChange24h) > 1 ? '波动性为剥头皮交易者提供了机会' : '窄幅波动对做市商有利'
            ];
        } else if (timeframe === '7d') {
            return [
                `周线趋势保持${sentimentZh}`,
                news.articles > 10 ? '强大的新闻报道支持长期走势' : '新闻流有限，暗示处于吸筹阶段',
                overallScore > 60 ? '考虑在回调时建仓' : overallScore < 40 ? '等待市场稳定后再投资' : '中性区域提供了平衡的风险回报'
            ];
        } else {
            return [
                `市场情绪为${sentimentZh}，强度为${overallScore}%`,
                news.articles > 10 ? '媒体高度关注，市场热度增加' : '媒体关注度低，处于盘整阶段',
                market.volumeChange24h > 0 ? '交易量上升支持当前价格趋势' : '交易量下降可能预示趋势减弱'
            ];
        }
    }

    // English Fallback (original logic)
    if (timeframe === '1h') {
      return [
        `Short-term momentum is ${sentimentEn}`,
        market.volumeChange24h > 5 ? 'Volume spike suggests active trading session' : 'Low volume indicates range-bound conditions',
        Math.abs(market.priceChange24h) > 1 ? 'Volatility presents scalping opportunities' : 'Tight ranges favor market makers'
      ];
    } else if (timeframe === '7d') {
      return [
        `Weekly trend remains ${sentimentEn}`,
        news.articles > 10 ? 'Strong media coverage supports longer-term moves' : 'Limited news flow suggests accumulation phase',
        overallScore > 60 ? 'Consider building positions on pullbacks' : overallScore < 40 ? 'Wait for stabilization before investing' : 'Neutral zone offers balanced risk/reward'
      ];
    } else {
      return [
        `Market sentiment is ${sentimentEn} with ${overallScore}% strength`,
        news.articles > 10 ? 'High media coverage indicates increased market attention' : 'Low media coverage suggests consolidation phase',
        market.volumeChange24h > 0 ? 'Rising volume supports current price trend' : 'Declining volume may signal trend weakness'
      ];
    }
  }

  formatQuickSentimentSummary(data: SentimentData, lang: 'en' | 'zh', timeframe: '1h' | '24h' | '7d' | '30d' = '24h'): string {
    if (lang === 'zh') {
      // Keep original Chinese format
      const emoji = this.getSentimentEmoji(data.overall.score);
      
      let summary = `${emoji} *BSC 市场情绪*\n\n`;
      summary += `📊 *整体:* ${this.translateLabel(data.overall.label)}\n`;
      summary += `${this.getSentimentBar(data.overall.score)}\n`;
      summary += `*${data.overall.score}/100*\n\n`;
      
      summary += `📰 新闻: ${this.translateLabel(this.getScoreLabel(data.sources.news.score))} (${data.sources.news.articles} 篇)\n`;
      summary += `💬 社交: ${data.sources.social.score} ${data.sources.social.trending ? '🔥' : ''}\n`;
      summary += `📈 市场 (24h): ${data.sources.market.priceChange24h > 0 ? '📈' : '📉'} ${data.sources.market.priceChange24h.toFixed(2)}%\n\n`;
      
      if (data.insights.length > 0) {
        summary += `💡 *关键洞察:*\n`;
        summary += `_${data.insights[0]}_`;
      }
      
      return summary;
    }
    
    // English - Natural language format based on timeframe
    if (timeframe === '1h') {
      return this.formatHourlyQuickSummary(data);
    } else if (timeframe === '7d') {
      return this.formatWeeklyQuickSummary(data);
    } else {
      return this.formatDailyQuickSummary(data);
    }
  }
  
  private formatHourlyQuickSummary(data: SentimentData): string {
    const priceMove = Math.abs(data.sources.market.priceChange24h);
    const isVolatile = priceMove > 2;
    const momentum = data.overall.score > 60 ? 'bullish' : data.overall.score < 40 ? 'bearish' : 'neutral';
    
    let summary = `🕐 *1 Hour Sentiment Snapshot*\n\n`;
    
    // Natural language assessment
    if (isVolatile) {
      summary += `Market showing ${priceMove > 3 ? 'high' : 'moderate'} volatility. `;
    } else {
      summary += `Calm trading conditions. `;
    }
    
    if (data.sources.social.trending) {
      summary += `Social buzz is picking up 🔥\n`;
    } else {
      summary += `Normal social activity levels.\n`;
    }
    
    // Short-term trading insight
    if (momentum === 'bullish' && isVolatile) {
      summary += `\n💡 *Quick Take:* Momentum traders eyeing entries. Watch for continuation above key levels.`;
    } else if (momentum === 'bearish' && isVolatile) {
      summary += `\n💡 *Quick Take:* Short-term selling pressure. Support levels being tested.`;
    } else {
      summary += `\n💡 *Quick Take:* Range-bound action. Scalpers waiting for directional break.`;
    }
    
    return summary;
  }
  
  private formatDailyQuickSummary(data: SentimentData): string {
    let summary = `*BeanBee Quick Brief*\n\n`;
    
    summary += `${data.overall.label} (${data.overall.score}/100)\n`;
    summary += `BNB (24h): ${data.sources.market.priceChange24h >= 0 ? '+' : ''}${data.sources.market.priceChange24h.toFixed(2)}%`;
    
    if (data.sources.social.trending) {
      summary += ` 🔥 Trending`;
    }
    
    summary += `\n\n`;
    
    // Quick assessment
    const confidence = Math.round(data.overall.confidence * 100);
    if (confidence < 40) {
      summary += `⚠️ Low confidence. Mixed signals.\n`;
    } else if (data.overall.score > 60) {
      summary += `📈 Bullish bias detected.\n`;
    } else if (data.overall.score < 40) {
      summary += `📉 Bearish pressure building.\n`;
    } else {
      summary += `➡️ Market neutral.\n`;
    }
    
    // Most important insight
    const insights = this.generateTraderInsights(data);
    if (insights.length > 0) {
      summary += `\n${insights[0]}`;
    }
    
    return summary;
  }
  
  private formatWeeklyQuickSummary(data: SentimentData): string {
    const trend = data.overall.score > 60 ? 'uptrend' : data.overall.score < 40 ? 'downtrend' : 'consolidation';
    
    let summary = `📅 *7 Day Market Overview*\n\n`;
    
    // Weekly trend narrative
    if (trend === 'uptrend') {
      summary += `BNB maintaining positive momentum this week. `;
      if (data.sources.news.articles > 10) {
        summary += `Strong news flow supporting the rally.\n`;
      } else {
        summary += `Steady accumulation pattern developing.\n`;
      }
    } else if (trend === 'downtrend') {
      summary += `Selling pressure persisting through the week. `;
      if (data.sources.market.volumeChange24h < -10) {
        summary += `Volume declining suggests capitulation phase.\n`;
      } else {
        summary += `Orderly pullback with support levels ahead.\n`;
      }
    } else {
      summary += `BNB trading sideways this week. `;
      summary += `Market waiting for catalyst to break ${data.sources.market.priceChange24h > 0 ? 'resistance' : 'support'}.\n`;
    }
    
    // Weekly investor insight
    summary += `\n💼 *Investor Note:* `;
    if (trend === 'uptrend' && data.overall.confidence > 0.6) {
      summary += `Consider adding on dips. Weekly structure remains intact.`;
    } else if (trend === 'downtrend') {
      summary += `Patience recommended. Wait for signs of stabilization.`;
    } else {
      summary += `Accumulation zone forming. Good entry opportunities for patient buyers.`;
    }
    
    return summary;
  }

  formatSentimentReport(data: SentimentData, lang: 'en' | 'zh', timeframe: '1h' | '24h' | '7d' | '30d' = '24h'): string {
    if (lang === 'zh') {
      // Chinese version - keep original format for now
      return this.formatChineseSentimentReport(data);
    }
    
    // English - Natural format based on timeframe
    if (timeframe === '1h') {
      return this.formatHourlyDetailedReport(data);
    } else if (timeframe === '7d') {
      return this.formatWeeklyDetailedReport(data);
    } else {
      return this.formatDailyDetailedReport(data);
    }
  }
  
  private formatHourlyDetailedReport(data: SentimentData): string {
    const momentum = data.overall.score > 60 ? 'bullish' : data.overall.score < 40 ? 'bearish' : 'neutral';
    const priceMove = Math.abs(data.sources.market.priceChange24h);
    
    let report = `🕐 *Real-Time Market Pulse (1 Hour View)*\n\n`;
    
    // Opening assessment
    if (momentum === 'bullish') {
      report += `Bulls in control this hour. `;
      if (priceMove > 1) {
        report += `Strong momentum building.\n\n`;
      } else {
        report += `Steady accumulation phase.\n\n`;
      }
    } else if (momentum === 'bearish') {
      report += `Bears taking charge. `;
      if (priceMove > 1) {
        report += `Selling accelerating.\n\n`;
      } else {
        report += `Gradual distribution ongoing.\n\n`;
      }
    } else {
      report += `Market undecided. Choppy action as traders wait for direction.\n\n`;
    }
    
    // Micro structure
    report += `*Micro Structure:*\n`;
    if (data.sources.market.volumeChange24h > 5) {
      report += `• Volume spike detected - ${momentum === 'neutral' ? 'breakout imminent' : 'trend continuation likely'}\n`;
    } else {
      report += `• Low volume - ${momentum === 'neutral' ? 'range-bound trading' : 'potential exhaustion'}\n`;
    }
    
    // Social activity in real-time
    if (data.sources.social.trending) {
      report += `• 🔥 Viral activity on crypto Twitter - expect volatility\n`;
    } else if (data.sources.social.mentions > 30) {
      report += `• Elevated chatter - traders positioning\n`;
    } else {
      report += `• Quiet social feeds - institutional hour\n`;
    }
    
    // Scalping opportunities
    report += `\n*Scalp Zones:*\n`;
    if (momentum === 'bullish') {
      report += `• Look for dips to VWAP for entries\n`;
      report += `• Resistance cluster forming 0.5-1% above\n`;
    } else if (momentum === 'bearish') {
      report += `• Bounces to VWAP are shorting opportunities\n`;
      report += `• Support watching 0.5-1% below\n`;
    } else {
      report += `• Trade the range edges\n`;
      report += `• Mid-range is no-trade zone\n`;
    }
    
    // Risk alert
    report += `\n⚡ *Quick Risk:* `;
    if (priceMove > 2 && data.sources.market.volumeChange24h < 0) {
      report += `Divergence alert - false move possible`;
    } else if (data.sources.social.trending) {
      report += `High volatility environment - reduce size`;
    } else {
      report += `Normal conditions - standard risk applies`;
    }
    
    return report;
  }
  
  private formatDailyDetailedReport(data: SentimentData): string {
    const confidence = Math.round(data.overall.confidence * 100);
    const priceAbs = Math.abs(data.sources.market.priceChange24h);
    
    // Original daily format
    let report = `*BeanBee - Market Brief (BNB Chain | 24h)*\n\n`;
    
    // Sentiment line
    report += `*Sentiment:* ${data.overall.label} (Score: ${data.overall.score}/100)\n\n`;
    
    // Confidence assessment
    if (confidence < 40) {
      report += `⚠️ Confidence low (${confidence}%). No strong directional bias. Stay flexible.\n\n`;
    } else if (confidence < 70) {
      report += `📊 Moderate confidence (${confidence}%). Signals present but mixed.\n\n`;
    } else {
      report += `✅ High confidence (${confidence}%). Clear market direction.\n\n`;
    }
    
    // News
    report += `*News:* `;
    if (data.sources.news.articles === 0) {
      report += `No articles indexed. Flying blind on news flow.\n\n`;
    } else if (data.sources.news.articles === 1) {
      report += `1 article indexed. No major catalysts in the last 24h.\n\n`;
    } else if (data.sources.news.articles < 5) {
      report += `${data.sources.news.articles} articles tracked. ${data.sources.news.score > 60 ? 'Positive bias emerging' : data.sources.news.score < 40 ? 'Negative tone building' : 'Mixed signals'}.\n\n`;
    } else {
      report += `${data.sources.news.articles} articles indexed. ${data.sources.news.score > 60 ? 'Bullish narrative' : data.sources.news.score < 40 ? 'Bearish headlines' : 'Neutral coverage'}.\n\n`;
    }
    
    // Social
    report += `*Social (Twitter):*\n`;
    report += `• ${data.sources.social.mentions} posts scanned. `;
    
    if (data.sources.social.score > 70) {
      report += `Sentiment bullish.\n`;
    } else if (data.sources.social.score < 30) {
      report += `Sentiment bearish.\n`;
    } else {
      report += `Sentiment balanced.\n`;
    }
    
    if (data.sources.social.trending) {
      report += `• 🔥 Trending across BNB tags. Volume spike likely.\n\n`;
    } else {
      report += `• Nothing trending across BNB tags.\n\n`;
    }
    
    // Price Action
    report += `*Price Action:*\n`;
    report += `• BNB (24h): ${data.sources.market.priceChange24h >= 0 ? '+' : ''}${data.sources.market.priceChange24h.toFixed(2)}%\n`;
    
    // Volume context
    const volChange = Math.abs(data.sources.market.volumeChange24h);
    if (volChange < 5) {
      report += `• Volume flat. `;
      if (priceAbs > 1) {
        report += `Likely short-covering or mild rotation, not breakout momentum.\n\n`;
      } else {
        report += `Market in wait-and-see mode.\n\n`;
      }
    } else if (data.sources.market.volumeChange24h > 10) {
      report += `• Volume +${data.sources.market.volumeChange24h.toFixed(1)}%. `;
      report += data.sources.market.priceChange24h > 0 ? `Buyers stepping in.\n\n` : `Distribution in progress.\n\n`;
    } else if (data.sources.market.volumeChange24h < -10) {
      report += `• Volume -${volChange.toFixed(1)}%. Interest waning. Watch for continuation.\n\n`;
    } else {
      report += `• Volume ${data.sources.market.volumeChange24h > 0 ? '+' : ''}${data.sources.market.volumeChange24h.toFixed(1)}%. Normal trading activity.\n\n`;
    }
    
    // Highlights (actionable insights)
    report += `*Highlights:*\n`;
    
    // Custom trader-focused insights based on data
    const insights = this.generateTraderInsights(data);
    insights.forEach(insight => {
      report += `• ${insight}\n`;
    });
    
    report += `\nWill ping if sentiment shifts or new flags pop. You'll know before the rest do.`;
    
    return report;
  }
  
  private formatWeeklyDetailedReport(data: SentimentData): string {
    const trend = data.overall.score > 60 ? 'bullish' : data.overall.score < 40 ? 'bearish' : 'neutral';
    const priceChange = data.sources.market.priceChange24h;
    
    let report = `📊 *Weekly Market Analysis (7 Day Perspective)*\n\n`;
    
    // Weekly overview
    report += `*The Big Picture:*\n`;
    if (trend === 'bullish') {
      report += `BNB showing strength over the past week. `;
      if (data.sources.news.articles > 15) {
        report += `Heavy news coverage suggests institutional interest growing.\n\n`;
      } else {
        report += `Quiet accumulation phase - smart money positioning.\n\n`;
      }
    } else if (trend === 'bearish') {
      report += `Weakness persisting in BNB markets. `;
      if (data.overall.confidence > 0.7) {
        report += `Clear distribution pattern - caution advised.\n\n`;
      } else {
        report += `Mixed signals suggest potential bottom forming.\n\n`;
      }
    } else {
      report += `BNB consolidating in a tight range. `;
      report += `Market coiling for next major move.\n\n`;
    }
    
    // Weekly structure analysis
    report += `*Market Structure:*\n`;
    
    // Trend strength
    if (Math.abs(priceChange) > 5) {
      report += `• Strong ${priceChange > 0 ? 'uptrend' : 'downtrend'} - ${Math.abs(priceChange).toFixed(1)}% move\n`;
    } else if (Math.abs(priceChange) > 2) {
      report += `• Moderate ${priceChange > 0 ? 'bullish' : 'bearish'} bias\n`;
    } else {
      report += `• Neutral range-bound action\n`;
    }
    
    // Volume profile
    if (data.sources.market.volumeChange24h > 20) {
      report += `• Volume surge indicates ${trend === 'bullish' ? 'accumulation' : 'distribution'}\n`;
    } else if (data.sources.market.volumeChange24h < -20) {
      report += `• Volume drying up - ${trend === 'neutral' ? 'breakout pending' : 'trend exhaustion'}\n`;
    } else {
      report += `• Healthy volume supporting current structure\n`;
    }
    
    // Social dynamics over the week
    report += `\n*Social Sentiment Evolution:*\n`;
    if (data.sources.social.trending) {
      report += `• Viral momentum building - retail FOMO kicking in\n`;
    } else if (data.sources.social.score > 60) {
      report += `• Positive sentiment growing organically\n`;
    } else if (data.sources.social.score < 40) {
      report += `• Bearish narrative dominating discussions\n`;
    } else {
      report += `• Mixed opinions - market at inflection point\n`;
    }
    
    // Investment thesis
    report += `\n*Investment Thesis:*\n`;
    const insights = this.generateWeeklyInvestmentInsights(data);
    insights.forEach(insight => {
      report += `• ${insight}\n`;
    });
    
    // Key levels to watch
    report += `\n*Week Ahead:*\n`;
    if (trend === 'bullish') {
      report += `Watch for continuation above weekly highs. Dips are buying opportunities until trend breaks.`;
    } else if (trend === 'bearish') {
      report += `Rallies likely to face selling. Wait for clear reversal signals before catching knives.`;
    } else {
      report += `Range trade until breakout confirmed. Key levels define risk/reward clearly.`;
    }
    
    return report;
  }
  
  private generateWeeklyInvestmentInsights(data: SentimentData): string[] {
    const insights: string[] = [];
    const trend = data.overall.score > 60 ? 'bullish' : data.overall.score < 40 ? 'bearish' : 'neutral';
    
    // Market regime insight
    if (trend === 'bullish' && data.sources.market.volumeChange24h > 10) {
      insights.push('Bullish regime confirmed - buy dips strategy optimal');
    } else if (trend === 'bearish' && data.sources.market.volumeChange24h < -10) {
      insights.push('Bear market rules apply - preserve capital, wait for reversal');
    } else if (trend === 'neutral') {
      insights.push('Accumulation phase - dollar cost averaging recommended');
    }
    
    // News cycle impact
    if (data.sources.news.articles > 20 && data.sources.news.score > 60) {
      insights.push('Positive news cycle supporting higher prices medium-term');
    } else if (data.sources.news.articles < 5) {
      insights.push('Low media attention - potential for surprise moves');
    }
    
    // Risk assessment
    if (data.overall.confidence < 0.5) {
      insights.push('Mixed signals warrant smaller position sizes');
    } else if (data.overall.confidence > 0.8) {
      insights.push('High conviction setup - consider scaling positions');
    }
    
    // Contrarian opportunities
    if (data.overall.score < 30 && data.sources.social.mentions < 20) {
      insights.push('Extreme pessimism often marks bottoms - contrarian opportunity');
    } else if (data.overall.score > 80 && data.sources.social.trending) {
      insights.push('Euphoria signals - consider taking profits on strength');
    }
    
    return insights.slice(0, 3);
  }

  private getSentimentEmoji(score: number): string {
    if (score <= 20) return '🐻💀'; // Very Bearish
    if (score <= 40) return '🐻'; // Bearish
    if (score <= 60) return '😐'; // Neutral
    if (score <= 80) return '🐂'; // Bullish
    return '🐂🚀'; // Very Bullish
  }

  private getSentimentBar(score: number): string {
    const normalized = score / 100; // Already 0 to 100, just normalize to 0 to 1
    const filledBlocks = Math.round(normalized * 10);
    const emptyBlocks = 10 - filledBlocks;
    
    return '▓'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
  }

  private getConfidenceBar(confidence: number): string {
    const percentage = Math.round(confidence * 100);
    if (confidence >= 0.8) return `${percentage}% ⭐⭐⭐⭐⭐`;
    if (confidence >= 0.6) return `${percentage}% ⭐⭐⭐⭐`;
    if (confidence >= 0.4) return `${percentage}% ⭐⭐⭐`;
    if (confidence >= 0.2) return `${percentage}% ⭐⭐`;
    return `${percentage}% ⭐`;
  }

  private translateLabel(label: string): string {
    const translations: Record<string, string> = {
      'Very Bearish': '极度看跌',
      'Bearish': '看跌',
      'Neutral': '中性',
      'Bullish': '看涨',
      'Very Bullish': '极度看涨'
    };
    return translations[label] || label;
  }

  private formatChineseSentimentReport(data: SentimentData): string {
    // Keep original Chinese format
    const emoji = this.getSentimentEmoji(data.overall.score);
    const confidenceBar = this.getConfidenceBar(data.overall.confidence);
    
    let report = `${emoji} *BSC 市场情绪分析*\n\n`;
    
    report += `📊 *整体情绪:* ${this.translateLabel(data.overall.label)}\n`;
    report += `${this.getSentimentBar(data.overall.score)}\n`;
    report += `*分数:* ${data.overall.score}/100 | *置信度:* ${confidenceBar}\n\n`;
    
    report += `📰 *新闻分析*\n`;
    const newsDescription = this.getNewsDescription(data.sources.news, 'zh');
    report += `• ${newsDescription}\n\n`;
    
    report += `💬 *社交媒体活动*\n`;
    const socialDescription = this.getSocialDescription(data.sources.social, 'zh');
    report += `• ${socialDescription}\n\n`;
    
    report += `📈 *市场表现*\n`;
    const marketDescription = this.getMarketDescription(data.sources.market, 'zh');
    report += `• ${marketDescription}\n\n`;
    
    report += `🤖 *AI 驱动的洞察*\n`;
    data.insights.forEach(insight => {
      report += `• ${insight}\n`;
    });
    
    report += `\n⏰ _更新时间: ${data.timestamp.toLocaleString('zh-CN')}_`;
    
    return report;
  }

  private generateTraderInsights(data: SentimentData): string[] {
    const insights: string[] = [];
    const fearGreedEstimate = this.estimateFearGreedFromData(data);
    
    // Fear & Greed insight
    if (fearGreedEstimate > 70) {
      insights.push('Greed level rising → tighten risk, be careful of overconfidence.');
    } else if (fearGreedEstimate < 30) {
      insights.push('Fear dominant → potential bottom fishing opportunity if fundamentals hold.');
    }
    
    // News catalyst insight
    if (data.sources.news.articles === 0) {
      insights.push('No news tailwinds — hold off on size until confirmation.');
    } else if (data.sources.news.articles > 5 && data.sources.news.score > 60) {
      insights.push('Positive news flow building — watch for momentum acceleration.');
    }
    
    // Volume/Price divergence
    const priceUp = data.sources.market.priceChange24h > 0;
    const volumeUp = data.sources.market.volumeChange24h > 5;
    const volumeDown = data.sources.market.volumeChange24h < -5;
    
    if (priceUp && volumeDown) {
      insights.push('Price up on declining volume → bearish divergence, watch for reversal.');
    } else if (!priceUp && volumeUp) {
      insights.push('Volume surge on down day → potential accumulation or capitulation.');
    }
    
    // Social sentiment divergence
    if (data.sources.social.trending && data.overall.score < 40) {
      insights.push('Trending but bearish → contrarian opportunity if oversold.');
    } else if (data.sources.social.trending && data.overall.score > 60) {
      insights.push('Trending with bullish sentiment → momentum play viable.');
    }
    
    // Token-specific insights (if available from topHeadlines)
    if (data.sources.news.topHeadlines?.length > 0) {
      const cakeHeadline = data.sources.news.topHeadlines.find(h => 
        h.toLowerCase().includes('cake') || h.toLowerCase().includes('pancakeswap')
      );
      if (cakeHeadline) {
        insights.push('$CAKE showing local strength → short-term opportunity IF supported by volume.');
      }
    }
    
    // If no specific insights, provide general guidance
    if (insights.length === 0) {
      if (data.overall.score >= 45 && data.overall.score <= 55) {
        insights.push('Market neutral. Wait for clearer signals before taking position.');
      } else if (data.overall.score > 60) {
        insights.push('Bullish bias developing. Consider scaling in on dips.');
      } else {
        insights.push('Bearish pressure building. Defensive positioning recommended.');
      }
    }
    
    return insights.slice(0, 4); // Return max 4 insights
  }

  private estimateFearGreedFromData(data: SentimentData): number {
    // Estimate fear & greed based on available data
    let score = 50; // Start neutral
    
    // Price impact (30% weight)
    if (data.sources.market.priceChange24h > 5) score += 15;
    else if (data.sources.market.priceChange24h > 2) score += 10;
    else if (data.sources.market.priceChange24h < -5) score -= 15;
    else if (data.sources.market.priceChange24h < -2) score -= 10;
    
    // Social sentiment (30% weight)
    const socialBias = (data.sources.social.score - 50) * 0.6;
    score += socialBias;
    
    // News sentiment (20% weight)
    const newsBias = (data.sources.news.score - 50) * 0.4;
    score += newsBias;
    
    // Volume (20% weight)
    if (data.sources.market.volumeChange24h > 20) score += 10;
    else if (data.sources.market.volumeChange24h < -20) score -= 10;
    
    return Math.max(0, Math.min(100, score));
  }

  private getNewsDescription(news: { score: number; articles: number; topHeadlines: string[] }, lang: 'en' | 'zh'): string {
    const sentiment = this.getScoreLabel(news.score);
    
    if (lang === 'zh') {
      if (news.articles === 0) {
        return '暂无新闻数据';
      } else if (news.articles === 1) {
        return `分析了 1 篇文章，情绪${this.translateLabel(sentiment).toLowerCase()}`;
      } else if (news.articles < 5) {
        return `从 ${news.articles} 篇近期文章中检测到${this.translateLabel(sentiment).toLowerCase()}情绪`;
      } else if (news.articles < 10) {
        return `分析了 ${news.articles} 篇文章，市场情绪${this.translateLabel(sentiment).toLowerCase()}`;
      } else {
        return `基于 ${news.articles} 篇文章的分析显示${this.translateLabel(sentiment).toLowerCase()}趋势`;
      }
    }
    
    // English
    if (news.articles === 0) {
      return 'No news data available';
    } else if (news.articles === 1) {
      return `Analyzed 1 article showing ${sentiment.toLowerCase()} sentiment`;
    } else if (news.articles < 5) {
      return `Found ${sentiment.toLowerCase()} sentiment across ${news.articles} recent articles`;
    } else if (news.articles < 10) {
      return `${news.articles} articles analyzed, market sentiment is ${sentiment.toLowerCase()}`;
    } else {
      return `Analysis of ${news.articles} articles indicates ${sentiment.toLowerCase()} market trend`;
    }
  }

  private getSocialDescription(social: { score: number; mentions: number; trending: boolean }, lang: 'en' | 'zh'): string {
    const sentimentLevel = social.score > 70 ? 'positive' : social.score < 30 ? 'negative' : 'mixed';
    const activity = social.mentions > 50 ? 'high' : social.mentions > 20 ? 'moderate' : 'low';
    
    if (lang === 'zh') {
      let desc = `${social.mentions} 条社交帖子显示`;
      
      if (sentimentLevel === 'positive') {
        desc += '积极情绪';
      } else if (sentimentLevel === 'negative') {
        desc += '消极情绪';
      } else {
        desc += '混合情绪';
      }
      
      if (social.trending) {
        desc += '，当前话题热度较高 🔥';
      } else if (activity === 'high') {
        desc += '，讨论活跃';
      } else if (activity === 'low') {
        desc += '，讨论较少';
      }
      
      return desc;
    }
    
    // English
    let desc = `${social.mentions} social posts show `;
    
    if (sentimentLevel === 'positive') {
      desc += 'positive sentiment';
    } else if (sentimentLevel === 'negative') {
      desc += 'negative sentiment';
    } else {
      desc += 'mixed sentiment';
    }
    
    if (social.trending) {
      desc += ', currently trending 🔥';
    } else if (activity === 'high') {
      desc += ' with high engagement';
    } else if (activity === 'low') {
      desc += ' with low activity';
    }
    
    return desc;
  }

  private getMarketDescription(market: { priceChange24h: number; volumeChange24h: number; dominance: number }, lang: 'en' | 'zh'): string {
    const priceDirection = market.priceChange24h > 0 ? 'up' : market.priceChange24h < 0 ? 'down' : 'flat';
    const volumeDirection = market.volumeChange24h > 0 ? 'increased' : market.volumeChange24h < 0 ? 'decreased' : 'stable';
    const priceAbs = Math.abs(market.priceChange24h);
    const volumeAbs = Math.abs(market.volumeChange24h);
    
    if (lang === 'zh') {
      let desc = 'BNB ';
      
      if (priceDirection === 'up') {
        desc += `上涨 ${priceAbs.toFixed(2)}%`;
      } else if (priceDirection === 'down') {
        desc += `下跌 ${priceAbs.toFixed(2)}%`;
      } else {
        desc += '价格持平';
      }
      
      desc += '，交易量';
      
      if (volumeDirection === 'increased') {
        desc += `增加 ${volumeAbs.toFixed(1)}%`;
      } else if (volumeDirection === 'decreased') {
        desc += `减少 ${volumeAbs.toFixed(1)}%`;
      } else {
        desc += '保持稳定';
      }
      
      if (market.dominance > 4) {
        desc += `，市场占有率 ${market.dominance.toFixed(1)}% 表现强劲`;
      }
      
      return desc;
    }
    
    // English
    let desc = 'BNB ';
    
    if (priceDirection === 'up') {
      desc += `up ${priceAbs.toFixed(2)}%`;
    } else if (priceDirection === 'down') {
      desc += `down ${priceAbs.toFixed(2)}%`;
    } else {
      desc += 'trading flat';
    }
    
    desc += ' with volume ';
    
    if (volumeDirection === 'increased') {
      desc += `up ${volumeAbs.toFixed(1)}%`;
    } else if (volumeDirection === 'decreased') {
      desc += `down ${volumeAbs.toFixed(1)}%`;
    } else {
      desc += 'stable';
    }
    
    if (market.dominance > 4) {
      desc += `, ${market.dominance.toFixed(1)}% market dominance shows strength`;
    }
    
    return desc;
  }
}

export const sentimentService = SentimentAnalysisService.getInstance();