import { describe, it, expect } from 'vitest';

// Test utility functions that don't depend on database
describe('Formatter Utilities', () => {
  describe('formatTokenAmount', () => {
    const formatTokenAmount = (amount: string, decimals: number): string => {
      const divisor = BigInt(10) ** BigInt(decimals);
      const value = BigInt(amount) / divisor;
      return value.toString();
    };

    it('should format token amounts correctly', () => {
      expect(formatTokenAmount('1000000000000000000', 18)).toBe('1');
      expect(formatTokenAmount('500000000000000000', 18)).toBe('0');
      expect(formatTokenAmount('1500000000000000000', 18)).toBe('1');
    });

    it('should handle different decimals', () => {
      expect(formatTokenAmount('1000000', 6)).toBe('1');
      expect(formatTokenAmount('1000000000', 9)).toBe('1');
    });
  });

  describe('formatUSD', () => {
    const formatUSD = (value: number): string => {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(value);
    };

    it('should format USD values correctly', () => {
      expect(formatUSD(1000)).toBe('$1,000');
      expect(formatUSD(1234.56)).toBe('$1,234.56');
      expect(formatUSD(0.99)).toBe('$0.99');
      expect(formatUSD(0)).toBe('$0');
    });
  });

  describe('shortenAddress', () => {
    const shortenAddress = (address: string): string => {
      if (!address || address.length < 10) return address;
      return `${address.slice(0, 6)}...${address.slice(-4)}`;
    };

    it('should shorten wallet addresses', () => {
      const address = '0x1234567890123456789012345678901234567890';
      expect(shortenAddress(address)).toBe('0x1234...7890');
    });

    it('should handle invalid addresses', () => {
      expect(shortenAddress('')).toBe('');
      expect(shortenAddress('0x123')).toBe('0x123');
    });
  });

  describe('calculatePercentage', () => {
    const calculatePercentage = (value: number, total: number): number => {
      if (total === 0) return 0;
      return (value / total) * 100;
    };

    it('should calculate percentages correctly', () => {
      expect(calculatePercentage(50, 100)).toBe(50);
      expect(calculatePercentage(25, 200)).toBe(12.5);
      expect(calculatePercentage(100, 100)).toBe(100);
    });

    it('should handle edge cases', () => {
      expect(calculatePercentage(0, 100)).toBe(0);
      expect(calculatePercentage(50, 0)).toBe(0);
    });
  });
});