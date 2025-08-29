import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PNLCalculatorService } from '@/services/pnlCalculator';
import { pythPriceService } from '@/services/pyth/priceService';
import { TransactionModel } from '@/database/models/Transaction';
import { PNLModel } from '@/database/models/PNL';
import { TransactionHistoryService } from '@/services/transactionHistory';
import Moralis from 'moralis';

// Mock all dependencies
vi.mock('@/services/pyth/priceService');
vi.mock('@/database/models/Transaction');
vi.mock('@/database/models/PNL');
vi.mock('@/services/transactionHistory');
vi.mock('moralis');

describe('PNLCalculatorService with Pyth Integration', () => {
  const mockWalletAddress = '0x1234567890123456789012345678901234567890';
  const mockTokenAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
  const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use Pyth prices for unrealized PNL calculation when available', async () => {
    // Mock existing PNL check
    vi.mocked(PNLModel.findOne).mockResolvedValue(null);
    vi.mocked(TransactionModel.findOne).mockReturnValue({
      sort: vi.fn().mockResolvedValue(null)
    } as any);

    // Mock transaction history
    const mockTransactions = [
      {
        hash: '0xhash1',
        blockTimestamp: new Date('2024-01-01'),
        valueDecimal: 1,
        erc20Transfers: [
          {
            address: mockTokenAddress,
            token_symbol: 'TEST',
            token_name: 'Test Token',
            value_formatted: '100',
            to_address: mockWalletAddress,
            from_address: '0xdex'
          }
        ],
        nativeTransfers: [
          {
            token_symbol: 'BNB',
            value_formatted: '1'
          }
        ]
      }
    ];

    vi.mocked(TransactionHistoryService.fetchAndSaveTransactionHistory).mockResolvedValue(undefined);
    vi.mocked(TransactionHistoryService.getCachedTransactions).mockResolvedValue(mockTransactions as any);

    // Mock Pyth prices - token at $200, BNB at $400
    const pythPricesMap = new Map([
      [mockTokenAddress.toLowerCase(), 200],
      [WBNB_ADDRESS.toLowerCase(), 400]
    ]);
    
    vi.mocked(pythPriceService.fetchMultiplePrices).mockResolvedValue(pythPricesMap);

    // Mock Moralis token metadata
    vi.mocked(Moralis.EvmApi.token.getTokenMetadata).mockResolvedValue({
      toJSON: () => [
        {
          address: mockTokenAddress,
          name: 'Test Token',
          symbol: 'TEST',
          decimals: '18'
        }
      ]
    } as any);

    // Mock PNL save
    const mockSavedPNL = {
      walletAddress: mockWalletAddress.toLowerCase(),
      totalPNL: 0.5, // Unrealized PNL: (200/400) * 100 - 1 = 50 - 1 = 49 BNB worth, but cost was 1 BNB
      totalUnrealizedPNL: 49,
      totalRealizedPNL: 0,
      detailedPNL: {
        [mockTokenAddress]: {
          realizedPNL: 0,
          unrealizedPNL: 49,
          totalPNL: 49,
          currentHoldings: 100,
          averageBuyPrice: 0.01,
          currentPrice: 0.5 // 200/400 = 0.5 BNB per token
        }
      }
    };

    vi.mocked(PNLModel.findOneAndUpdate).mockResolvedValue(mockSavedPNL as any);

    // Execute
    const result = await PNLCalculatorService.calculatePNL(mockWalletAddress);

    // Verify Pyth was called for batch price fetching
    expect(pythPriceService.fetchMultiplePrices).toHaveBeenCalledWith([mockTokenAddress]);

    // Verify the result uses Pyth prices
    expect(result.detailedPNL![mockTokenAddress]).toBeDefined();
    expect(result.detailedPNL![mockTokenAddress].currentPrice).toBe(0.5); // Token price in BNB
  });

  it('should fallback to Moralis when Pyth prices are not available', async () => {
    // Mock existing PNL check
    vi.mocked(PNLModel.findOne).mockResolvedValue(null);
    vi.mocked(TransactionModel.findOne).mockReturnValue({
      sort: vi.fn().mockResolvedValue(null)
    } as any);

    // Mock transaction history with remaining tokens
    const mockTransactions = [
      {
        hash: '0xhash1',
        blockTimestamp: new Date('2024-01-01'),
        valueDecimal: 1,
        erc20Transfers: [
          {
            address: mockTokenAddress,
            token_symbol: 'TEST',
            token_name: 'Test Token',
            value_formatted: '100',
            to_address: mockWalletAddress,
            from_address: '0xdex'
          }
        ],
        nativeTransfers: [
          {
            token_symbol: 'BNB',
            value_formatted: '1'
          }
        ]
      }
    ];

    vi.mocked(TransactionHistoryService.fetchAndSaveTransactionHistory).mockResolvedValue(undefined);
    vi.mocked(TransactionHistoryService.getCachedTransactions).mockResolvedValue(mockTransactions as any);

    // Mock Pyth returning empty prices
    vi.mocked(pythPriceService.fetchMultiplePrices).mockResolvedValue(new Map());

    // Mock Moralis fallback prices
    vi.mocked(Moralis.EvmApi.token.getTokenPrice)
      .mockResolvedValueOnce({
        toJSON: () => ({ usdPrice: 150 }) // Token price
      } as any)
      .mockResolvedValueOnce({
        toJSON: () => ({ usdPrice: 300 }) // BNB price
      } as any);

    // Mock Moralis token metadata
    vi.mocked(Moralis.EvmApi.token.getTokenMetadata).mockResolvedValue({
      toJSON: () => [
        {
          address: mockTokenAddress,
          name: 'Test Token',
          symbol: 'TEST',
          decimals: '18'
        }
      ]
    } as any);

    // Mock PNL save
    vi.mocked(PNLModel.findOneAndUpdate).mockResolvedValue({
      walletAddress: mockWalletAddress.toLowerCase(),
      detailedPNL: {
        [mockTokenAddress]: {
          currentPrice: 0.5 // 150/300 = 0.5 BNB per token
        }
      }
    } as any);

    // Execute
    const result = await PNLCalculatorService.calculatePNL(mockWalletAddress);

    // Verify Pyth was attempted
    expect(pythPriceService.fetchMultiplePrices).toHaveBeenCalled();

    // Verify Moralis was called as fallback
    expect(Moralis.EvmApi.token.getTokenPrice).toHaveBeenCalled();
  });

  it('should handle mixed Pyth and Moralis prices for multiple tokens', async () => {
    const mockToken2Address = '0xdef4567890123456789012345678901234567890';

    // Mock existing PNL check
    vi.mocked(PNLModel.findOne).mockResolvedValue(null);
    vi.mocked(TransactionModel.findOne).mockReturnValue({
      sort: vi.fn().mockResolvedValue(null)
    } as any);

    // Mock transactions for two tokens
    const mockTransactions = [
      {
        hash: '0xhash1',
        blockTimestamp: new Date('2024-01-01'),
        valueDecimal: 1,
        erc20Transfers: [
          {
            address: mockTokenAddress,
            token_symbol: 'TEST1',
            token_name: 'Test Token 1',
            value_formatted: '100',
            to_address: mockWalletAddress,
            from_address: '0xdex'
          }
        ],
        nativeTransfers: [
          {
            token_symbol: 'BNB',
            value_formatted: '1'
          }
        ]
      },
      {
        hash: '0xhash2',
        blockTimestamp: new Date('2024-01-02'),
        valueDecimal: 2,
        erc20Transfers: [
          {
            address: mockToken2Address,
            token_symbol: 'TEST2',
            token_name: 'Test Token 2',
            value_formatted: '200',
            to_address: mockWalletAddress,
            from_address: '0xdex'
          }
        ],
        nativeTransfers: [
          {
            token_symbol: 'BNB',
            value_formatted: '2'
          }
        ]
      }
    ];

    vi.mocked(TransactionHistoryService.fetchAndSaveTransactionHistory).mockResolvedValue(undefined);
    vi.mocked(TransactionHistoryService.getCachedTransactions).mockResolvedValue(mockTransactions as any);

    // Mock Pyth prices - only has price for token1 and BNB
    const pythPricesMap = new Map([
      [mockTokenAddress.toLowerCase(), 250],
      [WBNB_ADDRESS.toLowerCase(), 500]
    ]);
    
    vi.mocked(pythPriceService.fetchMultiplePrices).mockResolvedValue(pythPricesMap);

    // Mock Moralis fallback for token2
    let moralisCallCount = 0;
    vi.mocked(Moralis.EvmApi.token.getTokenPrice).mockImplementation(() => {
      moralisCallCount++;
      if (moralisCallCount === 1) {
        return Promise.resolve({
          toJSON: () => ({ usdPrice: 100 }) // Token2 price
        } as any);
      } else {
        return Promise.resolve({
          toJSON: () => ({ usdPrice: 500 }) // BNB price
        } as any);
      }
    });

    // Mock Moralis token metadata
    vi.mocked(Moralis.EvmApi.token.getTokenMetadata).mockResolvedValue({
      toJSON: () => [
        {
          address: mockTokenAddress,
          name: 'Test Token 1',
          symbol: 'TEST1',
          decimals: '18'
        },
        {
          address: mockToken2Address,
          name: 'Test Token 2',
          symbol: 'TEST2',
          decimals: '18'
        }
      ]
    } as any);

    // Mock PNL save
    vi.mocked(PNLModel.findOneAndUpdate).mockResolvedValue({
      walletAddress: mockWalletAddress.toLowerCase(),
      detailedPNL: {
        [mockTokenAddress]: {
          currentPrice: 0.5 // 250/500 = 0.5 BNB (from Pyth)
        },
        [mockToken2Address]: {
          currentPrice: 0.2 // 100/500 = 0.2 BNB (from Moralis)
        }
      }
    } as any);

    // Execute
    const result = await PNLCalculatorService.calculatePNL(mockWalletAddress);

    // Verify both tokens were requested from Pyth
    expect(pythPriceService.fetchMultiplePrices).toHaveBeenCalledWith([mockTokenAddress, mockToken2Address]);

    // Verify Moralis was called for token2 (not in Pyth)
    expect(Moralis.EvmApi.token.getTokenPrice).toHaveBeenCalled();
  });
});