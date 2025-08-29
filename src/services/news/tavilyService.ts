import { tavily } from '@tavily/core';
import { NewsCacheModel } from '@/database/models/NewsCache';
import { geminiAI } from '@/services/ai/geminiService';
import logger from '@/utils/logger';
import { format } from 'date-fns';

const log = logger.child({ module: 'tavilyService' });

export class TavilyNewsService {
  private client: any;

  constructor() {
    const apiKey = process.env.TAVILY_API_KEY;
    if (apiKey) {
      this.client = tavily({ apiKey });
    }
  }

  async getDailyCryptoNews(): Promise<string> {
    try {
      // Check if we already have news for today
      const today = format(new Date(), 'yyyy-MM-dd');
      const cached = await NewsCacheModel.findOne({ date: today });
      
      if (cached && cached.isProcessed) {
        log.info('Using cached news summary');
        return cached.summary;
      }

      // If no API key, return empty summary
      if (!this.client) {
        log.warn('Tavily API key not configured');
        return '';
      }

      // Fetch fresh crypto news
      log.info('Fetching fresh crypto news from Tavily');
      const searchResult = await this.client.search(
        'BSC Binance Smart Chain news DeFi yield farming opportunities new tokens PancakeSwap today',
        {
          maxResults: 10,
          searchDepth: 'basic',
          includeAnswer: true,
          includeRawContent: false,
          includeImages: false,
          days: 1
        }
      );

      if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
        log.warn('No news results from Tavily');
        return '';
      }

      // Prepare news data for AI summarization
      const newsItems = searchResult.results.map((item: any) => ({
        title: item.title,
        content: item.content,
        url: item.url
      }));

      const newsContext = newsItems
        .map((item: any) => `${item.title}\n${item.content}`)
        .join('\n\n---\n\n');

      // Generate AI summary
      const prompt = `Summarize the following BSC and DeFi news into a concise, actionable summary for BSC traders. Focus on:
1. New BSC tokens and project launches
2. High-yield opportunities on PancakeSwap and other BSC DeFi protocols
3. BSC ecosystem updates and chain developments
4. Security alerts or rug pull warnings on BSC
5. Notable yield farming or staking opportunities

Format with clear bullet points, highlight specific APY percentages when mentioned, and include token names. Keep it under 150 words and make it actionable for BSC traders.

News Articles:
${newsContext}`;

      const summary = await geminiAI.processMessage(prompt, prompt, 'news-summary');

      // Cache the result
      await NewsCacheModel.findOneAndUpdate(
        { date: today },
        {
          date: today,
          summary,
          topics: searchResult.results.map((r: any) => r.title),
          rawData: JSON.stringify(searchResult),
          isProcessed: true
        },
        { upsert: true, new: true }
      );

      log.info('Successfully generated and cached news summary');
      return summary;

    } catch (error: any) {
      log.error(`Error fetching crypto news: ${error.message || 'Unknown error'}`);
      return '';
    }
  }

  async getNewsFormatted(): Promise<string> {
    const newsSummary = await this.getDailyCryptoNews();
    if (!newsSummary) return '';

    // Clean up markdown formatting issues more aggressively
    const cleanedSummary = newsSummary
      // First, escape all asterisks to prevent markdown issues
      .replace(/\*/g, '')
      // Convert bullet points to proper format
      .replace(/^[-•]\s*/gm, '• ')
      // Remove any remaining problematic characters
      .replace(/[_\[\]()~`>#+=|{}]/g, '')
      // Ensure proper spacing
      .trim();

    return `\n\n📰 Market News & Updates\n\n${cleanedSummary}`;
  }
}

export const tavilyNewsService = new TavilyNewsService();