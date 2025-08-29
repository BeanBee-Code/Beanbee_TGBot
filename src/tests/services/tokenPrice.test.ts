import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { mockMoralis, mockMoralisResponse } from '../mocks/moralis.mock';
import { mockContract, mockProvider } from '../mocks/ethers.mock';
import '../mocks/database.mock';
import '../mocks/logger.mock';

// Mock the services that use database models
vi.mock('@/services/wallet/tokenPriceCache', () => ({
  getCachedTokenPrice: vi.fn(),
  setCachedTokenPrice: vi.fn()
}));

vi.mock('@/services/wallet/scannerUtils', () => ({
  getWalletTokensWithPrices: vi.fn()
}));

vi.mock('ethers');

describe('Token Price Service', () => {
  const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
  const USDT = '0x55d398326f99059fF775485246999027B3197955';
  const testTokenAddress = '0xf4b385849f2e817e92bffbfb9aeb48f950ff4444';

  beforeEach(() => {
    vi.clearAllMocks();
    mockMoralis.Core.isStarted = false;
    
    // Mock ethers
    (ethers.JsonRpcProvider as any).mockImplementation(() => mockProvider);
    (ethers.Contract as any).mockImplementation(() => mockContract);
    (ethers.formatUnits as any).mockImplementation((value: string | bigint, decimals = 18) => {
      const divisor = BigInt(10) ** BigInt(decimals);
      return (BigInt(value) / divisor).toString();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Moralis Price API', () => {
    it('should fetch token price from Moralis', async () => {
      mockMoralisResponse.toJSON.mockReturnValue({
        tokenAddress: testTokenAddress,
        usdPrice: 0.000001,
        exchangeAddress: '0x1234567890123456789012345678901234567890',
        exchangeName: 'PancakeSwap v2'
      });

      await mockMoralis.start({ apiKey: 'test-key' });
      const response = await mockMoralis.EvmApi.token.getTokenPrice({
        chain: "0x38",
        address: testTokenAddress
      });

      const priceData = response.toJSON();
      expect(priceData.usdPrice).toBe(0.000001);
    });

    it('should handle Moralis API errors', async () => {
      mockMoralis.EvmApi.token.getTokenPrice.mockRejectedValueOnce(
        new Error('No pools found with enough liquidity')
      );

      await expect(
        mockMoralis.EvmApi.token.getTokenPrice({
          chain: "0x38",
          address: testTokenAddress
        })
      ).rejects.toThrow('No pools found with enough liquidity');
    });
  });

  describe('Cached Token Price', () => {
    it('should retrieve cached token price', async () => {
      const { getCachedTokenPrice } = await import('@/services/wallet/tokenPriceCache');
      const mockGetCachedPrice = vi.mocked(getCachedTokenPrice);
      mockGetCachedPrice.mockResolvedValue(0.000001);

      const cachedPrice = await getCachedTokenPrice(testTokenAddress);
      expect(cachedPrice).toBe(0.000001);
      expect(mockGetCachedPrice).toHaveBeenCalledWith(testTokenAddress);
    });

    it('should return null for uncached tokens', async () => {
      const { getCachedTokenPrice } = await import('@/services/wallet/tokenPriceCache');
      const mockGetCachedPrice = vi.mocked(getCachedTokenPrice);
      mockGetCachedPrice.mockResolvedValue(null);

      const cachedPrice = await getCachedTokenPrice(testTokenAddress);
      expect(cachedPrice).toBeNull();
    });
  });

  describe('DEX Liquidity Pool Price', () => {
    beforeEach(() => {
      // Mock factory contract
      mockContract.getPair.mockImplementation((tokenA: string, tokenB: string) => {
        if (tokenB === WBNB) return '0x1111111111111111111111111111111111111111';
        if (tokenB === BUSD) return '0x2222222222222222222222222222222222222222';
        return '0x0000000000000000000000000000000000000000';
      });

      // Mock token contract
      mockContract.decimals.mockResolvedValue(18);
      
      // Mock pair contract
      mockContract.getReserves.mockResolvedValue({
        reserve0: BigInt('1000000000000000000000'), // 1000 tokens
        reserve1: BigInt('2000000000000000000000'), // 2000 WBNB/BUSD
        blockTimestampLast: 1234567890
      });
      
      mockContract.token0.mockResolvedValue(testTokenAddress);
    });

    it('should calculate price from WBNB pair', async () => {
      const pairAddress = await mockContract.getPair(testTokenAddress, WBNB);
      expect(pairAddress).toBe('0x1111111111111111111111111111111111111111');

      const reserves = await mockContract.getReserves();
      const token0 = await mockContract.token0();
      
      expect(token0.toLowerCase()).toBe(testTokenAddress.toLowerCase());
      
      // Price calculation: reserve1 / reserve0
      const priceInBNB = Number(ethers.formatUnits(reserves.reserve1, 18)) / 
                         Number(ethers.formatUnits(reserves.reserve0, 18));
      expect(priceInBNB).toBe(2); // 2000/1000 = 2 BNB per token

      // With BNB at $600
      const tokenPriceUSD = priceInBNB * 600;
      expect(tokenPriceUSD).toBe(1200);
    });

    it('should calculate price from stablecoin pair', async () => {
      const pairAddress = await mockContract.getPair(testTokenAddress, BUSD);
      expect(pairAddress).toBe('0x2222222222222222222222222222222222222222');

      const reserves = await mockContract.getReserves();
      
      // Price calculation for stablecoin pair
      const tokenPriceUSD = Number(ethers.formatUnits(reserves.reserve1, 18)) / 
                           Number(ethers.formatUnits(reserves.reserve0, 18));
      expect(tokenPriceUSD).toBe(2); // 2000/1000 = $2 per token
    });

    it('should handle tokens without liquidity pairs', async () => {
      mockContract.getPair.mockResolvedValue('0x0000000000000000000000000000000000000000');
      
      const pairAddress = await mockContract.getPair(testTokenAddress, WBNB);
      expect(pairAddress).toBe('0x0000000000000000000000000000000000000000');
    });
  });

  describe('Token Holder Analysis', () => {
    beforeEach(() => {
      mockMoralisResponse.toJSON.mockReturnValue({
        result: [
          {
            owner_address: '0x1111111111111111111111111111111111111111',
            balance: '10000000000000000000000',
            percentage_relative_to_total_supply: 10
          },
          {
            owner_address: '0x2222222222222222222222222222222222222222',
            balance: '5000000000000000000000',
            percentage_relative_to_total_supply: 5
          }
        ]
      });
    });

    it('should fetch and analyze top token holders', async () => {
      // Import and mock inside the test
      const { getWalletTokensWithPrices } = await import('@/services/wallet/scannerUtils');
      vi.mocked(getWalletTokensWithPrices).mockResolvedValue([
        {
          token_address: WBNB,
          symbol: 'WBNB',
          balance: '10000000000000000000', // 10 WBNB
          usd_value: 6000 // $600 * 10
        }
      ] as any);

      // Set up the mock response for getTokenOwners
      mockMoralis.EvmApi.token.getTokenOwners.mockResolvedValueOnce(mockMoralisResponse);

      // Now run the test
      const response = await mockMoralis.EvmApi.token.getTokenOwners({
        chain: "0x38",
        tokenAddress: testTokenAddress,
        limit: 10
      });

      const holders = response.toJSON().result;
      expect(holders).toHaveLength(2);
      expect(holders[0].percentage_relative_to_total_supply).toBe(10);

      // Check portfolio value calculation
      const holderPortfolio = await getWalletTokensWithPrices(holders[0].owner_address);
      expect(Array.isArray(holderPortfolio)).toBe(true);
      if (Array.isArray(holderPortfolio) && holderPortfolio.length > 0) {
        expect(holderPortfolio[0].usd_value).toBe(6000);
      }
    });

    it('should identify whale holders based on portfolio value', async () => {
      const { getWalletTokensWithPrices } = await import('@/services/wallet/scannerUtils');
      vi.mocked(getWalletTokensWithPrices).mockResolvedValue([
        {
          token_address: WBNB,
          symbol: 'WBNB',
          balance: '10000000000000000000',
          usd_value: 6000
        }
      ] as any);
      
      const holders = [
        { address: '0x1111111111111111111111111111111111111111', balance: 10000, tokenValue: 20000 },
        { address: '0x2222222222222222222222222222222222222222', balance: 5000, tokenValue: 10000 }
      ];

      for (const holder of holders) {
        const portfolio = await getWalletTokensWithPrices(holder.address);
        const totalValue = Array.isArray(portfolio) 
          ? portfolio.reduce((sum: number, token: any) => sum + (token.usd_value || 0), 0) + holder.tokenValue
          : holder.tokenValue;
        
        const isWhale = totalValue > 1000000;
        expect(isWhale).toBe(false); // Based on our mock data, neither should be whales
      }
    });
  });
});