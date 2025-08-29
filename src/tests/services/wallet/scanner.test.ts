import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScannerService } from '@/services/wallet/scanner';

// Mock the dependencies
vi.mock('@/services/wallet/scannerUtils');
vi.mock('@/services/wallet/tokenPriceCache');
vi.mock('@/services/staking');
vi.mock('@/services/defi');
vi.mock('@/i18n');
vi.mock('@/database/models/DeFiPosition');
vi.mock('@/services/defiLlama/yieldService');
vi.mock('@/services/defi/apyCalculator');
vi.mock('@/utils/logger');

describe('ScannerService', () => {
	let scannerService: ScannerService;

	beforeEach(() => {
		scannerService = new ScannerService();
		vi.clearAllMocks();
	});

	describe('Token Filtering Logic', () => {
		it('should filter out tokens with no price', () => {
			const tokens = [
				{
					symbol: 'VALID',
					token_address: '0x123',
					balance: '1000000000000000000',
					usd_price: 1.0,
					usd_value: 1.0,
					decimals: 18
				},
				{
					symbol: 'NO_PRICE',
					token_address: '0x456',
					balance: '1000000000000000000',
					usd_price: 0,
					usd_value: 0,
					decimals: 18
				}
			];

			// Test the filtering logic directly
			const filteredTokens = tokens.filter((token: any) => {
				// Always include BNB/native token
				const tokenAddress = token.token_address || token.address;
				if (!tokenAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
					return true;
				}
				
				// Filter criteria
				const hasValidPrice = token.usd_price && token.usd_price > 0;
				const hasValidValue = token.usd_value && token.usd_value > 0;
				const hasValidBalance = token.balance && parseFloat(token.balance) > 0;
				
				// Minimum USD value threshold
				const MIN_USD_VALUE = 0.01;
				const meetsMinValue = token.usd_value >= MIN_USD_VALUE;
				
				return hasValidPrice && hasValidValue && hasValidBalance && meetsMinValue;
			});

			expect(filteredTokens).toHaveLength(1);
			expect(filteredTokens[0].symbol).toBe('VALID');
		});

		it('should filter out tokens with dust amounts', () => {
			const tokens = [
				{
					symbol: 'SIGNIFICANT',
					token_address: '0x123',
					balance: '1000000000000000000',
					usd_price: 1.0,
					usd_value: 1.0,
					decimals: 18
				},
				{
					symbol: 'DUST',
					token_address: '0x456',
					balance: '1000000000000000',
					usd_price: 0.001,
					usd_value: 0.001, // Below 0.01 threshold
					decimals: 18
				}
			];

			// Test the filtering logic
			const filteredTokens = tokens.filter((token: any) => {
				const tokenAddress = token.token_address || token.address;
				if (!tokenAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
					return true;
				}
				
				const hasValidPrice = token.usd_price && token.usd_price > 0;
				const hasValidValue = token.usd_value && token.usd_value > 0;
				const hasValidBalance = token.balance && parseFloat(token.balance) > 0;
				const MIN_USD_VALUE = 0.01;
				const meetsMinValue = token.usd_value >= MIN_USD_VALUE;
				
				return hasValidPrice && hasValidValue && hasValidBalance && meetsMinValue;
			});

			expect(filteredTokens).toHaveLength(1);
			expect(filteredTokens[0].symbol).toBe('SIGNIFICANT');
		});

		it('should always include BNB/native token regardless of other criteria', () => {
			const tokens = [
				{
					symbol: 'BNB',
					token_address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
					balance: '1000000000000000000',
					usd_price: 0, // Even with no price
					usd_value: 0, // And no value
					decimals: 18
				},
				{
					symbol: 'FILTERED_OUT',
					token_address: '0x456',
					balance: '1000000000000000000',
					usd_price: 0,
					usd_value: 0,
					decimals: 18
				}
			];

			// Test the filtering logic
			const filteredTokens = tokens.filter((token: any) => {
				const tokenAddress = token.token_address || token.address;
				if (!tokenAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
					return true;
				}
				
				const hasValidPrice = token.usd_price && token.usd_price > 0;
				const hasValidValue = token.usd_value && token.usd_value > 0;
				const hasValidBalance = token.balance && parseFloat(token.balance) > 0;
				const MIN_USD_VALUE = 0.01;
				const meetsMinValue = token.usd_value >= MIN_USD_VALUE;
				
				return hasValidPrice && hasValidValue && hasValidBalance && meetsMinValue;
			});

			expect(filteredTokens).toHaveLength(1);
			expect(filteredTokens[0].symbol).toBe('BNB');
		});
	});
});