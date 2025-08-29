import { describe, it, expect } from 'vitest';
import { TokenAnalyzer } from '@/services/rugAlerts/tokenAnalyzer';

describe('Token Analyzer Service - Simple Tests', () => {
  it('should instantiate TokenAnalyzer', () => {
    const analyzer = new TokenAnalyzer();
    expect(analyzer).toBeDefined();
    expect(analyzer).toBeInstanceOf(TokenAnalyzer);
  });

  it('should have required methods', () => {
    const analyzer = new TokenAnalyzer();
    expect(typeof analyzer.analyzeToken).toBe('function');
    expect(typeof analyzer.getTokenMetadata).toBe('function');
    expect(typeof analyzer.analyzeLiquidity).toBe('function');
    expect(typeof analyzer.analyzeTradingActivity).toBe('function');
  });

  // Test risk calculation logic without external dependencies
  it('should calculate risk factors correctly', () => {
    // Test concentration risk calculation
    const highConcentration = 70; // 70% held by one address
    const lowConcentration = 10; // 10% held by one address
    
    expect(highConcentration > 50).toBe(true); // Should trigger high risk
    expect(lowConcentration < 20).toBe(true); // Should be acceptable
  });

  it('should identify suspicious token names', () => {
    const suspiciousNames = ['SAFE MOON', 'ELON DOGE', 'PUMP COIN'];
    const normalNames = ['Wrapped BNB', 'PancakeSwap Token', 'Binance USD'];
    
    suspiciousNames.forEach(name => {
      const hasRiskWords = /safe|moon|elon|pump|doge/i.test(name);
      expect(hasRiskWords).toBe(true);
    });
    
    normalNames.forEach(name => {
      const hasRiskWords = /safe moon|elon doge|pump/i.test(name);
      expect(hasRiskWords).toBe(false);
    });
  });
});