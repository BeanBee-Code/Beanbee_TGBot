import { vi } from 'vitest';

export const mockTokenAnalysis = {
  metadata: {
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    name: 'PancakeSwap Token',
    symbol: 'CAKE',
    decimals: 18,
    totalSupply: '1000000000000000000000000',
    verified: true,
    renounced: true,
    createdAt: new Date('2020-09-29')
  },
  holderAnalysis: {
    totalHolders: 1000,
    top10Holders: [],
    top10Concentration: 15,
    top10ConcentrationExcludingLP: 10,
    riskLevel: 'LOW',
    riskFactors: []
  },
  liquidityAnalysis: {
    hasLiquidity: true,
    liquidityUSD: 1000000,
    liquidityBNB: 2000,
    lpTokenBurned: true,
    lpTokenLocked: false
  },
  tradingActivity: {
    volume24h: 500000,
    txCount24h: 1000,
    hasActiveTrading: true
  },
  honeypotAnalysis: {
    isHoneypot: false,
    sellTax: 0,
    buyTax: 0
  },
  safetyScore: 85,
  safetyScoreDetails: {
    holders: 12,
    liquidity: 25,
    verification: 10,
    trading: 10,
    ownership: 10,
    age: 10,
    honeypot: 15,
    diamondHands: 3
  },
  recommendations: ['Safe to trade', 'Good liquidity', 'Verified contract']
};

export const mockAnalyzeToken = vi.fn();

export const MockTokenAnalyzer = vi.fn().mockImplementation(() => ({
  analyzeToken: mockAnalyzeToken
}));

vi.mock('@/services/rugAlerts/tokenAnalyzer', () => ({
  TokenAnalyzer: MockTokenAnalyzer
}));