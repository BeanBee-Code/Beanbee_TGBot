import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PriceDeviationChecker } from '@/services/priceDeviation/priceDeviationChecker';
import { pythPriceService } from '@/services/pyth/priceService';
import { pairDiscoveryService } from '@/services/pancakeswap/pairDiscovery';

// Mock dependencies
vi.mock('@/services/pyth/priceService');
vi.mock('@/services/pancakeswap/pairDiscovery');

describe('PriceDeviationChecker', () => {
  const mockTokenAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
  const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkPriceDeviation', () => {
    it('should detect no deviation when prices are close', async () => {
      // Mock Pyth price: $100
      vi.mocked(pythPriceService.fetchPriceByAddress).mockResolvedValue(100);

      // Mock DEX price: $100 (same as Pyth)
      vi.mocked(pairDiscoveryService.discoverTokenPair).mockResolvedValue({
        address: mockTokenAddress,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18,
        totalSupply: '1000000',
        currentPrice: '100',
        allPairs: []
      } as any);

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(false);
      expect(result.deviationPercentage).toBe(0);
      expect(result.riskLevel).toBe('low');
      expect(result.pythPrice).toBe(100);
      expect(result.dexPrice).toBe(100); // 0.25 * 400
    });

    it('should detect medium risk deviation', async () => {
      // Mock Pyth price: $100
      vi.mocked(pythPriceService.fetchPriceByAddress).mockResolvedValue(100);

      // Mock DEX price: $105 (5% deviation)
      vi.mocked(pairDiscoveryService.discoverTokenPair).mockResolvedValue({
        address: mockTokenAddress,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18,
        totalSupply: '1000000',
        currentPrice: '105',
        allPairs: []
      } as any);

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(true);
      expect(result.deviationPercentage).toBeCloseTo(5, 1);
      expect(result.riskLevel).toBe('medium');
      expect(result.message).toContain('Moderate price deviation');
    });

    it('should detect high risk deviation', async () => {
      // Mock Pyth price: $100
      vi.mocked(pythPriceService.fetchPriceByAddress).mockResolvedValue(100);

      // Mock DEX price: $120 (20% deviation)
      vi.mocked(pairDiscoveryService.discoverTokenPair).mockResolvedValue({
        address: mockTokenAddress,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18,
        totalSupply: '1000000',
        currentPrice: '120',
        allPairs: []
      } as any);

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(true);
      expect(result.deviationPercentage).toBeCloseTo(20, 1);
      expect(result.riskLevel).toBe('critical');
      expect(result.message).toContain('CRITICAL PRICE DEVIATION');
    });

    it('should handle missing Pyth price gracefully', async () => {
      vi.mocked(pythPriceService.fetchPriceByAddress).mockResolvedValue(null);
      vi.mocked(pairDiscoveryService.discoverTokenPair).mockResolvedValue({
        address: mockTokenAddress,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18,
        totalSupply: '1000000',
        currentPrice: '100',
        allPairs: []
      } as any);

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(false);
      expect(result.deviationPercentage).toBe(0);
      expect(result.riskLevel).toBe('low');
      expect(result.message).toContain('missing price data');
    });

    it('should handle missing DEX price gracefully', async () => {
      vi.mocked(pythPriceService.fetchPriceByAddress).mockResolvedValue(100);
      vi.mocked(pairDiscoveryService.discoverTokenPair).mockResolvedValue(null);

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(false);
      expect(result.deviationPercentage).toBe(0);
      expect(result.riskLevel).toBe('low');
      expect(result.pythPrice).toBe(100);
      expect(result.dexPrice).toBe(null);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(pythPriceService.fetchPriceByAddress).mockRejectedValue(new Error('API error'));

      const result = await PriceDeviationChecker.checkPriceDeviation(mockTokenAddress);

      expect(result.hasDeviation).toBe(false);
      expect(result.deviationPercentage).toBe(0);
      expect(result.riskLevel).toBe('low');
      expect(result.message).toBe('Price deviation check failed');
    });
  });

  describe('getDeviationRiskScore', () => {
    it('should return 0 for low deviation', () => {
      expect(PriceDeviationChecker.getDeviationRiskScore(2)).toBe(0);
    });

    it('should return -5 for medium deviation', () => {
      expect(PriceDeviationChecker.getDeviationRiskScore(4)).toBe(-5);
    });

    it('should return -15 for high deviation', () => {
      expect(PriceDeviationChecker.getDeviationRiskScore(7)).toBe(-15);
    });

    it('should return -30 for very high deviation', () => {
      expect(PriceDeviationChecker.getDeviationRiskScore(15)).toBe(-30);
    });

    it('should return -50 for extreme deviation', () => {
      expect(PriceDeviationChecker.getDeviationRiskScore(25)).toBe(-50);
    });
  });

  describe('formatDeviationWarning', () => {
    it('should return empty string for no deviation', () => {
      const result = {
        hasDeviation: false,
        deviationPercentage: 0,
        pythPrice: null,
        dexPrice: null,
        riskLevel: 'low' as const,
        message: 'No deviation'
      };

      const warning = PriceDeviationChecker.formatDeviationWarning(result);
      expect(warning).toBe('');
    });

    it('should format critical warning correctly', () => {
      const result = {
        hasDeviation: true,
        deviationPercentage: 25,
        pythPrice: 100,
        dexPrice: 125,
        riskLevel: 'critical' as const,
        message: 'Critical deviation'
      };

      const warning = PriceDeviationChecker.formatDeviationWarning(result);
      expect(warning).toContain('CRITICAL PRICE WARNING');
      expect(warning).toContain('25.00% difference');
      expect(warning).toContain('Oracle Price: $100');
      expect(warning).toContain('DEX Price: $125');
      expect(warning).toContain('STRONGLY RECOMMEND AVOIDING');
    });

    it('should format high risk warning correctly', () => {
      const result = {
        hasDeviation: true,
        deviationPercentage: 8,
        pythPrice: 100,
        dexPrice: 108,
        riskLevel: 'high' as const,
        message: 'High deviation'
      };

      const warning = PriceDeviationChecker.formatDeviationWarning(result);
      expect(warning).toContain('HIGH PRICE DEVIATION');
      expect(warning).toContain('8.00% difference');
      expect(warning).toContain('Higher than expected slippage');
    });

    it('should format medium risk warning correctly', () => {
      const result = {
        hasDeviation: true,
        deviationPercentage: 4,
        pythPrice: 100,
        dexPrice: 104,
        riskLevel: 'medium' as const,
        message: 'Medium deviation'
      };

      const warning = PriceDeviationChecker.formatDeviationWarning(result);
      expect(warning).toContain('Price Deviation Alert');
      expect(warning).toContain('4.00% difference');
    });
  });
});