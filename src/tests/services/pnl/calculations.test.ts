import { describe, it, expect } from 'vitest';

describe('PNL Calculations', () => {
  interface Trade {
    type: 'buy' | 'sell';
    amount: number;
    price: number;
    timestamp: number;
  }

  describe('calculatePNL', () => {
    const calculatePNL = (trades: Trade[], currentPrice: number): {
      realized: number;
      unrealized: number;
      total: number;
      position: number;
    } => {
      let position = 0;
      let totalCost = 0;
      let realizedPNL = 0;

      for (const trade of trades) {
        if (trade.type === 'buy') {
          position += trade.amount;
          totalCost += trade.amount * trade.price;
        } else {
          const costBasis = position > 0 ? totalCost / position : 0;
          const proceeds = trade.amount * trade.price;
          const cost = trade.amount * costBasis;
          realizedPNL += proceeds - cost;
          
          position -= trade.amount;
          totalCost -= cost;
        }
      }

      const unrealizedPNL = position > 0 ? (position * currentPrice) - totalCost : 0;
      
      return {
        realized: realizedPNL,
        unrealized: unrealizedPNL,
        total: realizedPNL + unrealizedPNL,
        position
      };
    };

    it('should calculate PNL for simple buy and sell', () => {
      const trades: Trade[] = [
        { type: 'buy', amount: 100, price: 10, timestamp: 1 },
        { type: 'sell', amount: 50, price: 15, timestamp: 2 }
      ];
      
      const result = calculatePNL(trades, 20);
      
      expect(result.realized).toBe(250); // 50 * (15 - 10)
      expect(result.unrealized).toBe(500); // 50 * (20 - 10)
      expect(result.total).toBe(750);
      expect(result.position).toBe(50);
    });

    it('should handle multiple trades', () => {
      const trades: Trade[] = [
        { type: 'buy', amount: 100, price: 10, timestamp: 1 },
        { type: 'buy', amount: 50, price: 12, timestamp: 2 },
        { type: 'sell', amount: 75, price: 15, timestamp: 3 }
      ];
      
      const result = calculatePNL(trades, 18);
      
      // Average cost basis: (100*10 + 50*12) / 150 = 10.67
      // Realized: 75 * (15 - 10.67) = 324.75
      expect(result.realized).toBeCloseTo(325, 0);
      expect(result.position).toBe(75);
    });

    it('should handle complete exit', () => {
      const trades: Trade[] = [
        { type: 'buy', amount: 100, price: 10, timestamp: 1 },
        { type: 'sell', amount: 100, price: 15, timestamp: 2 }
      ];
      
      const result = calculatePNL(trades, 20);
      
      expect(result.realized).toBe(500);
      expect(result.unrealized).toBe(0);
      expect(result.position).toBe(0);
    });
  });

  describe('calculateROI', () => {
    const calculateROI = (initialValue: number, currentValue: number): number => {
      if (initialValue === 0) return 0;
      return ((currentValue - initialValue) / initialValue) * 100;
    };

    it('should calculate positive ROI', () => {
      expect(calculateROI(1000, 1500)).toBe(50);
      expect(calculateROI(500, 600)).toBe(20);
    });

    it('should calculate negative ROI', () => {
      expect(calculateROI(1000, 800)).toBe(-20);
      expect(calculateROI(500, 250)).toBe(-50);
    });

    it('should handle edge cases', () => {
      expect(calculateROI(0, 1000)).toBe(0);
      expect(calculateROI(1000, 1000)).toBe(0);
    });
  });

  describe('calculateAverageBuyPrice', () => {
    const calculateAverageBuyPrice = (trades: Trade[]): number => {
      let totalAmount = 0;
      let totalCost = 0;

      for (const trade of trades) {
        if (trade.type === 'buy') {
          totalAmount += trade.amount;
          totalCost += trade.amount * trade.price;
        }
      }

      return totalAmount > 0 ? totalCost / totalAmount : 0;
    };

    it('should calculate average buy price', () => {
      const trades: Trade[] = [
        { type: 'buy', amount: 100, price: 10, timestamp: 1 },
        { type: 'buy', amount: 200, price: 15, timestamp: 2 },
        { type: 'sell', amount: 50, price: 20, timestamp: 3 }
      ];
      
      // (100*10 + 200*15) / 300 = 13.33
      expect(calculateAverageBuyPrice(trades)).toBeCloseTo(13.33, 2);
    });

    it('should ignore sell trades', () => {
      const trades: Trade[] = [
        { type: 'buy', amount: 100, price: 10, timestamp: 1 },
        { type: 'sell', amount: 100, price: 20, timestamp: 2 }
      ];
      
      expect(calculateAverageBuyPrice(trades)).toBe(10);
    });
  });
});