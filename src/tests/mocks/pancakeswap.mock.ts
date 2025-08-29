import { vi } from 'vitest';

export const mockPancakeSwapTrader = {
  getTokenInfo: vi.fn().mockImplementation(async (address: string) => {
    // Mock popular tokens - handle both exact addresses and searches
    const tokens: Record<string, any> = {
      '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': {
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        name: 'PancakeSwap',
        symbol: 'CAKE',
        decimals: 18
      },
      '0xe9e7cea3dedca5984780bafc599bd69add087d56': {
        address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        name: 'Binance USD',
        symbol: 'BUSD',
        decimals: 18
      },
      '0x55d398326f99059ff775485246999027b3197955': {
        address: '0x55d398326f99059fF775485246999027B3197955',
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 18
      },
      '0x2170ed0880ac9a755fd29b2688956bd959f933f8': {
        address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        name: 'Ethereum',
        symbol: 'ETH',
        decimals: 18
      },
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': {
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 18
      }
    };
    
    const normalized = address.toLowerCase();
    return tokens[normalized] || null;
  }),
  
  getTokenBalance: vi.fn().mockResolvedValue('0'),
  getTradeQuote: vi.fn().mockResolvedValue({
    amountIn: '1000000000000000000',
    amountOut: '2000000000000000000',
    priceImpact: 0.1,
    minimumReceived: '1980000000000000000',
    path: ['0xWBNB', '0xTOKEN']
  })
};

vi.mock('../../services/pancakeswap', () => ({
  PancakeSwapTrader: vi.fn().mockImplementation(() => mockPancakeSwapTrader),
  TokenInfo: {},
  formatNumber: vi.fn().mockImplementation((num: string | number) => {
    const value = typeof num === 'string' ? parseFloat(num) : num;
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
    return value.toFixed(4);
  })
}));