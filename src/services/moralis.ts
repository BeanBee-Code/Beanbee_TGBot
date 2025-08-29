import Moralis from 'moralis';
import { createLogger } from '../utils/logger';

const logger = createLogger('moralis');

export interface TokenAnalytics {
	tokenAddress: string;
	totalBuyVolume: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	totalSellVolume: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	totalBuyers: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	totalSellers: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	totalBuys: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	totalSells: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	uniqueWallets: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	pricePercentChange: {
		'5m': number;
		'1h': number;
		'6h': number;
		'24h': number;
	};
	usdPrice: string;
	totalLiquidityUsd: string;
	totalFullyDilutedValuation: string;
}

export interface TokenAnalyticsResponse {
	tokens: TokenAnalytics[];
}

export async function initMoralis() {
	try {
		await Moralis.start({
			apiKey: process.env.MORALIS_API_KEY!,
		});
		logger.info('✅ Moralis initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize Moralis', error);
		throw error;
	}
}

// Single token analytics endpoint (works with free tier)
export async function getSingleTokenAnalytics(tokenAddress: string, chain: string = '0x38'): Promise<TokenAnalytics | null> {
	try {
		const response = await fetch(`https://deep-index.moralis.io/api/v2.2/tokens/${tokenAddress}/analytics?chain=${chain}`, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'X-API-Key': process.env.MORALIS_API_KEY!
			}
		});

		if (!response.ok) {
			if (response.status === 404) {
				logger.warn('Token analytics not found', { tokenAddress });
				return null; // Token not found in analytics
			}
			let errorDetails = '';
			try {
				const errorData = await response.json();
				errorDetails = JSON.stringify(errorData);
			} catch {
				errorDetails = await response.text();
			}
			throw new Error(`Moralis Token Analytics API error: ${response.status} ${response.statusText}. Details: ${errorDetails}`);
		}

		const data = await response.json();
		logger.debug('Single token analytics fetched', { tokenAddress, hasData: !!data });
		
		return data;
	} catch (error) {
		logger.error('Error fetching single token analytics', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

// Batch analytics using individual calls (works with free tier)
export async function getMultipleTokenAnalytics(tokenAddresses: string[], chain: string = '0x38'): Promise<TokenAnalyticsResponse> {
	try {
		const results: TokenAnalytics[] = [];
		const BATCH_SIZE = 5; // Smaller batches to avoid rate limits
		const DELAY_MS = 200; // 200ms delay between requests
		
		for (let i = 0; i < tokenAddresses.length; i += BATCH_SIZE) {
			const batch = tokenAddresses.slice(i, i + BATCH_SIZE);
			
			const batchPromises = batch.map(async (tokenAddress) => {
				const analytics = await getSingleTokenAnalytics(tokenAddress, chain);
				return analytics;
			});
			
			const batchResults = await Promise.all(batchPromises);
			const validResults = batchResults.filter((result): result is TokenAnalytics => result !== null);
			results.push(...validResults);
			
			// Add delay between batches to avoid rate limiting
			if (i + BATCH_SIZE < tokenAddresses.length) {
				await new Promise(resolve => setTimeout(resolve, DELAY_MS));
			}
		}
		
		logger.info('Multiple token analytics fetched', { 
			requestedTokens: tokenAddresses.length, 
			receivedTokens: results.length 
		});
		
		return { tokens: results };
	} catch (error) {
		logger.error('Error fetching multiple token analytics', { tokenAddresses, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

export function hasValidLiquidity(analytics: TokenAnalytics, minLiquidityUsd: number = 1000): boolean {
	const liquidityUsd = parseFloat(analytics.totalLiquidityUsd);
	const has24hActivity = analytics.totalBuys['24h'] > 0 || analytics.totalSells['24h'] > 0;
	const hasUniqueWallets = analytics.uniqueWallets['24h'] > 1;
	
	return liquidityUsd >= minLiquidityUsd && has24hActivity && hasUniqueWallets;
}

// Fallback liquidity check using basic token metadata
export async function getTokenMetadata(tokenAddress: string, chain: string = '0x38') {
	try {
		const response = await fetch(`https://deep-index.moralis.io/api/v2/${tokenAddress}/metadata?chain=${chain}`, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'X-API-Key': process.env.MORALIS_API_KEY!
			}
		});

		if (!response.ok) {
			throw new Error(`Moralis Token Metadata API error: ${response.status} ${response.statusText}`);
		}

		return await response.json();
	} catch (error) {
		logger.error('Error fetching token metadata', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

// Fallback method to check basic token validity using price API
export async function getTokenPrice(tokenAddress: string, chain: string = '0x38') {
	try {
		const response = await fetch(`https://deep-index.moralis.io/api/v2/erc20/${tokenAddress}/price?chain=${chain}`, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'X-API-Key': process.env.MORALIS_API_KEY!
			}
		});

		if (!response.ok) {
			return null; // Token might not have price data
		}

		return await response.json();
	} catch (error) {
		logger.warn('Error fetching token price', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

// Simplified liquidity check using available APIs
export async function hasBasicTokenValidity(tokenAddress: string, chain: string = '0x38'): Promise<boolean> {
	try {
		// Try to get price data - if a token has reliable price data, it's likely legitimate
		const priceData = await getTokenPrice(tokenAddress, chain);
		
		// If we can get price data and the token has a USD price, consider it valid
		if (priceData && priceData.usdPrice && parseFloat(priceData.usdPrice) > 0) {
			return true;
		}
		
		// Fallback: check if we can get basic metadata
		const metadata = await getTokenMetadata(tokenAddress, chain);
		return metadata && metadata.symbol && metadata.name;
	} catch (error) {
		logger.warn('Error checking token validity', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
		return true; // Default to including the token if we can't verify
	}
}