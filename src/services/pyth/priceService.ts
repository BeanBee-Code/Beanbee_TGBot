import { HermesClient } from '@pythnetwork/hermes-client';
import { createLogger } from '@/utils/logger';
import { getPythPriceId, hasPythPriceFeed, ADDRESS_TO_PRICE_ID_MAP } from '@/config/pythPriceIds';
import axios from 'axios';
import { getTokenInfo } from '@/services/wallet/tokenInfoCache';
import { ethers } from 'ethers';

const logger = createLogger('pyth.priceService');

// Use Pyth's free public endpoint by default
// For production, consider getting a private endpoint from RPC providers
const HERMES_ENDPOINT = process.env.PYTH_HERMES_ENDPOINT || 'https://hermes.pyth.network';

// Cache settings
const PRICE_CACHE_DURATION = 5 * 1000; // 5 seconds cache for Pyth prices
const MAX_CACHE_SIZE = 100; // Maximum number of cached prices

interface CachedPythPrice {
  price: number;
  timestamp: number;
  confidence?: number;
}

interface StreamingSubscription {
  priceIds: string[];
  eventSource: EventSource | null;
  callbacks: Map<string, (price: number) => void>;
}

export class PythPriceService {
  private client: HermesClient;
  private priceCache: Map<string, CachedPythPrice>;
  private streamingSubscription: StreamingSubscription | null = null;
  private isInitialized: boolean = false;
  private addressToPriceIdCache: Map<string, string>;
  private symbolToPriceIdCache: Map<string, string>;
  private provider: ethers.Provider;
  private lastPriceFeedsFetch: number = 0;
  private priceFeedsCache: any[] = [];

  constructor() {
    this.client = new HermesClient(HERMES_ENDPOINT, {});
    this.priceCache = new Map();
    // Initialize with hardcoded mappings as fallback
    this.addressToPriceIdCache = new Map(Object.entries(ADDRESS_TO_PRICE_ID_MAP));
    this.symbolToPriceIdCache = new Map();
    
    // Only create provider in non-test environments
    if (process.env.NODE_ENV !== 'test') {
      this.provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
      this.initializeService();
    } else {
      // In tests, use a mock provider and assume initialized
      this.provider = {} as any;
      this.isInitialized = true;
    }
  }

  private async initializeService(): Promise<void> {
    try {
      // Test connection to Hermes
      logger.info(`🔌 Connecting to Pyth Hermes at ${HERMES_ENDPOINT}`);
      // A simple test query to verify connectivity
      const testPriceIds = ['0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace']; // ETH/USD
      await this.client.getLatestPriceUpdates(testPriceIds);
      this.isInitialized = true;
      logger.info('✅ Pyth Hermes client initialized successfully');
      
      // Pre-fetch price feeds in background
      this.fetchAndCachePriceFeeds().catch(err => 
        logger.debug('Background price feeds fetch failed:', err)
      );
    } catch (error) {
      logger.error('❌ Failed to initialize Pyth Hermes client:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Fetch price by token address
   * @param tokenAddress BSC token contract address
   * @returns Price in USD or null if not available
   */
  public async fetchPriceByAddress(tokenAddress: string): Promise<number | null> {
    try {
      const normalizedAddress = tokenAddress.toLowerCase();
      
      // Check cache first
      const cached = this.priceCache.get(normalizedAddress);
      if (cached && Date.now() - cached.timestamp < PRICE_CACHE_DURATION) {
        logger.debug(`🎯 Pyth cache hit for ${tokenAddress}: $${cached.price}`);
        return cached.price;
      }

      // Try to get price ID dynamically
      let priceId = await this.getPriceIdForToken(normalizedAddress);
      
      if (!priceId) {
        logger.debug(`📊 No Pyth price feed found for token: ${tokenAddress}`);
        return null;
      }

      // If service is not initialized, try to initialize (skip in tests)
      if (!this.isInitialized && process.env.NODE_ENV !== 'test') {
        await this.initializeService();
        if (!this.isInitialized) {
          logger.debug('Pyth service not available, skipping');
          return null;
        }
      }

      // Fetch latest price from Pyth with error handling
      let priceUpdates;
      try {
        priceUpdates = await this.client.getLatestPriceUpdates([priceId]);
      } catch (apiError: any) {
        // Handle 404 errors specifically
        if (apiError.message?.includes('404') || apiError.message?.includes('not found')) {
          logger.debug(`Price ID ${priceId} not found on Pyth for ${tokenAddress}`);
          // Remove from cache to avoid repeated failures
          this.addressToPriceIdCache.delete(normalizedAddress);
        } else {
          logger.error(`Error calling Pyth API for ${tokenAddress}:`, apiError.message);
        }
        return null;
      }
      
      if (priceUpdates && priceUpdates.parsed && priceUpdates.parsed.length > 0) {
        const priceFeed = priceUpdates.parsed[0];
        
        if (priceFeed && priceFeed.price) {
          // Convert price with proper exponent handling
          const rawPrice = parseFloat(priceFeed.price.price);
          const exponent = priceFeed.price.expo;
          const finalPrice = rawPrice * Math.pow(10, exponent);
          
          // Validate price is reasonable
          if (finalPrice > 0 && finalPrice < 1e12) { // Max $1 trillion per token
            // Update cache
            this.priceCache.set(normalizedAddress, {
              price: finalPrice,
              timestamp: Date.now(),
              confidence: priceFeed.price.conf ? 
                parseFloat(priceFeed.price.conf) * Math.pow(10, exponent) : undefined
            });

            // Clean up cache if it's too large
            if (this.priceCache.size > MAX_CACHE_SIZE) {
              const oldestKey = this.priceCache.keys().next().value;
              if (oldestKey) this.priceCache.delete(oldestKey);
            }

            logger.info(`💹 Pyth price fetched for ${tokenAddress}: $${finalPrice.toFixed(6)}`);
            return finalPrice;
          } else {
            logger.warn(`⚠️ Invalid price from Pyth for ${tokenAddress}: ${finalPrice}`);
          }
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error fetching Pyth price for ${tokenAddress}:`, error);
      return null;
    }
  }

  /**
   * Fetch multiple prices in batch
   * @param tokenAddresses Array of BSC token addresses
   * @returns Map of token address to price
   */
  public async fetchMultiplePrices(tokenAddresses: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    
    try {
      // Get price IDs for all tokens dynamically
      const tokenPriceIdMap = new Map<string, string>();
      
      for (const address of tokenAddresses) {
        const normalizedAddr = address.toLowerCase();
        const priceId = await this.getPriceIdForToken(normalizedAddr);
        if (priceId) {
          tokenPriceIdMap.set(normalizedAddr, priceId);
        }
      }

      if (tokenPriceIdMap.size === 0) {
        return results;
      }

      const priceIds = Array.from(tokenPriceIdMap.values());

      if (priceIds.length === 0) {
        return results;
      }

      // Fetch all prices in one request
      const priceUpdates = await this.client.getLatestPriceUpdates(priceIds);

      if (priceUpdates && priceUpdates.parsed) {
        for (const [tokenAddress, priceId] of tokenPriceIdMap.entries()) {
          const priceFeed = priceUpdates.parsed.find(feed => feed.id === priceId);

          if (priceFeed && priceFeed.price) {
            const rawPrice = parseFloat(priceFeed.price.price);
            const exponent = priceFeed.price.expo;
            const finalPrice = rawPrice * Math.pow(10, exponent);

            if (finalPrice > 0 && finalPrice < 1e12) {
              results.set(tokenAddress, finalPrice);
              
              // Update cache
              this.priceCache.set(tokenAddress, {
                price: finalPrice,
                timestamp: Date.now()
              });
            }
          }
        }
      }

      logger.info(`📦 Batch fetched ${results.size} prices from Pyth`);
    } catch (error) {
      logger.error('Error batch fetching Pyth prices:', error);
    }

    return results;
  }

  /**
   * Start streaming price updates for specific tokens
   * @param tokenAddresses Tokens to monitor
   * @param onPriceUpdate Callback for price updates
   */
  public async startPriceStreaming(
    tokenAddresses: string[],
    onPriceUpdate: (tokenAddress: string, price: number) => void
  ): Promise<void> {
    try {
      // Stop existing stream if any
      if (this.streamingSubscription?.eventSource) {
        this.stopPriceStreaming();
      }

      // Get price IDs for tokens dynamically
      const priceIdMap = new Map<string, string>();
      for (const address of tokenAddresses) {
        const normalizedAddr = address.toLowerCase();
        const priceId = await this.getPriceIdForToken(normalizedAddr);
        if (priceId) {
          priceIdMap.set(priceId, normalizedAddr);
        }
      }

      if (priceIdMap.size === 0) {
        logger.warn('No valid Pyth price feeds found for streaming');
        return;
      }

      const priceIds = Array.from(priceIdMap.keys());
      logger.info(`🔄 Starting price streaming for ${priceIds.length} tokens`);

      // Create streaming connection
      const eventSource = await this.client.getPriceUpdatesStream(priceIds, {
        encoding: 'hex',
        parsed: true,
        allowUnordered: true,
        benchmarksOnly: false
      });

      // Set up event handlers
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.parsed && Array.isArray(data.parsed)) {
            for (const priceFeed of data.parsed) {
              const tokenAddress = priceIdMap.get(priceFeed.id);
              if (tokenAddress && priceFeed.price) {
                const rawPrice = parseFloat(priceFeed.price.price);
                const exponent = priceFeed.price.expo;
                const finalPrice = rawPrice * Math.pow(10, exponent);

                if (finalPrice > 0 && finalPrice < 1e12) {
                  // Update cache
                  this.priceCache.set(tokenAddress, {
                    price: finalPrice,
                    timestamp: Date.now()
                  });

                  // Trigger callback
                  onPriceUpdate(tokenAddress, finalPrice);
                }
              }
            }
          }
        } catch (error) {
          logger.error('Error processing streaming price update:', error);
        }
      };

      eventSource.onerror = (error) => {
        logger.error('Streaming connection error:', error);
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (this.streamingSubscription) {
            this.startPriceStreaming(tokenAddresses, onPriceUpdate);
          }
        }, 5000);
      };

      // Store subscription info
      this.streamingSubscription = {
        priceIds,
        eventSource,
        callbacks: new Map()
      };

    } catch (error) {
      logger.error('Failed to start price streaming:', error);
    }
  }

  /**
   * Stop streaming price updates
   */
  public stopPriceStreaming(): void {
    if (this.streamingSubscription?.eventSource) {
      logger.info('🛑 Stopping price streaming');
      this.streamingSubscription.eventSource.close();
      this.streamingSubscription = null;
    }
  }

  /**
   * Dynamically lookup Price ID for a token
   * @param tokenAddress BSC token contract address
   * @returns Price ID or null
   */
  private async getPriceIdForToken(tokenAddress: string): Promise<string | null> {
    const normalizedAddress = tokenAddress.toLowerCase();
    
    // Check cache first
    if (this.addressToPriceIdCache.has(normalizedAddress)) {
      return this.addressToPriceIdCache.get(normalizedAddress)!;
    }

    // In test mode, don't do dynamic lookup for unknown tokens
    if (process.env.NODE_ENV === 'test') {
      return null;
    }

    try {
      // Get token symbol
      const tokenInfo = await getTokenInfo(tokenAddress, this.provider);
      if (!tokenInfo) {
        logger.debug(`Could not get token info for ${tokenAddress}`);
        return null;
      }

      const symbol = tokenInfo.symbol.toUpperCase();
      
      // Check symbol cache
      if (this.symbolToPriceIdCache.has(symbol)) {
        const priceId = this.symbolToPriceIdCache.get(symbol)!;
        this.addressToPriceIdCache.set(normalizedAddress, priceId);
        return priceId;
      }

      // Search in price feeds
      const priceId = await this.searchPriceIdBySymbol(symbol);
      if (priceId) {
        // Cache the result
        this.addressToPriceIdCache.set(normalizedAddress, priceId);
        this.symbolToPriceIdCache.set(symbol, priceId);
        logger.info(`🔍 Dynamically found Pyth price ID for ${symbol}: ${priceId}`);
        return priceId;
      }

      return null;
    } catch (error) {
      logger.debug(`Error looking up price ID for ${tokenAddress}:`, error);
      return null;
    }
  }

  /**
   * Fetch and cache available price feeds from Pyth
   */
  private async fetchAndCachePriceFeeds(): Promise<void> {
    try {
      // Only fetch if cache is old (1 hour)
      if (Date.now() - this.lastPriceFeedsFetch < 60 * 60 * 1000) {
        return;
      }

      logger.debug('Fetching available price feeds from Pyth...');
      
      // Use the Hermes API to get price feeds
      const response = await axios.get(`${HERMES_ENDPOINT}/api/price_feeds`, {
        params: {
          asset_type: 'crypto'
        },
        timeout: 5000
      });

      if (response.data && Array.isArray(response.data)) {
        this.priceFeedsCache = response.data;
        this.lastPriceFeedsFetch = Date.now();
        
        // Pre-populate symbol cache for common tokens
        for (const feed of response.data) {
          if (feed.attributes?.symbol) {
            const symbol = feed.attributes.symbol.toUpperCase();
            // Remove /USD suffix if present
            const baseSymbol = symbol.replace(/\/USD.*$/, '');
            this.symbolToPriceIdCache.set(baseSymbol, feed.id);
          }
        }
        
        logger.info(`📋 Cached ${response.data.length} Pyth price feeds`);
      }
    } catch (error) {
      logger.debug('Failed to fetch price feeds:', error);
    }
  }

  /**
   * Search for a price ID by symbol
   * @param symbol Token symbol (e.g., 'BNB', 'ETH')
   * @returns Price ID or null
   */
  private async searchPriceIdBySymbol(symbol: string): Promise<string | null> {
    try {
      // Ensure we have price feeds cached
      await this.fetchAndCachePriceFeeds();
      
      // Common symbol mappings for BSC tokens
      const symbolMappings: Record<string, string[]> = {
        'WBNB': ['BNB'],
        'BTCB': ['BTC'],
        'ETH': ['ETH'],
        'WETH': ['ETH'],
        'BUSD': ['BUSD'],
        'USDT': ['USDT'],
        'USDC': ['USDC'],
        'CAKE': ['CAKE'],
      };

      // Check if we have a mapping
      const searchSymbols = [symbol];
      if (symbolMappings[symbol]) {
        searchSymbols.push(...symbolMappings[symbol]);
      }

      // Search in cached feeds
      for (const searchSymbol of searchSymbols) {
        // Direct symbol match in cache
        if (this.symbolToPriceIdCache.has(searchSymbol)) {
          return this.symbolToPriceIdCache.get(searchSymbol)!;
        }

        // Search in price feeds
        for (const feed of this.priceFeedsCache) {
          if (feed.attributes?.symbol) {
            const feedSymbol = feed.attributes.symbol.toUpperCase();
            // Match patterns like 'BNB/USD', 'Crypto.BNB/USD'
            if (feedSymbol === searchSymbol ||
                feedSymbol === `${searchSymbol}/USD` ||
                feedSymbol === `Crypto.${searchSymbol}/USD` ||
                feedSymbol.endsWith(`.${searchSymbol}/USD`)) {
              return feed.id;
            }
          }
        }
      }

      // If not found in cache, try API search
      const response = await axios.get(`${HERMES_ENDPOINT}/api/price_feeds`, {
        params: {
          query: symbol,
          asset_type: 'crypto'
        },
        timeout: 5000
      });

      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        // Return the first matching result
        const feed = response.data[0];
        if (feed.id) {
          logger.debug(`Found price feed via API search: ${symbol} -> ${feed.id}`);
          return feed.id;
        }
      }

      return null;
    } catch (error) {
      logger.debug(`Error searching for price ID by symbol ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Clear the price cache
   */
  public clearCache(): void {
    this.priceCache.clear();
    logger.debug('Price cache cleared');
  }

  /**
   * Clear all caches including price ID mappings
   */
  public clearAllCaches(): void {
    this.priceCache.clear();
    // Don't clear hardcoded mappings, only dynamic ones
    const hardcodedEntries = Object.entries(ADDRESS_TO_PRICE_ID_MAP);
    this.addressToPriceIdCache.clear();
    for (const [addr, id] of hardcodedEntries) {
      this.addressToPriceIdCache.set(addr, id);
    }
    this.symbolToPriceIdCache.clear();
    this.priceFeedsCache = [];
    this.lastPriceFeedsFetch = 0;
    logger.debug('All caches cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.priceCache.size,
      maxSize: MAX_CACHE_SIZE
    };
  }
}

// Export singleton instance
export const pythPriceService = new PythPriceService();