import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockMoralis, mockMoralisResponse } from '../mocks/moralis.mock';

describe('Moralis API Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMoralis.Core.isStarted = false;
  });

  describe('API Initialization', () => {
    it('should initialize Moralis when not started', async () => {
      expect(mockMoralis.Core.isStarted).toBe(false);
      
      await mockMoralis.start({ apiKey: 'test-api-key' });
      
      expect(mockMoralis.start).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
      expect(mockMoralis.Core.isStarted).toBe(true);
    });

    it('should not reinitialize Moralis when already started', async () => {
      mockMoralis.Core.isStarted = true;
      
      await mockMoralis.start({ apiKey: 'test-api-key' });
      
      expect(mockMoralis.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('Wallet Token Balances', () => {
    const testWallet = '0x5c2d1a44553650963693371261a278fd31cb26ff';

    beforeEach(() => {
      mockMoralisResponse.toJSON.mockReturnValue({
        result: [
          {
            token_address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
            symbol: 'WBNB',
            name: 'Wrapped BNB',
            decimals: 18,
            balance: '1000000000000000000',
            possible_spam: false,
            verified_contract: true,
            usd_price: 300,
            usd_value: 300,
            percentage_relative_to_total_supply: 0.0001
          },
          {
            token_address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
            symbol: 'BUSD',
            name: 'Binance USD',
            decimals: 18,
            balance: '500000000000000000000',
            possible_spam: false,
            verified_contract: true,
            usd_price: 1,
            usd_value: 500,
            percentage_relative_to_total_supply: 0.00005
          }
        ]
      });
    });

    it('should fetch wallet token balances with prices', async () => {
      const response = await mockMoralis.EvmApi.wallets.getWalletTokenBalancesPrice({
        chain: "0x38",
        address: testWallet
      });

      expect(mockMoralis.EvmApi.wallets.getWalletTokenBalancesPrice).toHaveBeenCalledWith({
        chain: "0x38",
        address: testWallet
      });

      const data = response.toJSON();
      expect(data.result).toHaveLength(2);
      expect(data.result[0].symbol).toBe('WBNB');
      expect(data.result[0].usd_value).toBe(300);
    });

    it('should handle empty wallet response', async () => {
      mockMoralisResponse.toJSON.mockReturnValue({ result: [] });

      const response = await mockMoralis.EvmApi.wallets.getWalletTokenBalancesPrice({
        chain: "0x38",
        address: testWallet
      });

      const data = response.toJSON();
      expect(data.result).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
      mockMoralis.EvmApi.wallets.getWalletTokenBalancesPrice.mockRejectedValueOnce(
        new Error('API rate limit exceeded')
      );

      await expect(
        mockMoralis.EvmApi.wallets.getWalletTokenBalancesPrice({
          chain: "0x38",
          address: testWallet
        })
      ).rejects.toThrow('API rate limit exceeded');
    });
  });

  describe('Token Price', () => {
    const tokenAddress = '0xf4b385849f2e817e92bffbfb9aeb48f950ff4444';

    beforeEach(() => {
      mockMoralisResponse.toJSON.mockReturnValue({
        tokenAddress,
        usdPrice: 0.000001,
        exchangeAddress: '0x1234567890123456789012345678901234567890',
        exchangeName: 'PancakeSwap v2'
      });
    });

    it('should fetch token price from Moralis', async () => {
      const response = await mockMoralis.EvmApi.token.getTokenPrice({
        chain: "0x38",
        address: tokenAddress
      });

      expect(mockMoralis.EvmApi.token.getTokenPrice).toHaveBeenCalledWith({
        chain: "0x38",
        address: tokenAddress
      });

      const priceData = response.toJSON();
      expect(priceData.usdPrice).toBe(0.000001);
      expect(priceData.exchangeName).toBe('PancakeSwap v2');
    });

    it('should handle tokens without price data', async () => {
      mockMoralis.EvmApi.token.getTokenPrice.mockRejectedValueOnce(
        new Error('No pools found with enough liquidity')
      );

      await expect(
        mockMoralis.EvmApi.token.getTokenPrice({
          chain: "0x38",
          address: tokenAddress
        })
      ).rejects.toThrow('No pools found with enough liquidity');
    });
  });

  describe('Token Holders', () => {
    const tokenAddress = '0xf4b385849f2e817e92bffbfb9aeb48f950ff4444';

    beforeEach(() => {
      mockMoralisResponse.toJSON.mockReturnValue({
        result: [
          {
            owner_address: '0x1111111111111111111111111111111111111111',
            balance: '1000000000000000000000000',
            percentage_relative_to_total_supply: 10.5
          },
          {
            owner_address: '0x2222222222222222222222222222222222222222',
            balance: '500000000000000000000000',
            percentage_relative_to_total_supply: 5.25
          }
        ]
      });
    });

    it('should fetch top token holders', async () => {
      const response = await mockMoralis.EvmApi.token.getTokenOwners({
        chain: "0x38",
        tokenAddress,
        limit: 10
      });

      expect(mockMoralis.EvmApi.token.getTokenOwners).toHaveBeenCalledWith({
        chain: "0x38",
        tokenAddress,
        limit: 10
      });

      const holders = response.toJSON().result;
      expect(holders).toHaveLength(2);
      expect(holders[0].percentage_relative_to_total_supply).toBe(10.5);
    });
  });
});