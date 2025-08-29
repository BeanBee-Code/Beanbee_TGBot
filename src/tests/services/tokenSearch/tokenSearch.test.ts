import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenSearchService } from '../../../services/tokenSearch';
import { DexScreenerService } from '../../../services/tokenSearch/dexScreenerService';

// Mock the dependencies
vi.mock('../../../services/pancakeswap', () => ({
  PancakeSwapTrader: vi.fn().mockImplementation(() => ({
    getTokenInfo: vi.fn().mockResolvedValue({
      address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      name: 'PancakeSwap Token',
      symbol: 'CAKE',
      decimals: 18
    })
  }))
}));

vi.mock('moralis', () => ({
  default: {
    Core: { isStarted: false },
    start: vi.fn().mockResolvedValue(undefined),
    EvmApi: {
      token: {
        getTokenPrice: vi.fn().mockResolvedValue({
          result: {
            usdPrice: 3.45,
            '24hrPercentChange': '5.67'
          },
          toJSON: () => ({
            usdPrice: 3.45,
            '24hrPercentChange': '5.67'
          })
        }),
        getTokenMetadata: vi.fn().mockResolvedValue({
          result: [{
            logo: 'https://example.com/cake-logo.png'
          }]
        })
      }
    }
  }
}));

vi.mock('../../../services/tokenSearch/dexScreenerService');

describe('TokenSearchService', () => {
  let service: TokenSearchService;
  let mockDexScreenerService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock DexScreenerService
    mockDexScreenerService = {
      searchBscTokens: vi.fn(),
      getTokenDetailsByAddress: vi.fn(),
      getPopularBscTokens: vi.fn()
    };
    
    (DexScreenerService as any).mockImplementation(() => mockDexScreenerService);
    
    service = new TokenSearchService('test-moralis-key');
  });

  describe('searchTokens', () => {
    it('should search tokens by name using DexScreener API', async () => {
      mockDexScreenerService.searchBscTokens.mockResolvedValue([
        {
          address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
          name: 'PancakeSwap',
          symbol: 'CAKE',
          priceUsd: 3.45,
          priceChange24h: 5.67,
          volume24h: 1000000,
          liquidity: 50000000,
          logoURI: 'https://example.com/cake-logo.png'
        }
      ]);

      const results = await service.searchTokens('cake');

      expect(mockDexScreenerService.searchBscTokens).toHaveBeenCalledWith('cake');
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('CAKE');
      expect(results[0].verified).toBe(true); // Has good liquidity
    });

    it('should return token info for valid BSC address', async () => {
      const address = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
      
      mockDexScreenerService.getTokenDetailsByAddress.mockResolvedValue({
        address: address,
        name: 'PancakeSwap',
        symbol: 'CAKE',
        priceUsd: 3.45,
        priceChange24h: 5.67,
        volume24h: 1000000,
        liquidity: 50000000,
        logoURI: 'https://example.com/cake-logo.png'
      });

      const results = await service.searchTokens(address);

      expect(results).toHaveLength(1);
      expect(results[0].address).toBe(address);
      expect(results[0].symbol).toBe('CAKE');
    });

    it('should handle tokens from DexScreener without blockchain data', async () => {
      mockDexScreenerService.searchBscTokens.mockResolvedValue([
        {
          address: '0x123',
          name: 'New Token',
          symbol: 'NEW',
          priceUsd: 0.001,
          priceChange24h: 100,
          volume24h: 10000,
          liquidity: 5000,
          logoURI: 'https://example.com/new-logo.png'
        }
      ]);

      // Create a new service instance with mocked trader that returns null
      const { PancakeSwapTrader } = await import('../../../services/pancakeswap');
      vi.mocked(PancakeSwapTrader).mockImplementationOnce(() => ({
        getTokenInfo: vi.fn().mockResolvedValue(null)
      } as any));
      
      service = new TokenSearchService('test-moralis-key');

      const results = await service.searchTokens('new');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('NEW');
      expect(results[0].price).toBe(0.001);
      expect(results[0].verified).toBe(false); // Low liquidity
    });

    it('should handle empty search results and fallback to popular tokens', async () => {
      mockDexScreenerService.searchBscTokens.mockResolvedValue([]);
      mockDexScreenerService.getPopularBscTokens.mockResolvedValue([
        {
          address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
          name: 'Wrapped BNB',
          symbol: 'WBNB',
          priceUsd: 300,
          priceChange24h: 2.5,
          liquidity: 100000000
        }
      ]);
      
      const results = await service.searchTokens('bnb');
      
      expect(mockDexScreenerService.getPopularBscTokens).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('WBNB');
    });

    it('should handle DexScreener API errors gracefully', async () => {
      mockDexScreenerService.searchBscTokens.mockRejectedValue(new Error('API Error'));
      
      const results = await service.searchTokens('test');
      
      expect(results).toHaveLength(0);
    });
  });

  describe('getTokenByAddress', () => {
    it('should return null for invalid address', async () => {
      const result = await service.getTokenByAddress('invalid-address');
      expect(result).toBeNull();
    });

    it('should get token info for valid address with DexScreener data', async () => {
      const address = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
      
      mockDexScreenerService.getTokenDetailsByAddress.mockResolvedValue({
        address: address,
        name: 'PancakeSwap',
        symbol: 'CAKE',
        priceUsd: 3.45,
        priceChange24h: 5.67,
        volume24h: 1000000,
        liquidity: 50000000,
        logoURI: 'https://example.com/cake-logo.png'
      });

      const result = await service.getTokenByAddress(address);

      expect(result).not.toBeNull();
      expect(result?.address).toBe(address);
      expect(result?.symbol).toBe('CAKE');
      expect(result?.price).toBe(3.45);
      expect(result?.priceChange24h).toBe(5.67);
    });
  });

  describe('formatTokenDetails', () => {
    it('should format token details correctly', () => {
      const token = {
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        name: 'PancakeSwap',
        symbol: 'CAKE',
        decimals: 18,
        price: 3.45,
        priceChange24h: 5.67,
        marketCap: 1000000000,
        volume24h: 50000000,
        verified: true
      };

      const formatted = service.formatTokenDetails(token);

      expect(formatted).toContain('PancakeSwap (CAKE)');
      expect(formatted).toContain('$3.45');
      expect(formatted).toContain('+5.67%');
      expect(formatted).toContain('✅ **Verified Token**');
    });

    it('should handle missing price data', () => {
      const token = {
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18
      };

      const formatted = service.formatTokenDetails(token);

      expect(formatted).toContain('Test Token (TEST)');
      expect(formatted).not.toContain('Price:');
      expect(formatted).not.toContain('24h Change:');
    });
  });

  describe('formatSearchResults', () => {
    it('should format search results correctly', () => {
      const results = [
        {
          address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
          name: 'PancakeSwap',
          symbol: 'CAKE',
          decimals: 18,
          price: 3.45,
          verified: true
        },
        {
          address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
          name: 'Binance USD',
          symbol: 'BUSD',
          decimals: 18,
          price: 1.00,
          verified: true
        }
      ];

      const formatted = service.formatSearchResults(results);

      expect(formatted).toContain('**Token Search Results** (2 found)');
      expect(formatted).toContain('1. **CAKE** - PancakeSwap ✅');
      expect(formatted).toContain('2. **BUSD** - Binance USD ✅');
      expect(formatted).toContain('Price: $3.45');
      expect(formatted).toContain('Price: $1.00');
    });

    it('should handle empty results', () => {
      const formatted = service.formatSearchResults([]);
      expect(formatted).toBe('❌ No tokens found matching your search.');
    });
  });
});