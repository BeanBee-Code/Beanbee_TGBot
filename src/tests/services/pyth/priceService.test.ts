import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HermesClient } from '@pythnetwork/hermes-client';
import '../../../tests/mocks/logger.mock';

// Mock the HermesClient
vi.mock('@pythnetwork/hermes-client', () => ({
  HermesClient: vi.fn().mockImplementation(() => ({
    getLatestPriceUpdates: vi.fn(),
    getPriceUpdatesStream: vi.fn()
  }))
}));

// Mock the config
vi.mock('@/config/pythPriceIds', () => {
  const mapping: Record<string, string> = {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8', // WBNB
    '0x55d398326f99059ff775485246999027b3197955': '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', // USDT
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': '0xde0c3c89aaa60d580e3b4c6e7bc87a093ad86b97ae7c18f6eb12ee7b9e3e3ec0', // CAKE
  };
  
  return {
    getPythPriceId: vi.fn((address: string) => {
      return mapping[address.toLowerCase()];
    }),
    hasPythPriceFeed: vi.fn((address: string) => {
      const supported = [
        '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
        '0x55d398326f99059ff775485246999027b3197955',
        '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'
      ];
      return supported.includes(address.toLowerCase());
    }),
    ADDRESS_TO_PRICE_ID_MAP: mapping
  };
});

describe('Pyth Price Service', () => {
  let pythPriceService: any;
  let mockHermesClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Reset module cache and re-import
    vi.resetModules();
    
    // Setup mock client
    mockHermesClient = {
      getLatestPriceUpdates: vi.fn(),
      getPriceUpdatesStream: vi.fn()
    };
    
    (HermesClient as any).mockImplementation(() => mockHermesClient);
    
    // Import the service after mocks are set up
    const module = await import('@/services/pyth/priceService');
    pythPriceService = module.pythPriceService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchPriceByAddress', () => {
    it('should fetch price for WBNB successfully', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      const expectedPrice = 325.50;
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          price: {
            price: '32550000000',
            expo: -8,
            conf: '10000000'
          }
        }]
      });

      const price = await pythPriceService.fetchPriceByAddress(wbnbAddress);
      
      expect(price).toBe(expectedPrice);
      expect(mockHermesClient.getLatestPriceUpdates).toHaveBeenCalledWith([
        '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8'
      ]);
    });

    it('should fetch price for USDT successfully', async () => {
      const usdtAddress = '0x55d398326f99059fF775485246999027B3197955';
      const expectedPrice = 0.9998;
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
          price: {
            price: '99980000',
            expo: -8,
            conf: '1000'
          }
        }]
      });

      const price = await pythPriceService.fetchPriceByAddress(usdtAddress);
      
      expect(price).toBe(expectedPrice);
    });

    it('should return null for unsupported token', async () => {
      const unsupportedAddress = '0x1234567890123456789012345678901234567890';
      
      const price = await pythPriceService.fetchPriceByAddress(unsupportedAddress);
      
      expect(price).toBeNull();
      expect(mockHermesClient.getLatestPriceUpdates).not.toHaveBeenCalled();
    });

    it('should return cached price if available', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      const expectedPrice = 325.50;
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          price: {
            price: '32550000000',
            expo: -8,
            conf: '10000000'
          }
        }]
      });

      // First call - should fetch from API
      await pythPriceService.fetchPriceByAddress(wbnbAddress);
      expect(mockHermesClient.getLatestPriceUpdates).toHaveBeenCalledTimes(1);
      
      // Second call immediately after - should use cache
      const cachedPrice = await pythPriceService.fetchPriceByAddress(wbnbAddress);
      expect(cachedPrice).toBe(expectedPrice);
      expect(mockHermesClient.getLatestPriceUpdates).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('should handle API errors gracefully', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      
      mockHermesClient.getLatestPriceUpdates.mockRejectedValue(
        new Error('Network error')
      );

      const price = await pythPriceService.fetchPriceByAddress(wbnbAddress);
      
      expect(price).toBeNull();
    });

    it('should handle invalid price data', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      
      // Return data without price field
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          // Missing price field
        }]
      });

      const price = await pythPriceService.fetchPriceByAddress(wbnbAddress);
      
      expect(price).toBeNull();
    });

    it('should reject unreasonable prices', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      
      // Price exceeding $1 trillion
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          price: {
            price: '2000000000000000',
            expo: 0,
            conf: '10000000'
          }
        }]
      });

      const price = await pythPriceService.fetchPriceByAddress(wbnbAddress);
      
      expect(price).toBeNull();
    });
  });

  describe('fetchMultiplePrices', () => {
    it('should fetch multiple prices in batch', async () => {
      const addresses = [
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        '0x55d398326f99059fF775485246999027B3197955', // USDT
        '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'  // CAKE
      ];
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [
          {
            id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
            price: { price: '32550000000', expo: -8 }
          },
          {
            id: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
            price: { price: '99980000', expo: -8 }
          },
          {
            id: '0xde0c3c89aaa60d580e3b4c6e7bc87a093ad86b97ae7c18f6eb12ee7b9e3e3ec0',
            price: { price: '1250000000', expo: -8 }
          }
        ]
      });

      const prices = await pythPriceService.fetchMultiplePrices(addresses);
      
      expect(prices.size).toBe(3);
      expect(prices.get('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')).toBe(325.50);
      expect(prices.get('0x55d398326f99059ff775485246999027b3197955')).toBe(0.9998);
      expect(prices.get('0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82')).toBe(12.50);
    });

    it('should filter out unsupported tokens', async () => {
      const addresses = [
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB - supported
        '0x1234567890123456789012345678901234567890'  // Unsupported
      ];
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          price: { price: '32550000000', expo: -8 }
        }]
      });

      const prices = await pythPriceService.fetchMultiplePrices(addresses);
      
      expect(prices.size).toBe(1);
      expect(prices.has('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')).toBe(true);
      expect(prices.has('0x1234567890123456789012345678901234567890')).toBe(false);
    });

    it('should return empty map for all unsupported tokens', async () => {
      const addresses = [
        '0x1234567890123456789012345678901234567890',
        '0x0987654321098765432109876543210987654321'
      ];

      const prices = await pythPriceService.fetchMultiplePrices(addresses);
      
      expect(prices.size).toBe(0);
      expect(mockHermesClient.getLatestPriceUpdates).not.toHaveBeenCalled();
    });
  });

  describe('Price Streaming', () => {
    it('should start price streaming for tokens', async () => {
      const addresses = ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'];
      const mockEventSource = {
        onmessage: null as any,
        onerror: null as any,
        close: vi.fn()
      };
      
      mockHermesClient.getPriceUpdatesStream.mockResolvedValue(mockEventSource);
      
      const onPriceUpdate = vi.fn();
      await pythPriceService.startPriceStreaming(addresses, onPriceUpdate);
      
      expect(mockHermesClient.getPriceUpdatesStream).toHaveBeenCalled();
      
      // Simulate incoming price update
      if (mockEventSource.onmessage) {
        mockEventSource.onmessage({
          data: JSON.stringify({
            parsed: [{
              id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
              price: { price: '32550000000', expo: -8 }
            }]
          })
        });
      }
      
      expect(onPriceUpdate).toHaveBeenCalledWith(
        '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
        325.50
      );
    });

    it('should stop price streaming', async () => {
      const addresses = ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'];
      const mockEventSource = {
        onmessage: null,
        onerror: null,
        close: vi.fn()
      };
      
      mockHermesClient.getPriceUpdatesStream.mockResolvedValue(mockEventSource);
      
      await pythPriceService.startPriceStreaming(addresses, vi.fn());
      pythPriceService.stopPriceStreaming();
      
      expect(mockEventSource.close).toHaveBeenCalled();
    });
  });

  describe('Cache Management', () => {
    it('should clear cache', async () => {
      const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      
      mockHermesClient.getLatestPriceUpdates.mockResolvedValue({
        parsed: [{
          id: '0x2f95862b045670cd22ae0b96a7bfa612bb4ffdaef222afd13e759182e63df8f8',
          price: { price: '32550000000', expo: -8 }
        }]
      });

      // Fetch to populate cache
      await pythPriceService.fetchPriceByAddress(wbnbAddress);
      
      // Clear cache
      pythPriceService.clearCache();
      
      // Next fetch should call API again (cache cleared)
      await pythPriceService.fetchPriceByAddress(wbnbAddress);
      expect(mockHermesClient.getLatestPriceUpdates).toHaveBeenCalledTimes(2);
    });

    it('should report cache statistics', () => {
      const stats = pythPriceService.getCacheStats();
      
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.maxSize).toBe(100);
    });
  });
});