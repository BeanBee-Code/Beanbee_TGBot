/**
 * Common BEP-20 tokens on BSC
 */

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  emoji?: string;
}

/**
 * Common tokens available for transfer
 */
export const COMMON_TOKENS: Record<string, TokenInfo> = {
  BNB: {
    address: '0x0000000000000000000000000000000000000000', // Native BNB (special case)
    symbol: 'BNB',
    name: 'BNB',
    decimals: 18,
    emoji: '💎'
  },
  USDT: {
    address: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 18,
    emoji: '💵'
  },
  USDC: {
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    emoji: '💵'
  },
  BUSD: {
    address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    symbol: 'BUSD',
    name: 'Binance USD',
    decimals: 18,
    emoji: '💵'
  },
  CAKE: {
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    symbol: 'CAKE',
    name: 'PancakeSwap Token',
    decimals: 18,
    emoji: '🥞'
  }
};

/**
 * Get token info by symbol
 */
export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
  return COMMON_TOKENS[symbol.toUpperCase()];
}

/**
 * Get token info by address (case-insensitive)
 */
export function getTokenByAddress(address: string): TokenInfo | undefined {
  const lowerAddress = address.toLowerCase();
  return Object.values(COMMON_TOKENS).find(
    token => token.address.toLowerCase() === lowerAddress
  );
}

/**
 * Check if token is native BNB
 */
export function isNativeBNB(tokenAddress: string): boolean {
  return tokenAddress === '0x0000000000000000000000000000000000000000' ||
         tokenAddress.toLowerCase() === 'bnb';
}

/**
 * Get list of common tokens for display
 */
export function getCommonTokensList(): TokenInfo[] {
  return Object.values(COMMON_TOKENS);
}
