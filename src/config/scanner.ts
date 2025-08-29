export interface ScannerConfig {
	// Token filtering thresholds
	minUsdValue: number;
	minLiquidityUsd: number;
	maxTokensPerRequest: number;
	maxTokensPerMultiWalletRequest: number;
	
	// Rate limiting
	batchSize: number;
	delayBetweenBatchesMs: number;
	
	// Analytics options
	enableLiquidityFilter: boolean;
	usePremiumAnalytics: boolean;
	require24hActivity: boolean;
	requireUniqueWallets: boolean;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
	// Token filtering thresholds
	minUsdValue: parseFloat(process.env.MIN_TOKEN_USD_VALUE || '0.01'),
	minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '1000'),
	maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_PER_REQUEST || '50'),
	maxTokensPerMultiWalletRequest: parseInt(process.env.MAX_TOKENS_PER_MULTI_WALLET_REQUEST || '30'),
	
	// Rate limiting
	batchSize: parseInt(process.env.TOKEN_BATCH_SIZE || '10'),
	delayBetweenBatchesMs: parseInt(process.env.DELAY_BETWEEN_BATCHES_MS || '100'),
	
	// Analytics options
	enableLiquidityFilter: process.env.ENABLE_LIQUIDITY_FILTER !== 'false',
	usePremiumAnalytics: false, // Single token analytics work with free tier
	require24hActivity: process.env.REQUIRE_24H_ACTIVITY !== 'false',
	requireUniqueWallets: process.env.REQUIRE_UNIQUE_WALLETS !== 'false'
};

export function getScannerConfig(): ScannerConfig {
	return DEFAULT_SCANNER_CONFIG;
}