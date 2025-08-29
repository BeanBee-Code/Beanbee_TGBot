import { createLogger } from '../../utils/logger';

const logger = createLogger('dexscreener');

// DexScreener API types
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd?: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ label: string; url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
}

export interface DexScreenerSearchResponse {
  pairs: DexScreenerPair[];
}

export interface DexScreenerTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
  logoURI?: string;
  priceUsd?: number;
  priceChange24h?: number;
  volume24h?: number;
  liquidity?: number;
  marketCap?: number;
  pairAddress?: string;
  dexId?: string;
}

export class DexScreenerService {
  private readonly baseUrl = 'https://api.dexscreener.com/latest/dex';
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly cacheExpiry = 60 * 1000; // 1 minute cache

  /**
   * Search BSC tokens by keyword
   */
  async searchBscTokens(query: string, limit = 20): Promise<DexScreenerTokenInfo[]> {
    const cacheKey = `search_${query.toLowerCase()}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      logger.info(`Searching BSC tokens for query: ${query}`);
      
      // DexScreener search endpoint
      const searchUrl = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl);
      
      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status}`);
      }

      const data: DexScreenerSearchResponse = await response.json();
      
      // Filter only BSC pairs (chainId: "bsc")
      const bscPairs = data.pairs.filter(pair => pair.chainId === 'bsc');
      
      // Convert pairs to token info format and remove duplicates
      const tokenMap = new Map<string, DexScreenerTokenInfo>();
      
      for (const pair of bscPairs) {
        // Add base token
        const baseToken = pair.baseToken;
        if (!tokenMap.has(baseToken.address.toLowerCase())) {
          tokenMap.set(baseToken.address.toLowerCase(), {
            address: baseToken.address,
            name: baseToken.name,
            symbol: baseToken.symbol,
            priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
            priceChange24h: pair.priceChange?.h24,
            volume24h: pair.volume?.h24,
            liquidity: pair.liquidity?.usd,
            marketCap: pair.fdv,
            logoURI: pair.info?.imageUrl,
            pairAddress: pair.pairAddress,
            dexId: pair.dexId
          });
        }
      }

      // Sort by relevance and liquidity
      const results = Array.from(tokenMap.values())
        .sort((a, b) => {
          // Calculate relevance score
          const scoreA = this.calculateRelevanceScore(a, query);
          const scoreB = this.calculateRelevanceScore(b, query);
          
          // If relevance is similar, sort by liquidity
          if (Math.abs(scoreA - scoreB) < 10) {
            return (b.liquidity || 0) - (a.liquidity || 0);
          }
          
          return scoreB - scoreA;
        })
        .slice(0, limit);

      this.setCache(cacheKey, results);
      return results;

    } catch (error) {
      logger.error('DexScreener search error', {
        query,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get token details by address
   */
  async getTokenDetailsByAddress(address: string): Promise<DexScreenerTokenInfo | null> {
    const cacheKey = `token_${address.toLowerCase()}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Get token pairs from DexScreener
      const url = `${this.baseUrl}/tokens/${address}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        return null;
      }

      const data: DexScreenerSearchResponse = await response.json();
      
      // Find BSC pair with highest liquidity
      const bscPairs = data.pairs
        .filter(pair => pair.chainId === 'bsc')
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

      if (bscPairs.length === 0) {
        return null;
      }

      const bestPair = bscPairs[0];
      const token = bestPair.baseToken.address.toLowerCase() === address.toLowerCase() 
        ? bestPair.baseToken 
        : bestPair.quoteToken;

      const tokenInfo: DexScreenerTokenInfo = {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        priceUsd: bestPair.priceUsd ? parseFloat(bestPair.priceUsd) : undefined,
        priceChange24h: bestPair.priceChange?.h24,
        volume24h: bestPair.volume?.h24,
        liquidity: bestPair.liquidity?.usd,
        marketCap: bestPair.fdv,
        logoURI: bestPair.info?.imageUrl,
        pairAddress: bestPair.pairAddress,
        dexId: bestPair.dexId
      };

      this.setCache(cacheKey, tokenInfo);
      return tokenInfo;

    } catch (error) {
      logger.error('DexScreener token detail error', {
        address,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Get popular BSC tokens
   */
  async getPopularBscTokens(): Promise<DexScreenerTokenInfo[]> {
    const cacheKey = 'popular_bsc_tokens';
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Get trending tokens on BSC
      const url = `${this.baseUrl}/tokens/bsc`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status}`);
      }

      const data: DexScreenerSearchResponse = await response.json();
      
      // Convert to token info format
      const tokenMap = new Map<string, DexScreenerTokenInfo>();
      
      for (const pair of data.pairs.slice(0, 50)) {
        const baseToken = pair.baseToken;
        const key = baseToken.address.toLowerCase();
        
        if (!tokenMap.has(key) || (pair.liquidity?.usd || 0) > (tokenMap.get(key)?.liquidity || 0)) {
          tokenMap.set(key, {
            address: baseToken.address,
            name: baseToken.name,
            symbol: baseToken.symbol,
            priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
            priceChange24h: pair.priceChange?.h24,
            volume24h: pair.volume?.h24,
            liquidity: pair.liquidity?.usd,
            marketCap: pair.fdv,
            logoURI: pair.info?.imageUrl,
            pairAddress: pair.pairAddress,
            dexId: pair.dexId
          });
        }
      }

      const results = Array.from(tokenMap.values())
        .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))
        .slice(0, 20);

      this.setCache(cacheKey, results, 5 * 60 * 1000); // Cache for 5 minutes
      return results;

    } catch (error) {
      logger.error('Failed to get popular BSC tokens', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Calculate relevance score for search results
   */
  private calculateRelevanceScore(token: DexScreenerTokenInfo, query: string): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    const symbolLower = token.symbol.toLowerCase();
    const nameLower = token.name.toLowerCase();

    // Exact match
    if (symbolLower === queryLower) score += 1000;
    if (nameLower === queryLower) score += 900;

    // Starts with query
    if (symbolLower.startsWith(queryLower)) score += 500;
    if (nameLower.startsWith(queryLower)) score += 400;

    // Contains query
    if (symbolLower.includes(queryLower)) score += 200;
    if (nameLower.includes(queryLower)) score += 100;

    // Liquidity bonus
    if (token.liquidity) {
      if (token.liquidity > 1000000) score += 300;
      else if (token.liquidity > 100000) score += 200;
      else if (token.liquidity > 10000) score += 100;
    }

    // Volume bonus
    if (token.volume24h) {
      if (token.volume24h > 1000000) score += 200;
      else if (token.volume24h > 100000) score += 100;
      else if (token.volume24h > 10000) score += 50;
    }

    return score;
  }

  /**
   * Cache management
   */
  private getFromCache(key: string): any {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.cacheExpiry) {
      return item.data;
    }
    this.cache.delete(key);
    return null;
  }

  private setCache(key: string, data: any, _customExpiry?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Clean old cache entries
    if (this.cache.size > 100) {
      const sorted = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      for (let i = 0; i < 20; i++) {
        this.cache.delete(sorted[i][0]);
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}