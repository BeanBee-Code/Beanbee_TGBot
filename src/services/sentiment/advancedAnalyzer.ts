import { createLogger } from '@/utils/logger';
import axios from 'axios';
import natural from 'natural';
import Sentiment from 'sentiment';

const log = createLogger('advanced-sentiment');

export interface AdvancedSentimentScore {
  score: number; // -1 to 1
  magnitude: number; // 0 to 1 (confidence/intensity)
  label: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';
  sources: {
    text: string;
    score: number;
    weight: number;
  }[];
}

export class AdvancedSentimentAnalyzer {
  private sentiment: Sentiment;
  private tokenizer: any;
  
  // Financial and crypto-specific terms with sentiment weights
  private readonly financialLexicon: Record<string, number> = {
    // Positive terms
    'bullish': 3, 'moon': 3, 'pump': 2, 'rally': 2, 'surge': 2,
    'breakthrough': 3, 'adoption': 2, 'partnership': 2, 'upgrade': 2,
    'ath': 3, 'all-time-high': 3, 'breakout': 2, 'accumulation': 1,
    'support': 1, 'resistance-break': 2, 'golden-cross': 3,
    'institutional': 2, 'whale-buying': 2, 'defi-growth': 2,
    
    // Negative terms
    'bearish': -3, 'crash': -3, 'dump': -3, 'plunge': -3, 'collapse': -3,
    'rug': -4, 'scam': -4, 'hack': -4, 'exploit': -4, 'lawsuit': -3,
    'sec': -2, 'regulation': -2, 'ban': -3, 'delist': -3,
    'death-cross': -3, 'resistance': -1, 'whale-selling': -2,
    'fud': -2, 'fear': -2, 'panic': -3, 'liquidation': -2,
    
    // BSC/BNB specific
    'binance': 1, 'bnb': 1, 'bsc': 1, 'cake': 1, 'pancakeswap': 1,
    'cz': 1, 'changpeng': 1, 'venus': 1, 'autofarm': 1
  };

  constructor() {
    this.sentiment = new Sentiment();
    this.tokenizer = new natural.WordTokenizer();
    
    // Extend sentiment with crypto-specific terms
    Object.entries(this.financialLexicon).forEach(([word, score]) => {
      this.sentiment.registerLanguage('en', {
        labels: { [word]: score }
      });
    });
  }

  /**
   * Analyzes sentiment from multiple text sources with advanced NLP
   */
  async analyzeMultipleSources(sources: { text: string; weight: number }[]): Promise<AdvancedSentimentScore> {
    log.info('Analyzing multiple text sources', { 
      sourceCount: sources.length,
      totalWeight: sources.reduce((sum, s) => sum + s.weight, 0)
    });
    
    const analyzedSources = await Promise.all(
      sources.map(async source => ({
        ...source,
        sentiment: await this.analyzeText(source.text)
      }))
    );

    // Calculate weighted average
    let totalScore = 0;
    let totalWeight = 0;
    let totalMagnitude = 0;

    analyzedSources.forEach(source => {
      totalScore += source.sentiment.comparative * source.weight;
      totalWeight += source.weight;
      totalMagnitude += Math.abs(source.sentiment.score) * source.weight;
    });

    const averageScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const averageMagnitude = totalWeight > 0 ? totalMagnitude / totalWeight : 0;

    return {
      score: this.normalizeScore(averageScore),
      magnitude: Math.min(1, averageMagnitude / 10), // Normalize magnitude to 0-1
      label: this.getLabel(averageScore),
      sources: analyzedSources.map(s => ({
        text: s.text.substring(0, 100) + '...',
        score: this.normalizeScore(s.sentiment.comparative),
        weight: s.weight
      }))
    };
  }

  /**
   * Analyzes a single text using sentiment analysis
   */
  private async analyzeText(text: string): Promise<any> {
    // Pre-process text
    const processedText = this.preprocessText(text);
    
    // Basic sentiment analysis
    const sentimentResult = this.sentiment.analyze(processedText);
    
    // Enhance with context analysis
    const contextScore = this.analyzeContext(processedText);
    
    // Combine scores
    const combinedScore = (sentimentResult.comparative + contextScore) / 2;
    
    return {
      score: sentimentResult.score,
      comparative: combinedScore,
      tokens: sentimentResult.tokens,
      positive: sentimentResult.positive,
      negative: sentimentResult.negative
    };
  }

  /**
   * Preprocesses text for better analysis
   */
  private preprocessText(text: string): string {
    // Convert to lowercase
    let processed = text.toLowerCase();
    
    // Remove URLs
    processed = processed.replace(/https?:\/\/[^\s]+/g, '');
    
    // Remove mentions and hashtags but keep the word
    processed = processed.replace(/@(\w+)/g, '$1');
    processed = processed.replace(/#(\w+)/g, '$1');
    
    // Expand common crypto abbreviations
    processed = processed.replace(/\bbtc\b/g, 'bitcoin');
    processed = processed.replace(/\beth\b/g, 'ethereum');
    processed = processed.replace(/\bdefi\b/g, 'decentralized finance');
    
    return processed;
  }

  /**
   * Analyzes context for crypto-specific patterns
   */
  private analyzeContext(text: string): number {
    let contextScore = 0;
    const tokens = this.tokenizer.tokenize(text.toLowerCase());
    
    // Check for technical analysis patterns
    if (this.containsTechnicalAnalysis(tokens)) {
      contextScore += 0.1; // Slight positive bias for technical content
    }
    
    // Check for FUD patterns
    if (this.containsFUDPattern(tokens)) {
      contextScore -= 0.3;
    }
    
    // Check for shill patterns
    if (this.containsShillPattern(tokens)) {
      contextScore -= 0.2; // Reduce score for obvious shilling
    }
    
    // Check for news credibility
    if (this.isCredibleSource(text)) {
      contextScore += 0.2;
    }
    
    return contextScore;
  }

  /**
   * Detects technical analysis mentions
   */
  private containsTechnicalAnalysis(tokens: string[]): boolean {
    const taTerms = ['support', 'resistance', 'breakout', 'pattern', 'chart', 
                     'indicator', 'rsi', 'macd', 'volume', 'trend'];
    return tokens.some(token => taTerms.includes(token));
  }

  /**
   * Detects FUD (Fear, Uncertainty, Doubt) patterns
   */
  private containsFUDPattern(tokens: string[]): boolean {
    const fudPatterns = ['going to zero', 'ponzi', 'exit scam', 'rug pull', 
                         'dead project', 'scam warning'];
    const text = tokens.join(' ');
    return fudPatterns.some(pattern => text.includes(pattern));
  }

  /**
   * Detects obvious shilling patterns
   */
  private containsShillPattern(tokens: string[]): boolean {
    const shillPatterns = ['100x', '1000x', 'guaranteed profit', 'cant lose',
                          'mortgage house', 'life savings', 'get rich quick'];
    const text = tokens.join(' ');
    return shillPatterns.some(pattern => text.includes(pattern));
  }

  /**
   * Checks if source appears credible
   */
  private isCredibleSource(text: string): boolean {
    const credibleSources = ['reuters', 'bloomberg', 'coindesk', 'cointelegraph',
                            'binance official', 'official announcement'];
    return credibleSources.some(source => text.toLowerCase().includes(source));
  }

  /**
   * Normalizes score to -1 to 1 range
   */
  private normalizeScore(score: number): number {
    // Sentiment scores can be outside -1 to 1, normalize them
    return Math.max(-1, Math.min(1, score));
  }

  /**
   * Gets sentiment label from score
   */
  private getLabel(score: number): 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive' {
    if (score <= -0.6) return 'very_negative';
    if (score <= -0.2) return 'negative';
    if (score <= 0.2) return 'neutral';
    if (score <= 0.6) return 'positive';
    return 'very_positive';
  }

  /**
   * Analyzes social media sentiment (Twitter, Reddit, etc.)
   */
  async analyzeSocialSentiment(platform: 'twitter' | 'reddit', query: string): Promise<AdvancedSentimentScore> {
    try {
      // For production, you would integrate with actual APIs
      // For now, we'll simulate with enhanced analysis
      const mockSocialData = await this.fetchMockSocialData(platform, query);
      
      const sources = mockSocialData.map(post => ({
        text: post.text,
        weight: this.calculatePostWeight(post)
      }));
      
      return this.analyzeMultipleSources(sources);
    } catch (error) {
      log.error(`Error analyzing ${platform} sentiment:`, {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error,
        platform,
        query
      });
      throw error;
    }
  }

  /**
   * Calculates weight for a social media post based on engagement
   */
  private calculatePostWeight(post: any): number {
    const { likes = 0, retweets = 0, comments = 0, followers = 0 } = post;
    
    // Engagement score
    const engagement = likes + (retweets * 2) + (comments * 1.5);
    
    // Follower influence (logarithmic scale)
    const influence = Math.log10(Math.max(1, followers)) / 6; // Normalize to 0-1
    
    // Time decay (recent posts weighted higher)
    const hoursAgo = (Date.now() - new Date(post.created_at).getTime()) / (1000 * 60 * 60);
    const recency = Math.max(0, 1 - (hoursAgo / 168)); // Decay over a week
    
    // Combine factors
    return (engagement / 1000) * influence * recency;
  }

  /**
   * Mock social data fetcher (replace with actual API calls)
   */
  private async fetchMockSocialData(platform: string, query: string): Promise<any[]> {
    // In production, this would call Twitter API, Reddit API, etc.
    // For now, return mock data
    return [
      {
        text: "BNB showing strong support at $600, bullish momentum building! 🚀",
        likes: 245,
        retweets: 67,
        comments: 23,
        followers: 15000,
        created_at: new Date()
      },
      {
        text: "Binance Smart Chain TVL growing steadily, DeFi adoption increasing",
        likes: 189,
        retweets: 45,
        comments: 12,
        followers: 8500,
        created_at: new Date(Date.now() - 3600000)
      }
    ];
  }
}

export const advancedSentimentAnalyzer = new AdvancedSentimentAnalyzer();