import { describe, it, expect } from 'vitest';

describe('Trading Calculations', () => {
  describe('calculateSlippage', () => {
    const calculateSlippage = (expectedPrice: number, actualPrice: number): number => {
      if (expectedPrice === 0) return 0;
      return Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
    };

    it('should calculate slippage correctly', () => {
      expect(calculateSlippage(100, 102)).toBeCloseTo(2);
      expect(calculateSlippage(100, 98)).toBeCloseTo(2);
      expect(calculateSlippage(50, 51)).toBeCloseTo(2);
    });

    it('should handle edge cases', () => {
      expect(calculateSlippage(0, 100)).toBe(0);
      expect(calculateSlippage(100, 100)).toBe(0);
    });
  });

  describe('calculatePriceImpact', () => {
    const calculatePriceImpact = (
      inputAmount: number,
      inputReserve: number,
      outputReserve: number
    ): number => {
      const inputAmountWithFee = inputAmount * 0.9975; // 0.25% fee
      const numerator = inputAmountWithFee * outputReserve;
      const denominator = inputReserve + inputAmountWithFee;
      const outputAmount = numerator / denominator;
      
      const spotPrice = outputReserve / inputReserve;
      const executionPrice = outputAmount / inputAmount;
      
      return ((spotPrice - executionPrice) / spotPrice) * 100;
    };

    it('should calculate price impact for small trades', () => {
      const impact = calculatePriceImpact(100, 1000000, 2000000);
      expect(impact).toBeCloseTo(0.25, 1); // Should be close to fee percentage
    });

    it('should calculate higher impact for large trades', () => {
      const impact = calculatePriceImpact(100000, 1000000, 2000000);
      expect(impact).toBeGreaterThan(5);
    });
  });

  describe('calculateMinimumReceived', () => {
    const calculateMinimumReceived = (
      expectedAmount: number,
      slippageTolerance: number
    ): number => {
      return expectedAmount * (1 - slippageTolerance / 100);
    };

    it('should calculate minimum received correctly', () => {
      expect(calculateMinimumReceived(1000, 1)).toBe(990);
      expect(calculateMinimumReceived(500, 0.5)).toBe(497.5);
      expect(calculateMinimumReceived(100, 5)).toBe(95);
    });

    it('should handle zero slippage', () => {
      expect(calculateMinimumReceived(1000, 0)).toBe(1000);
    });
  });

  describe('calculateGasPrice', () => {
    const calculateGasPrice = (baseFee: number, priorityFee: number): number => {
      return baseFee + priorityFee;
    };

    it('should calculate gas price correctly', () => {
      expect(calculateGasPrice(5, 2)).toBe(7);
      expect(calculateGasPrice(3, 1)).toBe(4);
    });
  });

  describe('isValidTokenPair', () => {
    const isValidTokenPair = (tokenA: string, tokenB: string): boolean => {
      return tokenA !== tokenB && 
             tokenA.toLowerCase() !== tokenB.toLowerCase() &&
             tokenA.startsWith('0x') && 
             tokenB.startsWith('0x') &&
             tokenA.length === 42 &&
             tokenB.length === 42;
    };

    it('should validate token pairs', () => {
      const tokenA = '0x1234567890123456789012345678901234567890';
      const tokenB = '0x0987654321098765432109876543210987654321';
      
      expect(isValidTokenPair(tokenA, tokenB)).toBe(true);
    });

    it('should reject invalid pairs', () => {
      const token = '0x1234567890123456789012345678901234567890';
      
      expect(isValidTokenPair(token, token)).toBe(false);
      expect(isValidTokenPair('invalid', token)).toBe(false);
      expect(isValidTokenPair(token, '0x123')).toBe(false);
    });
  });
});