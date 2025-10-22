/**
 * ChainGPT News Generator Service
 *
 * Fetches cryptocurrency news using ChainGPT AI News Generator API.
 * Implements daily caching to minimize API usage (1 credit per 10 news items).
 */

import axios from 'axios';
import { ChainGPTNewsCacheModel } from '@/database/models/ChainGPTNewsCache';
import logger from '@/utils/logger';

const log = logger.child({ module: 'chainGPT-news' });

/**
 * ChainGPT News API Response (direct array format)
 */
interface ChainGPTNewsResponse {
  statusCode: number;
  message: string;
  data: NewsArticle[];
}

/**
 * Individual News Article
 */
interface NewsArticle {
  id: number;
  title: string;
  description: string;
  categoryId?: number;
  subCategoryId?: number;
  tokenId?: number;
  url: string;
  imageUrl?: string;
  pubDate: string;
  author?: string;
  category?: {
    id: number;
    name: string;
  };
  subCategory?: {
    id: number;
    name: string;
  };
  token?: {
    id: number;
    name: string;
  };
}

/**
 * News Service Result
 */
export interface NewsResult {
  success: boolean;
  news?: NewsArticle[];
  fromCache?: boolean;
  error?: string;
}

class ChainGPTNewsService {
  private readonly apiKey: string | undefined;
  private readonly apiUrl = 'https://api.chaingpt.org/news';
  private readonly dailyNewsLimit = 5; // Fetch 5 news per day

  constructor() {
    this.apiKey = process.env.CHAINGPT_API_KEY;
  }

  /**
   * Check if ChainGPT News API is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Get today's news (from cache if available, otherwise fetch from API)
   */
  async getTodaysNews(): Promise<NewsResult> {
    if (!this.isAvailable()) {
      log.warn('ChainGPT API key not configured');
      return {
        success: false,
        error: 'ChainGPT API key not configured',
      };
    }

    try {
      // Check if we have today's news in cache
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of today

      const cachedNews = await ChainGPTNewsCacheModel.find({
        fetchDate: { $gte: today },
      })
        .sort({ pubDate: -1 })
        .limit(this.dailyNewsLimit)
        .lean();

      if (cachedNews.length >= this.dailyNewsLimit) {
        log.info(`Returning ${cachedNews.length} cached news articles from today`);

        // Update view counts
        await ChainGPTNewsCacheModel.updateMany(
          { _id: { $in: cachedNews.map((n) => n._id) } },
          {
            $inc: { viewCount: 1 },
            $set: { lastAccessedAt: new Date() },
          }
        );

        return {
          success: true,
          news: cachedNews.map(this.convertCachedToArticle),
          fromCache: true,
        };
      }

      // Fetch fresh news from API
      log.info('Fetching fresh news from ChainGPT API');
      const freshNews = await this.fetchNewsFromAPI();

      if (!freshNews.success || !freshNews.news) {
        return freshNews;
      }

      // Cache the news
      await this.cacheNews(freshNews.news);

      return {
        success: true,
        news: freshNews.news.slice(0, this.dailyNewsLimit),
        fromCache: false,
      };
    } catch (error) {
      log.error('Error getting today\'s news:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Fetch news from ChainGPT API
   */
  private async fetchNewsFromAPI(
    categoryId?: number,
    subCategoryId?: number,
    tokenId?: number,
    searchQuery?: string,
    limit: number = 5
  ): Promise<NewsResult> {
    try {
      log.info('Fetching news from ChainGPT API', {
        categoryId,
        subCategoryId,
        tokenId,
        searchQuery,
        limit,
      });

      const response = await axios.get<ChainGPTNewsResponse>(this.apiUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        params: {
          categoryId,
          subCategoryId,
          tokenId,
          searchQuery,
          limit,
          page: 1,
        },
      });

      // API returns { statusCode: 200, message: "Request Successful", data: [...] }
      if (response.data.statusCode === 200 && Array.isArray(response.data.data)) {
        log.info(`Fetched ${response.data.data.length} news articles`);
        return {
          success: true,
          news: response.data.data,
          fromCache: false,
        };
      } else {
        log.error('Unexpected API response format:', response.data);
        return {
          success: false,
          error: 'Unexpected API response format',
        };
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        log.error('ChainGPT News API error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        });

        if (error.response?.status === 401) {
          return {
            success: false,
            error: 'Invalid ChainGPT API key',
          };
        } else if (error.response?.status === 429) {
          return {
            success: false,
            error: 'Rate limit exceeded. Please try again later.',
          };
        }
      }

      log.error('Error fetching news from API:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Cache news articles in database
   */
  private async cacheNews(news: NewsArticle[]): Promise<void> {
    const now = new Date();
    const fetchDate = new Date();
    fetchDate.setHours(0, 0, 0, 0); // Start of today

    for (const article of news) {
      try {
        await ChainGPTNewsCacheModel.findOneAndUpdate(
          { newsId: article.id },
          {
            newsId: article.id,
            title: article.title,
            description: article.description,
            categoryId: article.categoryId,
            categoryName: article.category?.name,
            subCategoryId: article.subCategoryId,
            subCategoryName: article.subCategory?.name,
            tokenId: article.tokenId,
            tokenName: article.token?.name,
            url: article.url,
            imageUrl: article.imageUrl,
            pubDate: new Date(article.pubDate),
            source: article.author,
            fetchDate,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // 7 days
            viewCount: 0,
          },
          { upsert: true, new: true }
        );
      } catch (error) {
        log.error(`Error caching news article ${article.id}:`, error);
      }
    }

    log.info(`Cached ${news.length} news articles`);
  }

  /**
   * Convert cached news to NewsArticle format
   */
  private convertCachedToArticle(cached: any): NewsArticle {
    return {
      id: cached.newsId,
      title: cached.title,
      description: cached.description,
      categoryId: cached.categoryId,
      subCategoryId: cached.subCategoryId,
      tokenId: cached.tokenId,
      url: cached.url,
      imageUrl: cached.imageUrl,
      pubDate: cached.pubDate.toISOString(),
      author: cached.source,
      category: cached.categoryName ? {
        id: cached.categoryId,
        name: cached.categoryName,
      } : undefined,
      subCategory: cached.subCategoryName ? {
        id: cached.subCategoryId,
        name: cached.subCategoryName,
      } : undefined,
      token: cached.tokenName ? {
        id: cached.tokenId,
        name: cached.tokenName,
      } : undefined,
    };
  }

  /**
   * Format news articles for Telegram display
   */
  formatNewsForTelegram(news: NewsArticle[], fromCache: boolean = false): string {
    let message = '📰 Today\'s Crypto News\n\n';

    if (fromCache) {
      message += '(Cached - Updated daily)\n\n';
    }

    news.forEach((article, index) => {
      // Title as hyperlink
      message += `${index + 1}. [${article.title}](${article.url})\n`;

      if (article.category?.name) {
        message += `   ${article.category.name}`;
        if (article.subCategory?.name) {
          message += ` • ${article.subCategory.name}`;
        }
        message += '\n';
      }

      message += '\n';
    });

    message += '⚠️ News provided by ChainGPT AI News Generator';

    return message;
  }
}

// Export singleton instance
export const chainGPTNewsService = new ChainGPTNewsService();
