import { vi } from 'vitest';

export const mockMoralisResponse = {
  toJSON: vi.fn()
};

export const mockMoralisEvmApi = {
  token: {
    getTokenPrice: vi.fn().mockImplementation(({ address }) => ({
      result: {
        usdPrice: 0.000001,
        '24hrPercentChange': '5.25',
        exchangeName: 'PancakeSwap v2'
      },
      toJSON: () => ({
        usdPrice: 0.000001,
        '24hrPercentChange': '5.25',
        exchangeName: 'PancakeSwap v2'
      })
    })),
    getTokenOwners: vi.fn().mockResolvedValue(mockMoralisResponse),
    getTokenMetadata: vi.fn().mockImplementation(({ addresses }) => ({
      result: addresses.map((addr: string) => ({
        token: {
          address: addr,
          name: 'Test Token',
          symbol: 'TEST',
          decimals: '18',
          logo: 'https://example.com/logo.png'
        },
        blockNumber: '12345',
        validated: 1
      }))
    })),
    getTokenTransfers: vi.fn().mockResolvedValue(mockMoralisResponse),
    getWalletTokenTransfers: vi.fn().mockResolvedValue(mockMoralisResponse)
  },
  wallets: {
    getWalletTokenBalancesPrice: vi.fn().mockResolvedValue(mockMoralisResponse)
  },
  transaction: {
    getWalletTransactions: vi.fn().mockResolvedValue(mockMoralisResponse)
  }
};

export const mockMoralis = {
  Core: {
    isStarted: false
  },
  start: vi.fn().mockImplementation(() => {
    mockMoralis.Core.isStarted = true;
    return Promise.resolve();
  }),
  EvmApi: mockMoralisEvmApi
};

vi.mock('moralis', () => ({
  default: mockMoralis,
  ...mockMoralis
}));