import { TokenPriceModel } from '@/database/models/TokenPrice';
import Moralis from 'moralis';
import { createLogger } from '@/utils/logger';
import { pythPriceService } from '@/services/pyth/priceService';

const logger = createLogger('wallet.tokenPriceCache');

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const PRICE_UPDATE_THRESHOLD = 60 * 60 * 1000; // 1 hour - update price if older than this

interface CachedPrice {
  price: number;
  timestamp: number;
}

// In-memory cache for quick access
const memoryCache = new Map<string, CachedPrice>();

export async function getCachedTokenPrice(tokenAddress: string, chainId: string = '0x38'): Promise<number | null> {
  const cacheKey = `${chainId}_${tokenAddress.toLowerCase()}`;
  
  // Check memory cache first
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached && Date.now() - memoryCached.timestamp < PRICE_UPDATE_THRESHOLD) {
    logger.info(`🚀 Found in memory cache: ${tokenAddress} = $${memoryCached.price}`);
    return memoryCached.price > 0 ? memoryCached.price : null;
  }

  try {
    // Try Pyth first for real-time prices
    const pythPrice = await pythPriceService.fetchPriceByAddress(tokenAddress);
    if (pythPrice !== null && pythPrice > 0) {
      logger.info(`🎯 Got real-time Pyth price for ${tokenAddress}: $${pythPrice}`);
      // Update caches with Pyth price
      await updateTokenPriceCache(tokenAddress, chainId, pythPrice, { priceSource: 'pyth' });
      return pythPrice;
    }
    logger.debug(`📊 No Pyth price for ${tokenAddress}, falling back to Moralis/cache`);
    // Check MongoDB cache
    logger.debug(`🔍 Checking MongoDB cache for ${tokenAddress}`);
    const dbCache = await TokenPriceModel.findOne({
      tokenAddress: tokenAddress.toLowerCase(),
      chainId
    });

    if (dbCache) {
      logger.info(`📚 Found in MongoDB: ${tokenAddress} = $${dbCache.price}, age: ${Math.round((Date.now() - dbCache.lastUpdated.getTime()) / 1000 / 60)} minutes`);
      
      if (Date.now() - dbCache.lastUpdated.getTime() < CACHE_DURATION) {
        // Update memory cache
        memoryCache.set(cacheKey, {
          price: dbCache.price,
          timestamp: dbCache.lastUpdated.getTime()
        });
        
        // If price is reasonably fresh, return it
        if (Date.now() - dbCache.lastUpdated.getTime() < PRICE_UPDATE_THRESHOLD) {
          return dbCache.price > 0 ? dbCache.price : null;
        }
      }
    } else {
      logger.debug(`❌ Not found in MongoDB cache: ${tokenAddress}`);
    }

    // Fetch fresh price from Moralis
    const freshPrice = await fetchTokenPriceFromMoralis(tokenAddress);
    
    if (freshPrice !== null && freshPrice > 0) {
      // Update both caches with valid price
      logger.info(`💾 Saving price to cache for ${tokenAddress}: $${freshPrice}`);
      await updateTokenPriceCache(tokenAddress, chainId, freshPrice);
      return freshPrice;
    } else {
      // Save tokens with no price to avoid repeated lookups
      logger.debug(`💾 Saving no-price marker to cache for ${tokenAddress}`);
      await updateTokenPriceCache(tokenAddress, chainId, 0);
    }

    // If we couldn't get a fresh price but have an old cached price, return it
    if (dbCache && dbCache.price > 0) {
      logger.info(`📦 Returning old cached price for ${tokenAddress}: $${dbCache.price}`);
      return dbCache.price;
    }

    return null;
  } catch (error) {
    logger.error(`Error getting cached price for ${tokenAddress}:`, error);
    return null;
  }
}

async function fetchTokenPriceFromMoralis(tokenAddress: string): Promise<number | null> {
  try {
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: "0x38",
      address: tokenAddress
    });
    
    const data = response.toJSON();
    
    // Check if we have a valid USD price
    if (data.usdPrice && data.usdPrice > 0) {
      return data.usdPrice;
    }
    
    // If no USD price, try to get native price and convert
    if (data.nativePrice && data.nativePrice.value && data.nativePrice.decimals !== undefined) {
      const bnbPrice = await getBNBPrice();
      const priceInBNB = parseFloat(data.nativePrice.value) / Math.pow(10, data.nativePrice.decimals);
      const usdPrice = priceInBNB * bnbPrice;
      if (usdPrice > 0) {
        return usdPrice;
      }
    }
  } catch (error) {
    logger.debug(`No price found for token ${tokenAddress}`);
  }

  return null;
}

async function updateTokenPriceCache(
  tokenAddress: string, 
  chainId: string, 
  price: number,
  options?: { 
    priceSource?: string;
    tokenInfo?: { symbol?: string; name?: string; decimals?: number } 
  }
): Promise<void> {
  const cacheKey = `${chainId}_${tokenAddress.toLowerCase()}`;
  
  // Update memory cache
  memoryCache.set(cacheKey, {
    price,
    timestamp: Date.now()
  });
  logger.debug(`💾 Updated memory cache for ${tokenAddress}: $${price}`);

  // Update database cache
  try {
    const result = await TokenPriceModel.findOneAndUpdate(
      {
        tokenAddress: tokenAddress.toLowerCase(),
        chainId
      },
      {
        price,
        lastUpdated: new Date(),
        priceSource: options?.priceSource || 'moralis',
        ...(options?.tokenInfo && {
          symbol: options.tokenInfo.symbol,
          name: options.tokenInfo.name,
          decimals: options.tokenInfo.decimals
        })
      },
      {
        upsert: true,
        new: true
      }
    );
    logger.debug(`✅ MongoDB cache updated for ${tokenAddress}: ${result ? 'success' : 'failed'}`);
  } catch (error) {
    logger.error(`❌ Failed to update token price cache for ${tokenAddress}:`, error);
  }
}

// Get BNB price with caching
let bnbPriceCache: { price: number; timestamp: number } | null = null;

export async function getBNBPrice(): Promise<number> {
  // Check if we have a recent cached BNB price (5 minutes)
  if (bnbPriceCache && Date.now() - bnbPriceCache.timestamp < 5 * 60 * 1000) {
    return bnbPriceCache.price;
  }

  try {
    // WBNB address on BSC
    const wbnbAddress = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    
    // Try Pyth first
    const pythPrice = await pythPriceService.fetchPriceByAddress(wbnbAddress);
    if (pythPrice !== null && pythPrice > 0) {
      logger.info(`🎯 Got real-time Pyth price for WBNB: $${pythPrice}`);
      // Update cache
      bnbPriceCache = { price: pythPrice, timestamp: Date.now() };
      return pythPrice;
    }
    
    // Fallback to Moralis
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: "0x38",
      address: wbnbAddress
    });
    const data = response.toJSON();
    const price = data.usdPrice || 0;
    
    // Update cache
    bnbPriceCache = { price, timestamp: Date.now() };
    
    return price;
  } catch (error) {
    logger.error('Failed to fetch BNB price:', error);
    // Return cached price if available
    return bnbPriceCache?.price || 0;
  }
}

// Batch update token prices (for initial cache population)
export async function batchUpdateTokenPrices(tokens: Array<{
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}>): Promise<void> {
  const BATCH_SIZE = 10;
  const DELAY_MS = 200;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (token) => {
      try {
        const price = await getCachedTokenPrice(token.address);
        if (price && price > 0) {
          logger.info(`✅ Cached/fetched price for ${token.symbol || token.address}: $${price}`);
        }
      } catch (error) {
        logger.error(`Error processing token ${token.symbol || token.address}:`, error);
      }
    }));
    
    // Add delay between batches
    if (i + BATCH_SIZE < tokens.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
}

// Clear expired cache entries
export async function cleanupExpiredPrices(): Promise<void> {
  try {
    const expirationDate = new Date(Date.now() - CACHE_DURATION);
    await TokenPriceModel.deleteMany({
      lastUpdated: { $lt: expirationDate }
    });
    
    // Clear memory cache entries
    for (const [key, value] of memoryCache.entries()) {
      if (Date.now() - value.timestamp > CACHE_DURATION) {
        memoryCache.delete(key);
      }
    }
  } catch (error) {
    logger.error('Error cleaning up expired prices:', error);
  }
}