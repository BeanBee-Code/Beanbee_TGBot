import { Context } from 'telegraf';
import { getWalletTokensWithPrices, formatTokenBalance } from './scannerUtils';
import { getCachedTokenPrice, getBNBPrice } from './tokenPriceCache';
import { detectStakingPositions, isStakingToken, getStakingTokenInfo } from '../staking';
import { getDeFiPositions, formatDeFiPositions } from '../defi';
import { getTranslation, getUserLanguage, t, Language } from '@/i18n';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import { getAPYsForDeFiPositions } from '@/services/defiLlama/yieldService';
import { getEnhancedAPYForPositions } from '@/services/defi/apyCalculator';
import { createLogger } from '@/utils/logger';
import { TokenSearchService } from '../tokenSearch';
import { getScannerConfig } from '@/config/scanner';
import { DeadTokenModel } from '@/database/models/DeadToken';
import { formatUSDValue, formatUSDValueWithSubscript } from './balance';
import { hapiAddressRiskService } from '@/services/hapiLabs/addressRisk';

const logger = createLogger('wallet.scanner');

// Helper function to store dead tokens - exported for use in TradingService
export async function storeDeadToken(
	tokenAddress: string, 
	symbol: string, 
	name: string, 
	reason: 'no_liquidity' | 'no_activity' | 'no_analytics' | 'invalid_metadata',
	analytics?: any,
	chain: string = '0x38'
) {
	try {
		const existingDeadToken = await DeadTokenModel.findOne({
			tokenAddress: tokenAddress.toLowerCase(),
			chain
		});

		if (existingDeadToken) {
			// Update existing record
			await DeadTokenModel.updateOne(
				{ _id: existingDeadToken._id },
				{
					$set: {
						lastCheckedAt: new Date(),
						analytics: analytics ? {
							totalLiquidityUsd: analytics.totalLiquidityUsd || '0',
							totalBuys24h: analytics.totalBuys?.['24h'] || 0,
							totalSells24h: analytics.totalSells?.['24h'] || 0,
							uniqueWallets24h: analytics.uniqueWallets?.['24h'] || 0,
							usdPrice: analytics.usdPrice || '0'
						} : undefined
					},
					$inc: { detectionCount: 1 }
				}
			);
			logger.debug('Updated existing dead token record', { tokenAddress, symbol, reason });
		} else {
			// Create new record
			await DeadTokenModel.create({
				tokenAddress: tokenAddress.toLowerCase(),
				chain,
				symbol: symbol || 'Unknown',
				name: name || 'Unknown Token',
				reason,
				analytics: analytics ? {
					totalLiquidityUsd: analytics.totalLiquidityUsd || '0',
					totalBuys24h: analytics.totalBuys?.['24h'] || 0,
					totalSells24h: analytics.totalSells?.['24h'] || 0,
					uniqueWallets24h: analytics.uniqueWallets?.['24h'] || 0,
					usdPrice: analytics.usdPrice || '0'
				} : undefined,
				detectedAt: new Date(),
				lastCheckedAt: new Date()
			});
			logger.info('Stored new dead token', { tokenAddress, symbol, reason });
		}
	} catch (error) {
		logger.error('Error storing dead token', { 
			tokenAddress, 
			symbol, 
			reason, 
			error: error instanceof Error ? error.message : String(error) 
		});
	}
}

// Helper function to check if token is already known to be dead - exported for use in TradingService
export async function isKnownDeadToken(tokenAddress: string, chain: string = '0x38'): Promise<boolean> {
	try {
		const deadToken = await DeadTokenModel.findOne({
			tokenAddress: tokenAddress.toLowerCase(),
			chain,
			isActive: true
		});
		
		if (deadToken) {
			// Update last checked timestamp
			await DeadTokenModel.updateOne(
				{ _id: deadToken._id },
				{ $set: { lastCheckedAt: new Date() }, $inc: { detectionCount: 1 } }
			);
			return true;
		}
		return false;
	} catch (error) {
		logger.error('Error checking dead token cache', { 
			tokenAddress, 
			error: error instanceof Error ? error.message : String(error) 
		});
		return false; // Default to not dead if we can't check
	}
}

export class ScannerService {
	private tokenSearch: TokenSearchService;

	constructor() {
		this.tokenSearch = new TokenSearchService(process.env.MORALIS_API_KEY);
	}
	/**
	 * Unified token filtering function that uses DexScreener-based data for consistency.
	 * First checks the DeadTokenModel database to avoid unnecessary API calls,
	 * then uses TokenSearchService (DexScreener) for remaining tokens.
	 */
	private async _filterTokensByLiquidityAndActivity(tokens: any[]): Promise<any[]> {
		const config = getScannerConfig();
		logger.info('Starting DexScreener-based token filtering...', { initialCount: tokens.length });

		// 1. Separate BNB/native token, as it should always be included.
		const nativeToken = tokens.find(
			(token: any) => (token.token_address || token.address)?.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
		);
		const regularTokens = tokens.filter(token => token !== nativeToken);

		if (regularTokens.length === 0) {
			return nativeToken ? [nativeToken] : [];
		}

		const tokenAddressesToCheck = regularTokens.map((token: any) => (token.token_address || token.address).toLowerCase());

		// 2. Check against our DeadTokenModel database first to save API calls.
		const knownDeadTokens = await DeadTokenModel.find({ 
			tokenAddress: { $in: tokenAddressesToCheck },
			isActive: true 
		});
		const knownDeadTokenAddresses = new Set(knownDeadTokens.map(t => t.tokenAddress));
		logger.info(`Found ${knownDeadTokenAddresses.size} known dead tokens in DB.`, { symbols: knownDeadTokens.map(t => t.symbol) });

		const tokensToAnalyze = regularTokens.filter((token: any) => 
			!knownDeadTokenAddresses.has((token.token_address || token.address).toLowerCase())
		);

		if (tokensToAnalyze.length === 0) {
			logger.info('All non-native tokens were filtered out by the dead token cache.');
			return nativeToken ? [nativeToken] : [];
		}

		// 3. For the remaining tokens, fetch data using TokenSearchService (DexScreener).
		logger.info(`Fetching token details for ${tokensToAnalyze.length} remaining tokens via DexScreener.`);
		
		const BATCH_SIZE = 10;
		const DELAY_MS = 200;
		const validTokens: any[] = [];

		for (let i = 0; i < tokensToAnalyze.length; i += BATCH_SIZE) {
			const batch = tokensToAnalyze.slice(i, i + BATCH_SIZE);
			const promises = batch.map(async (token) => {
				const tokenAddress = (token.token_address || token.address).toLowerCase();
				try {
					const tokenDetails = await this.tokenSearch.getTokenByAddress(tokenAddress);

					// Validate token using marketCap or volume24h as liquidity indicators
					const estimatedLiquidity = tokenDetails?.marketCap ? (tokenDetails.marketCap / 2) : (tokenDetails?.volume24h || 0);

					if (tokenDetails && estimatedLiquidity >= config.minLiquidityUsd) {
						// Valid token - update with latest price data
						token.usd_price = tokenDetails.price || token.usd_price;
						token.usd_value = token.usd_price * (parseFloat(token.balance) / Math.pow(10, token.decimals || 18));
						validTokens.push(token);
					} else {
						// Invalid token - store as dead token
						await storeDeadToken(
							tokenAddress,
							token.symbol || tokenDetails?.symbol || 'Unknown',
							token.name || tokenDetails?.name || 'Unknown Token',
							'no_liquidity'
						);
					}
				} catch (error) {
					logger.warn('Error fetching token details', { tokenAddress, error: error instanceof Error ? error.message : String(error) });
					// Store as dead token on error
					await storeDeadToken(
						tokenAddress,
						token.symbol || 'Unknown',
						token.name || 'Unknown Token',
						'no_analytics'
					);
				}
			});

			await Promise.all(promises);

			if (i + BATCH_SIZE < tokensToAnalyze.length) {
				await new Promise(resolve => setTimeout(resolve, DELAY_MS));
			}
		}

		logger.info('DexScreener-based filtering complete.', { 
			finalCount: validTokens.length, 
			removedCount: tokensToAnalyze.length - validTokens.length
		});

		return nativeToken ? [nativeToken, ...validTokens] : validTokens;
	}

	private async fetchOrGetCachedDeFiPositions(
		userId: number,
		walletAddress: string
	): Promise<{
		stakingPositions: any[];
		defiPositions: any[];
		fromCache: boolean;
	}> {
		// Check cache first
		const cachedPosition = await DeFiPosition.findOne({
			userId: userId,
			walletAddress: walletAddress.toLowerCase()
		});
		
		// Cache is considered fresh if it's less than 1 hour old
		const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
		const shouldRefresh = !cachedPosition || 
			(Date.now() - cachedPosition.lastRefreshAt.getTime()) > CACHE_DURATION_MS ||
			!cachedPosition.hasActivePositions;
		
		if (shouldRefresh) {
			logger.info('Cache miss or expired, fetching fresh DeFi positions', { walletAddress });
			// Detect staking positions (includes direct stakes like veCAKE)
			const stakingPositions = await detectStakingPositions(walletAddress);
			
			// Fetch DeFi positions from Moralis
			const defiPositions = await getDeFiPositions(walletAddress);
			
			// Calculate totals
			const totalStakingValue = stakingPositions.reduce((sum, pos) => sum + (pos.usdValue || 0), 0);
			const totalDefiValue = defiPositions.reduce((sum, protocol) => {
				const positionValue = protocol.position.balance_usd || 0;
				const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
				return sum + positionValue + unclaimedValue;
			}, 0);
			
			// Extract protocol names
			const detectedProtocols = [
				...new Set([
					...stakingPositions.map(pos => pos.protocol),
					...defiPositions.map(pos => pos.protocol_name)
				])
			];
			
			// Map DeFi positions to the expected interface structure
			const mappedDeFiPositions = defiPositions.map(protocol => ({
				protocol_name: protocol.protocol_name,
				protocol_id: protocol.protocol_id,
				protocol_url: protocol.protocol_url || '',
				balance_usd: protocol.position?.balance_usd || 0,
				total_unclaimed_usd_value: protocol.position?.total_unclaimed_usd_value || 0,
				tokens: (protocol.position?.tokens || []).map((token: any) => ({
					token_type: token.token_type,
					symbol: token.symbol,
					token_address: token.token_address,
					balance_formatted: token.balance_formatted,
					usd_value: token.usd_value || 0
				})),
				yearly_earnings_usd: protocol.total_projected_earnings_usd?.yearly || 0
			}));
			
			// Fetch APY data from DeFiLlama pools
			const poolApyMap = await getAPYsForDeFiPositions(mappedDeFiPositions);
			
			// Get enhanced APY using multiple data sources
			const enhancedApyMap = await getEnhancedAPYForPositions(mappedDeFiPositions, poolApyMap);
			
			// Add APY data to positions
			const positionsWithAPY = mappedDeFiPositions.map(position => {
				const positionKey = `${position.protocol_name}_${position.protocol_id}`;
				const apyData = enhancedApyMap.get(positionKey);
				return {
					...position,
					apy: apyData?.apy || 0,
					poolId: apyData?.poolId
				};
			});
			
			// Save to cache
			await DeFiPosition.findOneAndUpdate(
				{
					userId: userId,
					walletAddress: walletAddress.toLowerCase()
				},
				{
					defiPositions: positionsWithAPY,
					stakingPositions: stakingPositions,
					totalDefiValue: totalDefiValue,
					totalStakingValue: totalStakingValue,
					lastRefreshAt: new Date(),
					apiCallsSaved: cachedPosition ? cachedPosition.apiCallsSaved : 0,
					detectedProtocols: detectedProtocols,
					hasActivePositions: (totalStakingValue + totalDefiValue) > 0
				},
				{ upsert: true, new: true }
			);
			
			// Return the original defiPositions with APY data added
			const defiPositionsWithAPY = defiPositions.map((protocol, index) => ({
				...protocol,
				apy: positionsWithAPY[index].apy,
				poolId: positionsWithAPY[index].poolId
			}));
			
			return { stakingPositions, defiPositions: defiPositionsWithAPY, fromCache: false };
		} else {
			logger.info('Using cached DeFi positions', { walletAddress });
			
			// Update API calls saved counter
			await DeFiPosition.updateOne(
				{ _id: cachedPosition._id },
				{ $inc: { apiCallsSaved: 2 } }
			);
			
			// Convert cached positions back to Moralis format for multi-wallet processing
			const convertedDefiPositions = (cachedPosition.defiPositions || []).map(pos => ({
				protocol_name: pos.protocol_name,
				protocol_id: pos.protocol_id,
				protocol_url: pos.protocol_url,
				position: {
					balance_usd: pos.balance_usd,
					total_unclaimed_usd_value: pos.total_unclaimed_usd_value,
					tokens: pos.tokens
				},
				total_projected_earnings_usd: {
					yearly: pos.yearly_earnings_usd
				},
				apy: pos.apy,
				poolId: pos.poolId
			}));
			
			return {
				stakingPositions: cachedPosition.stakingPositions || [],
				defiPositions: convertedDefiPositions,
				fromCache: true
			};
		}
	}
	async handleWalletInput(ctx: Context, inputAddress: string) {
		const userId = ctx.from!.id;
		const lang = await getUserLanguage(userId);
		const session = global.userSessions.get(userId);
		if (!session) return;
		session.waitingForWalletInput = false;

		const addressRegex = /^0x[a-fA-F0-9]{40}$/;
		if (!addressRegex.test(inputAddress)) {
			const errorMessage = await getTranslation(ctx, 'scanner.invalidAddress');
			const backButtonText = await getTranslation(ctx, 'common.back');
			await ctx.reply(errorMessage, {
				reply_markup: {
					inline_keyboard: [
						[{ text: backButtonText, callback_data: 'wallet_scan' }]
					]
				}
			});
			return;
		}

		try {
			// Get user's wallet addresses to check if this is their wallet
			const { UserService } = await import('../user');
			const userWalletAddress = session.address;
			const userTradingWalletAddress = await UserService.getTradingWalletAddress(userId);

			// Check if the scanned address belongs to the user
			const isUserWallet =
				inputAddress.toLowerCase() === userWalletAddress?.toLowerCase() ||
				inputAddress.toLowerCase() === userTradingWalletAddress?.toLowerCase();

			await ctx.reply(await getTranslation(ctx, 'scanner.scanning'));

		// Check address risk in parallel with token fetch using allSettled to handle failures gracefully
		const [tokensResult, addressRiskResult] = await Promise.allSettled([
			getWalletTokensWithPrices(inputAddress),
			hapiAddressRiskService.checkAddressRisk(inputAddress, 'bsc')
		]);

		// Extract address risk data if available
		const addressRisk = addressRiskResult.status === 'fulfilled'
			? addressRiskResult.value
			: { hasData: false, risk: 0, riskLevel: 'SAFE' as const, category: 'Unknown', scamfari: false, riskDescriptionHeader: '', riskDescription: '', isSafe: true, isModerate: false, isRisky: false, address: inputAddress, network: 'bsc' };

		// If token fetch failed, show address risk warning and error
		if (tokensResult.status === 'rejected') {
			let errorMessage = await getTranslation(ctx, 'scanner.errorScanning') + '\n';
			errorMessage += await getTranslation(ctx, 'scanner.errorDetail') + ' ' + (tokensResult.reason?.message || String(tokensResult.reason)) + '\n';

			// But still show address risk warning if it's risky!
			if (addressRisk.hasData && addressRisk.risk >= 7) {
				const riskEmoji = hapiAddressRiskService.getRiskEmoji(addressRisk.riskLevel);
				errorMessage += `\n🚨 *CRITICAL SECURITY WARNING (HAPI Labs)*\n`;
				errorMessage += `${riskEmoji} This address has a ${addressRisk.riskLevel} RISK score (${addressRisk.risk}/10)\n`;
				errorMessage += `⚠️ Category: ${addressRisk.category}\n`;
				if (addressRisk.riskDescription) {
					errorMessage += `${addressRisk.riskDescription}\n`;
				}
				errorMessage += `\n⚠️ *Exercise extreme caution with this address!*\n`;
			} else if (addressRisk.hasData && addressRisk.risk >= 4) {
				const compactDisplay = hapiAddressRiskService.getCompactDisplay(addressRisk);
				errorMessage += `\n🛡️ *Address Security:* ${compactDisplay} (HAPI Labs)\n`;
			}

			await ctx.reply(errorMessage, { parse_mode: 'Markdown' });
			return;
		}

		// Extract tokens data
		const tokensData = tokensResult.value;
		let tokens: any[] = [];
		if (Array.isArray(tokensData)) {
			tokens = tokensData;
		} else if (Array.isArray((tokensData as any).result)) {
			tokens = (tokensData as any).result;
		} else {
			tokens = [];
		}

		if (!tokens || tokens.length === 0) {
			await ctx.reply(await getTranslation(ctx, 'scanner.noTokensFound'), { parse_mode: 'Markdown' });
			return;
		}
			
			// Debug info
			logger.info('Token scan results', { totalTokens: tokens.length });
			const tokensWithValue = tokens.filter((t: any) => t.usd_value && t.usd_value > 0);
			logger.info('Tokens with USD value', { count: tokensWithValue.length });
			logger.info('Tokens without USD value', { count: tokens.length - tokensWithValue.length });
			
			// Get scanner configuration
			const config = getScannerConfig();
			
			// Fetch prices for tokens without USD value
			const bnbPrice = await getBNBPrice();
			logger.info('BNB price fetched', { price: bnbPrice });
			
			// Batch fetch prices for tokens without USD value
			const tokensNeedingPrice = tokens.filter((token: any) => 
				(!token.usd_value || token.usd_value === 0) && 
				token.token_address && 
				token.token_address !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
			);
			
			logger.info('Fetching token prices', { tokenCount: tokensNeedingPrice.length });
			
			// Process in batches with delay to avoid rate limiting
			const BATCH_SIZE = config.batchSize;
			const DELAY_MS = config.delayBetweenBatchesMs;
			
			for (let i = 0; i < tokensNeedingPrice.length; i += BATCH_SIZE) {
				const batch = tokensNeedingPrice.slice(i, i + BATCH_SIZE);
				
				await Promise.all(batch.map(async (token: any) => {
					try {
						const tokenAddress = token.token_address || token.address;
						// Use cached price instead of fetching multiple times
						const price = await getCachedTokenPrice(tokenAddress);
						
						if (price && price > 0) {
							token.usd_price = price;
							const balance = parseFloat(token.balance) / Math.pow(10, token.decimals || 18);
							token.usd_value = balance * price;
							logger.info('Token price fetched', { symbol: token.symbol, price, tokenAddress });
						} else {
							logger.info('No price available for token', { symbol: token.symbol, tokenAddress });
							// Try to calculate price in BNB if USD price not available
							token.bnb_price = 0; // Could implement BNB pair price here
							token.usd_price = 0;
							token.usd_value = 0;
						}
					} catch (error) {
						logger.error('Error fetching token price', { symbol: token.symbol, error: error instanceof Error ? error.message : String(error) });
						token.usd_price = 0;
						token.usd_value = 0;
					}
				}));
				
				// Add delay between batches
				if (i + BATCH_SIZE < tokensNeedingPrice.length) {
					await new Promise(resolve => setTimeout(resolve, DELAY_MS));
				}
			}

			// Only fetch DeFi positions for user's own wallets
			let detectedStakingPositions: any[] = [];
			let defiPositions: any[] = [];
			let apiCallsSaved = 0;
			
			if (isUserWallet) {
				logger.info('Checking cache for DeFi positions', { walletAddress: inputAddress, userId });
				
				// Check cache first
				const cachedPosition = await DeFiPosition.findOne({
					userId: userId,
					walletAddress: inputAddress.toLowerCase()
				});
				
				// Cache is considered fresh if it's less than 1 hour old
				const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
				const shouldRefresh = !cachedPosition || 
					(Date.now() - cachedPosition.lastRefreshAt.getTime()) > CACHE_DURATION_MS ||
					!cachedPosition.hasActivePositions;
				
				if (shouldRefresh) {
					logger.info('Cache miss or expired, fetching fresh DeFi positions', { walletAddress: inputAddress });
					// Detect staking positions (includes direct stakes like veCAKE)
					detectedStakingPositions = await detectStakingPositions(inputAddress);
					
					// Fetch DeFi positions from Moralis
					defiPositions = await getDeFiPositions(inputAddress);
					
					// Calculate totals
					const totalStakingValue = detectedStakingPositions.reduce((sum, pos) => sum + (pos.usdValue || 0), 0);
					const totalDefiValue = defiPositions.reduce((sum, protocol) => {
						const positionValue = protocol.position.balance_usd || 0;
						const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
						return sum + positionValue + unclaimedValue;
					}, 0);
					
					// Extract protocol names
					const detectedProtocols = [
						...new Set([
							...detectedStakingPositions.map(pos => pos.protocol),
							...defiPositions.map(pos => pos.protocol_name)
						])
					];
					
					// Map DeFi positions to the expected interface structure
					const mappedDeFiPositions = defiPositions.map(protocol => ({
						protocol_name: protocol.protocol_name,
						protocol_id: protocol.protocol_id,
						protocol_url: protocol.protocol_url || '',
						balance_usd: protocol.position?.balance_usd || 0,
						total_unclaimed_usd_value: protocol.position?.total_unclaimed_usd_value || 0,
						tokens: (protocol.position?.tokens || []).map((token: any) => ({
							token_type: token.token_type,
							symbol: token.symbol,
							token_address: token.token_address,
							balance_formatted: token.balance_formatted,
							usd_value: token.usd_value || 0
						})),
						yearly_earnings_usd: protocol.total_projected_earnings_usd?.yearly || 0
					}));
					
					// Fetch APY data from DeFiLlama pools
					const poolApyMap = await getAPYsForDeFiPositions(mappedDeFiPositions);
					
					// Get enhanced APY using multiple data sources
					const enhancedApyMap = await getEnhancedAPYForPositions(mappedDeFiPositions, poolApyMap);
					
					// Add APY data to positions
					const positionsWithAPY = mappedDeFiPositions.map(position => {
						const positionKey = `${position.protocol_name}_${position.protocol_id}`;
						const apyData = enhancedApyMap.get(positionKey);
						return {
							...position,
							apy: apyData?.apy || 0,
							poolId: apyData?.poolId
						};
					});
					
					// Save to cache with APY data
					await DeFiPosition.findOneAndUpdate(
						{
							userId: userId,
							walletAddress: inputAddress.toLowerCase()
						},
						{
							defiPositions: positionsWithAPY,
							stakingPositions: detectedStakingPositions,
							totalDefiValue: totalDefiValue,
							totalStakingValue: totalStakingValue,
							lastRefreshAt: new Date(),
							apiCallsSaved: cachedPosition ? cachedPosition.apiCallsSaved : 0,
							detectedProtocols: detectedProtocols,
							hasActivePositions: (totalStakingValue + totalDefiValue) > 0
						},
						{ upsert: true, new: true }
					);
					
					// Add APY data to the original defiPositions for display
					defiPositions = defiPositions.map((protocol, index) => ({
						...protocol,
						apy: positionsWithAPY[index].apy,
						poolId: positionsWithAPY[index].poolId
					}));
				} else {
					logger.info('Using cached DeFi positions', { walletAddress: inputAddress, apiCallsSaved });
					// Use cached data
					detectedStakingPositions = cachedPosition.stakingPositions || [];
					// Convert cached positions back to Moralis format for display
					defiPositions = (cachedPosition.defiPositions || []).map(pos => ({
						protocol_name: pos.protocol_name,
						protocol_id: pos.protocol_id,
						protocol_url: pos.protocol_url,
						position: {
							balance_usd: pos.balance_usd,
							total_unclaimed_usd_value: pos.total_unclaimed_usd_value,
							tokens: pos.tokens
						},
						total_projected_earnings_usd: {
							yearly: pos.yearly_earnings_usd
						},
						apy: pos.apy,
						poolId: pos.poolId
					}));
					apiCallsSaved = 2; // Saved 2 API calls (staking + defi)
					
					// Update API calls saved counter
					await DeFiPosition.updateOne(
						{ _id: cachedPosition._id },
						{ $inc: { apiCallsSaved: 2 } }
					);
				}
			} else {
				logger.info('Skipping DeFi position detection for non-user wallet', { walletAddress: inputAddress });
			}
			
			// Filter out tokens without price, dead tokens, or low liquidity tokens
			let filteredTokens = tokens.filter((token: any) => {
				// Always include BNB/native token
				const tokenAddress = token.token_address || token.address;
				if (!tokenAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
					return true;
				}
				
				// Filter criteria:
				// 1. Must have a valid USD price (> 0)
				// 2. Must have a valid USD value (> 0) 
				// 3. Token balance must be meaningful (> dust amount)
				const hasValidPrice = token.usd_price && token.usd_price > 0;
				const hasValidValue = token.usd_value && token.usd_value > 0;
				const hasValidBalance = token.balance && parseFloat(token.balance) > 0;
				
				// Minimum USD value threshold to filter out dust/dead tokens
				const meetsMinValue = token.usd_value >= config.minUsdValue;
				
				return hasValidPrice && hasValidValue && hasValidBalance && meetsMinValue;
			});
			
			// Advanced liquidity filtering using the new unified function
			if (config.enableLiquidityFilter) {
				filteredTokens = await this._filterTokensByLiquidityAndActivity(filteredTokens);
			}
			
			logger.info('Token filtering results', { 
				originalCount: tokens.length, 
				filteredCount: filteredTokens.length, 
				removedCount: tokens.length - filteredTokens.length 
			});
			
			// Separate regular tokens from staking tokens
			const regularTokens = [];
			let stakingTokens = [];
			
			for (const token of filteredTokens) {
				const tokenAddress = token.token_address || token.address;
				if (isStakingToken(tokenAddress)) {
					const stakingInfo = getStakingTokenInfo(tokenAddress);
					token.isStaking = true;
					token.protocol = stakingInfo?.protocol;
					stakingTokens.push(token);
				} else {
					regularTokens.push(token);
				}
			}
			
			// Add direct staking positions (veCAKE, etc.) to stakingTokens
			logger.info('Detected staking positions', { count: detectedStakingPositions.length });
			for (const position of detectedStakingPositions) {
				logger.info('Processing staking position', { tokenSymbol: position.tokenSymbol, protocol: position.protocol, amount: position.stakedAmountFormatted });
				
				// For veCAKE, we need to ensure it's not duplicated with regular CAKE holdings
				// veCAKE positions should be separate from regular CAKE tokens
				if (position.protocol.includes('veCAKE')) {
					// Always add veCAKE positions as they represent locked CAKE
					const stakingToken = {
						symbol: position.tokenSymbol,
						token_address: position.tokenAddress,
						address: position.tokenAddress,
						balance: position.stakedAmount,
						decimals: 18, // Most BSC tokens use 18 decimals
						usd_value: position.usdValue,
						usd_price: position.usdValue / parseFloat(position.stakedAmountFormatted),
						isStaking: true,
						protocol: position.protocol,
						unlockTime: position.unlockTime,
						lockStartTime: position.lockStartTime,
						contractAddress: position.contractAddress,
						name: await getTranslation(ctx, 'scanner.lockedIn', { token: position.tokenSymbol, protocol: position.protocol }),
						// Store the formatted amount so we can use it for display
						stakedAmountFormatted: position.stakedAmountFormatted
					};
					stakingTokens.push(stakingToken);
					logger.info('Added veCAKE position', { amount: stakingToken.stakedAmountFormatted, symbol: stakingToken.symbol });
				} else {
					// Check if we already have this token in stakingTokens
					const existingToken = stakingTokens.find(
						token => token.token_address.toLowerCase() === position.tokenAddress.toLowerCase()
					);
					
					if (!existingToken) {
						// Convert StakingPosition to token format
						const stakingToken = {
							symbol: position.tokenSymbol,
							token_address: position.tokenAddress,
							address: position.tokenAddress,
							balance: position.stakedAmount,
							decimals: 18, // Most BSC tokens use 18 decimals
							usd_value: position.usdValue,
							usd_price: position.usdValue / parseFloat(position.stakedAmountFormatted),
							isStaking: true,
							protocol: position.protocol,
							unlockTime: position.unlockTime,
							lockStartTime: position.lockStartTime,
							contractAddress: position.contractAddress,
							name: await getTranslation(ctx, 'scanner.lockedIn', { token: position.tokenSymbol, protocol: position.protocol }),
							// Store the formatted amount so we can use it for display
							stakedAmountFormatted: position.stakedAmountFormatted
						};
						stakingTokens.push(stakingToken);
						logger.info('Added staking token', { symbol: stakingToken.symbol, protocol: stakingToken.protocol });
					} else {
						logger.info('Token already exists in stakingTokens, skipping', { symbol: position.tokenSymbol, tokenAddress: position.tokenAddress });
					}
				}
			}
			
			// Filter out duplicate CAKE positions if we have veCAKE
			const hasVeCAKE = stakingTokens.some(token => token.protocol?.includes('veCAKE'));
			if (hasVeCAKE) {
				// Remove any "Unknown Protocol" CAKE positions since they're likely duplicates
				const beforeCount = stakingTokens.length;
				const unknownProtocolText = await getTranslation(ctx, 'scanner.unknownProtocol');
				stakingTokens = stakingTokens.filter(token => 
					!(token.symbol === 'CAKE' && token.protocol === unknownProtocolText)
				);
				const removedCount = beforeCount - stakingTokens.length;
				if (removedCount > 0) {
					logger.info('Removed duplicate CAKE positions', { removedCount, hasVeCAKE: true });
				}
			}

			// Calculate total values
			const totalRegularValue = regularTokens.reduce((sum: number, token: any) => sum + (token.usd_value || 0), 0);
			const totalStakingValue = stakingTokens.reduce((sum: number, token: any) => sum + (token.usd_value || 0), 0);
			const totalValue = totalRegularValue + totalStakingValue;

			// Find BNB
			let bnbToken = regularTokens.find(
				(token: any) =>
					(token.symbol && token.symbol.toUpperCase() === 'BNB') ||
					(token.name && token.name.toLowerCase().includes('binance'))
			);

			// Filter BNB, sort by usd_value
			const otherTokens = regularTokens
				.filter((token: any) => token !== bnbToken)
				.sort((a: any, b: any) => (b.usd_value || 0) - (a.usd_value || 0))
				.slice(0, 9); // Show 9 other tokens + BNB = 10 total

			let message = await getTranslation(ctx, 'scanner.tokenHoldings') + '\n';
			message += `👛 \`${inputAddress.slice(0, 6)}...${inputAddress.slice(-4)}\`\n`;

			// Add address risk information if available
			if (addressRisk.hasData) {
				const riskEmoji = hapiAddressRiskService.getRiskEmoji(addressRisk.riskLevel);
				const compactDisplay = hapiAddressRiskService.getCompactDisplay(addressRisk);

				if (addressRisk.risk === 0) {
					message += `🛡️ *Address Security:* ${compactDisplay} (HAPI Labs)\n`;
				} else if (addressRisk.risk >= 7) {
					// High risk or critical - show detailed warning
					message += `\n🚨 *SECURITY ALERT (HAPI Labs)*\n`;
					message += `${riskEmoji} ${addressRisk.riskLevel} RISK (${addressRisk.risk}/10)\n`;
					message += `⚠️ Category: ${addressRisk.category}\n`;
					if (addressRisk.riskDescription) {
						message += `${addressRisk.riskDescription}\n`;
					}
					message += `\n⚠️ *Exercise extreme caution with this address!*\n`;
				} else if (addressRisk.risk >= 4) {
					// Medium risk - show warning
					message += `🛡️ *Address Security:* ${compactDisplay} (HAPI Labs)\n`;
					message += `ℹ️ ${addressRisk.riskDescription}\n`;
				} else {
					// Low risk - compact display
					message += `🛡️ *Address Security:* ${compactDisplay} (HAPI Labs)\n`;
				}
			}

			message += `\n` + await getTranslation(ctx, 'scanner.totalTokenValue') + ` ${formatUSDValue(totalValue)} ${t(lang, 'common.bscLabel')}\n\n`;

			let index = 1;
			if (bnbToken) {
				const balance = formatTokenBalance(bnbToken.balance, bnbToken.decimals || 18);
				const symbol = bnbToken.symbol || await getTranslation(ctx, 'scanner.bnbBalance');
				const name = bnbToken.name || 'Binance Coin';
				const usdValue = bnbToken.usd_value ? formatUSDValue(bnbToken.usd_value) : 'N/A';
				const price = bnbToken.usd_price ? formatUSDValueWithSubscript(bnbToken.usd_price) : 'N/A';
				const contract = bnbToken.token_address || bnbToken.address || 'N/A';

				const bscScanUrl = contract.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' 
					? 'https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
					: `https://bscscan.com/token/${contract}`;
				
				const priceLabel = await getTranslation(ctx, 'scanner.price');
				const displayContract = contract.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' 
					? 'Native Token'
					: contract;
				message += `${index++}. [${symbol}](${bscScanUrl})\n`;
				message += `   ${name}\n`;
				message += `   📋 \`${displayContract}\`\n`;
				message += `   💰 ${balance}\n`;
				message += `   💵 ${usdValue} (${priceLabel} ${price})\n\n`;
			}

			for (const token of otherTokens) {
				const balance = formatTokenBalance(token.balance, token.decimals || 18);
				const symbol = token.symbol || await getTranslation(ctx, 'scanner.unknownSymbol');
				const name = token.name || await getTranslation(ctx, 'scanner.unknownToken');
				const usdValue = token.usd_value ? formatUSDValue(token.usd_value) : await getTranslation(ctx, 'scanner.priceNotAvailable');
				const price = token.usd_price ? formatUSDValueWithSubscript(token.usd_price) : 'N/A';
				const contract = token.token_address || token.address || 'N/A';

				const bscScanUrl = `https://bscscan.com/token/${contract}`;
				const priceLabel = await getTranslation(ctx, 'scanner.price');
				
				message += `${index++}. [${symbol}](${bscScanUrl})\n`;
				message += `   ${name}\n`;
				message += `   📋 \`${contract}\`\n`;
				message += `   💰 ${balance}\n`;
				message += `   💵 ${usdValue} (${priceLabel} ${price})\n\n`;
			}

			if (regularTokens.length > 10) {
				message += await getTranslation(ctx, 'scanner.moreTokens', { count: regularTokens.length - 10 }) + '\n';
			}
			
			// Combine staking and DeFi positions into one unified section
			const hasStaking = stakingTokens.length > 0;
			const hasDeFi = defiPositions && defiPositions.length > 0;
			
			if (hasStaking || hasDeFi) {
				// Calculate total DeFi value (staking + protocol positions)
				const totalProtocolValue = defiPositions ? defiPositions.reduce((sum, protocol) => {
					const positionValue = protocol.position.balance_usd || 0;
					const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
					return sum + positionValue + unclaimedValue;
				}, 0) : 0;
				const totalDeFiValue = totalStakingValue + totalProtocolValue;
				
				message += `\n\n` + await getTranslation(ctx, 'scanner.defiPositions') + `\n`;
				message += await getTranslation(ctx, 'scanner.totalValue') + ` $${totalDeFiValue.toFixed(2)}\n\n`;
				
				let positionNumber = 1;
				
				// First, add staking positions
				if (hasStaking) {
					// Sort staking tokens by value, but prioritize veCAKE positions
					const sortedStakingTokens = stakingTokens
						.sort((a: any, b: any) => {
							// Prioritize veCAKE positions
							if (a.protocol?.includes('veCAKE') && !b.protocol?.includes('veCAKE')) return -1;
							if (!a.protocol?.includes('veCAKE') && b.protocol?.includes('veCAKE')) return 1;
							// Then sort by value
							return (b.usd_value || 0) - (a.usd_value || 0);
						})
						.slice(0, 5); // Show top 5 staking positions
					
					for (const token of sortedStakingTokens) {
						// Use the pre-formatted amount for staking positions
						const balance = token.stakedAmountFormatted || formatTokenBalance(token.balance, token.decimals || 18);
						const symbol = token.symbol || await getTranslation(ctx, 'scanner.unknownSymbol');
						const usdValue = token.usd_value ? `$${token.usd_value.toFixed(2)}` : await getTranslation(ctx, 'scanner.priceNotAvailable');
						const protocol = token.protocol || await getTranslation(ctx, 'scanner.unknownProtocol');
						const contract = token.token_address || token.address || 'N/A';
						
						// Use contract address for staking contracts, token address for regular tokens
						const contractForLink = token.contractAddress || contract;
						const bscScanUrl = protocol.includes('veCAKE') 
							? `https://bscscan.com/address/${contractForLink}#readContract`
							: `https://bscscan.com/token/${contract}`;
						
						message += `${positionNumber++}. *${symbol} - ${protocol}*\n`;
						message += `   💰 ${balance} ${symbol} (${usdValue})\n`;
						
						// Add compact protocol-specific information
						if (protocol.includes('veCAKE')) {
							message += `   🗳️ ${await getTranslation(ctx, 'scanner.votingPower')} ${balance} veCAKE\n`;
							if (token.unlockTime) {
								const unlockDate = new Date(token.unlockTime);
								const now = new Date();
								const daysUntilUnlock = Math.ceil((unlockDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
								message += `   🔓 ${await getTranslation(ctx, 'scanner.unlockTime')} ${daysUntilUnlock} ${await getTranslation(ctx, 'scanner.unlockTime')}\n`;
							}
						} else if (protocol.includes('Venus')) {
							message += `   📊 ${await getTranslation(ctx, 'scanner.earningRewards', { token: 'XVS' })}\n`;
						} else if (protocol.includes('PancakeSwap') && symbol.includes('LP')) {
							message += `   📊 ${await getTranslation(ctx, 'scanner.earningFees', { token: 'CAKE' })}\n`;
						}
						
						// Show APY if available
						if (token.apy && token.apy > 0) {
							message += `   📈 ${await getTranslation(ctx, 'scanner.apy', { percentage: token.apy.toFixed(1) })}\n`;
						}
						
						message += `   📝 [${await getTranslation(ctx, 'scanner.viewContract')}](${bscScanUrl})\n\n`;
					}
					
					if (stakingTokens.length > 5) {
						message += await getTranslation(ctx, 'scanner.moreStaking', { count: stakingTokens.length - 5 }) + '\n\n';
					}
				}
				
				// Then, add DeFi protocol positions
				if (hasDeFi && defiPositions) {
					// Sort by total value and limit to top positions
					const sortedDeFiPositions = defiPositions
						.sort((a, b) => {
							const aValue = (a.position.balance_usd || 0) + (a.position.total_unclaimed_usd_value || 0);
							const bValue = (b.position.balance_usd || 0) + (b.position.total_unclaimed_usd_value || 0);
							return bValue - aValue;
						})
						.slice(0, Math.max(0, 5 - (stakingTokens.length > 5 ? 5 : stakingTokens.length))); // Show remaining slots
					
					for (const protocol of sortedDeFiPositions) {
						const positionValue = protocol.position.balance_usd || 0;
						const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
						const totalValue = positionValue + unclaimedValue;
						
						message += `${positionNumber++}. *${protocol.protocol_name}*\n`;
						message += `   💵 ${await getTranslation(ctx, 'scanner.position')} $${positionValue.toFixed(2)}`;
						if (unclaimedValue > 0) {
							message += ` + $${unclaimedValue.toFixed(2)} ${await getTranslation(ctx, 'scanner.rewards')}`;
						}
						message += `\n`;
						
						// Show main tokens in position (limit to 2 for compact display)
						const mainTokens = protocol.position.tokens
							.filter((t: any) => t.token_type === 'supplied')
							.slice(0, 2);
						
						if (mainTokens.length > 0) {
							message += `   📥 `;
							mainTokens.forEach((token: any, index: number) => {
								if (index > 0) message += ', ';
								message += `${token.balance_formatted} ${token.symbol}`;
							});
							if (protocol.position.tokens.filter((t: any) => t.token_type === 'supplied').length > 2) {
								message += ` + ${protocol.position.tokens.filter((t: any) => t.token_type === 'supplied').length - 2} ${await getTranslation(ctx, 'scanner.andMore', { count: protocol.position.tokens.filter((t: any) => t.token_type === 'supplied').length - 2 })}`;
							}
							message += `\n`;
						}
						
						// Show APY from DeFiLlama if available
						if (protocol.apy && protocol.apy > 0) {
							message += `   📈 ${await getTranslation(ctx, 'scanner.apy', { percentage: protocol.apy.toFixed(1) })}\n`;
						}
						
						// Use DeFiLlama pool link if available, otherwise use protocol URL
						const protocolLink = protocol.poolId 
							? `https://defillama.com/yields/pool/${protocol.poolId}`
							: protocol.protocol_url;
						
						if (protocolLink) {
							message += `   🔗 [${await getTranslation(ctx, 'scanner.visitProtocol')}](${protocolLink})\n`;
						}
						
						message += `\n`;
					}
					
					if (defiPositions.length > sortedDeFiPositions.length) {
						message += await getTranslation(ctx, 'scanner.moreDefi', { count: defiPositions.length - sortedDeFiPositions.length }) + '\n';
					}
				}
			}
			
			message += `\n` + await getTranslation(ctx, 'scanner.summary') + `\n`;
			message += await getTranslation(ctx, 'scanner.regularTokens') + ` ${regularTokens.length} ($${totalRegularValue.toFixed(2)})\n`;
			
			// Calculate combined DeFi statistics
			const totalDeFiPositions = stakingTokens.length + (defiPositions ? defiPositions.length : 0);
			const totalProtocolValue = defiPositions ? defiPositions.reduce((sum, protocol) => {
				const positionValue = protocol.position.balance_usd || 0;
				const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
				return sum + positionValue + unclaimedValue;
			}, 0) : 0;
			const totalDeFiValue = totalStakingValue + totalProtocolValue;
			
			if (totalDeFiPositions > 0) {
				message += await getTranslation(ctx, 'scanner.defiPositionsCount') + ` ${totalDeFiPositions} ($${totalDeFiValue.toFixed(2)})\n`;
				message += await getTranslation(ctx, 'scanner.totalPortfolio') + ` $${(totalRegularValue + totalDeFiValue).toFixed(2)}`;
			} else {
				message += await getTranslation(ctx, 'scanner.totalPortfolio') + ` $${totalRegularValue.toFixed(2)}`;
			}
			message += ` ${t(lang, 'common.bscLabel')}`;
			
			// Check if any tokens have no price
			const tokensWithoutPrice = tokens.filter((t: any) => !t.usd_price || t.usd_price === 0);
			if (tokensWithoutPrice.length > 0) {
				const plural = tokensWithoutPrice.length > 1 ? 's' : '';
				message += `\n\n` + await getTranslation(ctx, 'scanner.noteNoPrices', { count: tokensWithoutPrice.length, plural });
			}
			
			// Add BSC disclaimer
			message += `\n\n_${t(lang, 'scanner.bscOnlyDisclaimer')}_`;
			
			// Add analytics buttons
			const keyboard = {
				inline_keyboard: [
					[
						{ text: await getTranslation(ctx, 'scanner.transactionHistory'), callback_data: `history_${inputAddress}` },
						{ text: await getTranslation(ctx, 'scanner.pnlAnalysis'), callback_data: `pnl_${inputAddress}` }
					],
					// Add refresh button for user's own wallets
					...(isUserWallet && (hasStaking || (defiPositions && defiPositions.length > 0)) ? [[
						{ text: '🔄 Refresh DeFi Positions', callback_data: `refresh_defi_${inputAddress}` }
					]] : []),
					[{ text: await getTranslation(ctx, 'scanner.backToMenuButton'), callback_data: 'start' }]
				]
			};
			
			await ctx.reply(message, { 
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error: any) {
			await ctx.reply(await getTranslation(ctx, 'scanner.errorScanning'));
			await ctx.reply(await getTranslation(ctx, 'scanner.errorDetail') + ' ' + (error?.message || String(error)));
		}
	}

	async handleMultipleWallets(ctx: Context, addresses: string[]) {
		const userId = ctx.from!.id;
		const lang = await getUserLanguage(userId);
		const session = global.userSessions.get(userId);
		if (!session) return;
		session.waitingForWalletInput = false;

		// Check for empty wallet list
		if (!addresses || addresses.length === 0) {
			await ctx.reply(await getTranslation(ctx, 'scanner.noWallets'));
			return;
		}

		// Validate all addresses
		const addressRegex = /^0x[a-fA-F0-9]{40}$/;
		for (const address of addresses) {
			if (!addressRegex.test(address)) {
				await ctx.reply(await getTranslation(ctx, 'scanner.invalidWalletInList', { address }));
				return;
			}
		}

		try {
			// Get user's wallet addresses to check if these are their wallets
			const { UserService } = await import('../user');
			const userWalletAddress = session.address;
			const userTradingWalletAddress = await UserService.getTradingWalletAddress(userId);
			
			// Check if all addresses belong to the user
			const areUserWallets = addresses.every(address => 
				address.toLowerCase() === userWalletAddress?.toLowerCase() ||
				address.toLowerCase() === userTradingWalletAddress?.toLowerCase()
			);
			
			await ctx.reply(await getTranslation(ctx, 'scanner.scanningMultiple', { count: addresses.length }));

			// Fetch tokens and address risk for all wallets in parallel
			const allTokensPromises = addresses.map(address => getWalletTokensWithPrices(address));
			const allRiskPromises = addresses.map(address => hapiAddressRiskService.checkAddressRisk(address, 'bsc'));
			const [allTokensResults, allRiskResults] = await Promise.all([
				Promise.all(allTokensPromises),
				Promise.all(allRiskPromises)
			]);
			
			// Combine all tokens from all wallets
			const combinedTokens: { [key: string]: any } = {};
			let totalValueAllWallets = 0;
			
			// Only fetch DeFi positions for user's own wallets
			let allStakingResults: any[][] = [];
			let allDeFiResults: any[][] = [];
			
			let totalApiCallsSaved = 0;
			
			if (areUserWallets) {
				logger.info('Fetching DeFi positions for user wallets', { walletAddresses: addresses, userId });
				// Fetch staking and DeFi positions for all wallets with caching
				const defiPromises = addresses.map(address => this.fetchOrGetCachedDeFiPositions(userId, address));
				const defiResults = await Promise.all(defiPromises);
				
				// Extract staking and DeFi results
				allStakingResults = defiResults.map(result => result.stakingPositions);
				allDeFiResults = defiResults.map(result => result.defiPositions);
				totalApiCallsSaved = defiResults.filter(result => result.fromCache).length * 2;
			} else {
				// Initialize empty arrays for each wallet
				allStakingResults = addresses.map(() => []);
				allDeFiResults = addresses.map(() => []);
				logger.info('Skipping DeFi position detection for non-user wallets', { walletAddresses: addresses });
			}
			
			// Get scanner configuration for multi-wallet scan
			const config = getScannerConfig();
			
			// Process tokens and add direct staking positions
			for (let walletIndex = 0; walletIndex < addresses.length; walletIndex++) {
				const address = addresses[walletIndex];
				const tokensData = allTokensResults[walletIndex];
				let tokens: any[] = [];
				
				if (Array.isArray(tokensData)) {
					tokens = tokensData;
				} else if (Array.isArray((tokensData as any).result)) {
					tokens = (tokensData as any).result;
				}
				
				// Filter out tokens without price, dead tokens, or low liquidity tokens
				let filteredTokens = tokens.filter((token: any) => {
					// Always include BNB/native token
					const tokenAddress = token.token_address || token.address;
					if (!tokenAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
						return true;
					}
					
					// Filter criteria:
					// 1. Must have a valid USD price (> 0)
					// 2. Must have a valid USD value (> 0) 
					// 3. Token balance must be meaningful (> dust amount)
					const hasValidPrice = token.usd_price && token.usd_price > 0;
					const hasValidValue = token.usd_value && token.usd_value > 0;
					const hasValidBalance = token.balance && parseFloat(token.balance) > 0;
					
					
					// Minimum USD value threshold to filter out dust/dead tokens
					const meetsMinValue = token.usd_value >= config.minUsdValue;
					
					return hasValidPrice && hasValidValue && hasValidBalance && meetsMinValue;
				});
				
				// Advanced liquidity filtering using the new unified function
				if (config.enableLiquidityFilter) {
					filteredTokens = await this._filterTokensByLiquidityAndActivity(filteredTokens);
				}
				
				logger.info('Multi-wallet token filtering results', { 
					walletAddress: address,
					originalCount: tokens.length, 
					filteredCount: filteredTokens.length, 
					removedCount: tokens.length - filteredTokens.length 
				});
				
				filteredTokens.forEach(token => {
					const tokenKey = token.token_address || token.address || token.symbol;
					if (!tokenKey) return;
					
					// Check if it's a staking token
					if (isStakingToken(tokenKey)) {
						const stakingInfo = getStakingTokenInfo(tokenKey);
						token.isStaking = true;
						token.protocol = stakingInfo?.protocol;
					}
					
					if (combinedTokens[tokenKey]) {
						// Token exists, add to existing balance
						const existingBalance = parseFloat(combinedTokens[tokenKey].balance || '0');
						const newBalance = parseFloat(token.balance || '0');
						combinedTokens[tokenKey].balance = (existingBalance + newBalance).toString();
						combinedTokens[tokenKey].usd_value = (combinedTokens[tokenKey].usd_value || 0) + (token.usd_value || 0);
						combinedTokens[tokenKey].wallets.push({ address, balance: token.balance, usd_value: token.usd_value });
					} else {
						// New token
						combinedTokens[tokenKey] = {
							...token,
							wallets: [{ address, balance: token.balance, usd_value: token.usd_value }]
						};
					}
				});
			}
			
			// Add direct staking positions from detectStakingPositions
			for (let walletIndex = 0; walletIndex < addresses.length; walletIndex++) {
				const address = addresses[walletIndex];
				const stakingPositions = allStakingResults[walletIndex];
				if (stakingPositions && stakingPositions.length > 0) {
					stakingPositions.forEach(position => {
						const tokenKey = `${position.protocol}_${position.tokenSymbol}`;
						
						const stakingToken = {
							symbol: position.tokenSymbol,
							token_address: position.tokenAddress,
							address: position.tokenAddress,
							balance: position.stakedAmount,
							decimals: 18,
							usd_value: position.usdValue,
							usd_price: position.usdValue / parseFloat(position.stakedAmountFormatted),
							isStaking: true,
							protocol: position.protocol,
							unlockTime: position.unlockTime,
							name: `${position.tokenSymbol} locked in ${position.protocol}`,
							wallets: [{ address, balance: position.stakedAmount, usd_value: position.usdValue }],
							// Store the formatted amount so we can use it for display
							stakedAmountFormatted: position.stakedAmountFormatted,
							contractAddress: position.contractAddress
						};
						
						if (combinedTokens[tokenKey]) {
							// Update existing entry
							combinedTokens[tokenKey].usd_value += position.usdValue;
							combinedTokens[tokenKey].wallets.push({ address, balance: position.stakedAmount, usd_value: position.usdValue });
						} else {
							// Add new entry
							combinedTokens[tokenKey] = stakingToken;
						}
					});
				}
			}
			
			// Convert combined tokens to array and separate staking tokens
			const tokenArray = Object.values(combinedTokens);
			const regularTokens = tokenArray.filter((token: any) => !token.isStaking);
			let stakingTokens = tokenArray.filter((token: any) => token.isStaking);
			
			const totalRegularValue = regularTokens.reduce((sum: number, token: any) => sum + (token.usd_value || 0), 0);
			const totalStakingValue = stakingTokens.reduce((sum: number, token: any) => sum + (token.usd_value || 0), 0);
			totalValueAllWallets = totalRegularValue + totalStakingValue;
			
			// Find BNB
			let bnbToken = regularTokens.find(
				(token: any) =>
					(token.symbol && token.symbol.toUpperCase() === 'BNB') ||
					(token.name && token.name.toLowerCase().includes('binance'))
			);
			
			// Filter and sort tokens
			const otherTokens = regularTokens
				.filter((token: any) => token !== bnbToken)
				.sort((a: any, b: any) => (b.usd_value || 0) - (a.usd_value || 0))
				.slice(0, 9); // Show 9 other tokens + BNB = 10 total
			
			// Build message
			let message = await getTranslation(ctx, 'scanner.combinedTokenHoldings') + '\n';
			message += await getTranslation(ctx, 'scanner.scanningWallets', { count: addresses.length }) + '\n';
			addresses.forEach(addr => {
				message += `• \`${addr.slice(0, 6)}...${addr.slice(-4)}\`\n`;
			});

			// Display address risk warnings if any wallets are risky
			const riskyWallets = allRiskResults.filter((risk, index) => risk.hasData && risk.risk >= 4);
			const criticalWallets = allRiskResults.filter((risk, index) => risk.hasData && risk.risk >= 7);

			if (criticalWallets.length > 0) {
				// Show critical risk warning
				message += `\n🚨 *SECURITY ALERT (HAPI Labs)*\n`;
				criticalWallets.forEach((risk, index) => {
					const walletIndex = allRiskResults.indexOf(risk);
					const addr = addresses[walletIndex];
					const riskEmoji = hapiAddressRiskService.getRiskEmoji(risk.riskLevel);
					message += `${riskEmoji} \`${addr.slice(0, 6)}...${addr.slice(-4)}\` - ${risk.riskLevel} (${risk.risk}/10) - ${risk.category}\n`;
				});
				message += `⚠️ *Exercise extreme caution with these addresses!*\n`;
			} else if (riskyWallets.length > 0) {
				// Show medium risk warning
				message += `\n🛡️ *Address Risk Info (HAPI Labs)*\n`;
				riskyWallets.forEach((risk, index) => {
					const walletIndex = allRiskResults.indexOf(risk);
					const addr = addresses[walletIndex];
					const compactDisplay = hapiAddressRiskService.getCompactDisplay(risk);
					message += `• \`${addr.slice(0, 6)}...${addr.slice(-4)}\` - ${compactDisplay}\n`;
				});
			} else {
				// Check if we have any safe address data
				const safeWallets = allRiskResults.filter(risk => risk.hasData && risk.risk === 0);
				if (safeWallets.length > 0) {
					message += `\n🛡️ All addresses verified safe (HAPI Labs)\n`;
				}
			}

			message += `\n` + await getTranslation(ctx, 'scanner.totalCombinedValue') + ` ${formatUSDValue(totalValueAllWallets)} ${t(lang, 'common.bscLabel')}\n\n`;

			let index = 1;
			if (bnbToken) {
				const balance = formatTokenBalance(bnbToken.balance, bnbToken.decimals || 18);
				const symbol = bnbToken.symbol || await getTranslation(ctx, 'scanner.bnbBalance');
				const name = bnbToken.name || 'Binance Coin';
				const usdValue = bnbToken.usd_value ? formatUSDValue(bnbToken.usd_value) : 'N/A';
				const price = bnbToken.usd_price ? formatUSDValueWithSubscript(bnbToken.usd_price) : 'N/A';
				
				const bscScanUrl = 'https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
				const priceLabel = await getTranslation(ctx, 'scanner.price');
				
				message += `${index++}. [${symbol}](${bscScanUrl})\n`;
				message += `   ${name}\n`;
				message += `   📋 \`Native Token\`\n`;
				message += `   💰 ${balance}\n`;
				message += `   💵 ${usdValue} (${priceLabel} ${price})\n`;
				if (bnbToken.wallets.length > 1) {
					message += `   📍 ${await getTranslation(ctx, 'scanner.inWallets', { count: bnbToken.wallets.length })}\n`;
				}
				message += `\n`;
			}
			
			for (const token of otherTokens) {
				const balance = formatTokenBalance(token.balance, token.decimals || 18);
				const symbol = token.symbol || await getTranslation(ctx, 'scanner.unknownSymbol');
				const name = token.name || await getTranslation(ctx, 'scanner.unknownToken');
				const usdValue = token.usd_value ? formatUSDValue(token.usd_value) : await getTranslation(ctx, 'scanner.priceNotAvailable');
				const price = token.usd_price ? formatUSDValueWithSubscript(token.usd_price) : 'N/A';
				
				const contract = token.token_address || token.address || 'N/A';
				const bscScanUrl = `https://bscscan.com/token/${contract}`;
				const priceLabel = await getTranslation(ctx, 'scanner.price');
				
				message += `${index++}. [${symbol}](${bscScanUrl})\n`;
				message += `   ${name}\n`;
				message += `   📋 \`${contract}\`\n`;
				message += `   💰 ${balance}\n`;
				message += `   💵 ${usdValue} (${priceLabel} ${price})\n`;
				if (token.wallets.length > 1) {
					message += `   📍 ${await getTranslation(ctx, 'scanner.inWallets', { count: token.wallets.length })}\n`;
				}
				message += `\n`;
			}
			
			if (regularTokens.length > 10) {
				message += await getTranslation(ctx, 'scanner.moreTokens', { count: regularTokens.length - 10 }) + '\n';
			}
			
			// Add staking section if there are staking positions
			if (stakingTokens.length > 0) {
				message += `\n\n` + await getTranslation(ctx, 'scanner.defiPositions') + `\n`;
				// We'll calculate total later including protocol positions
				
				// Sort staking tokens by value, but prioritize veCAKE positions
				const sortedStakingTokens = stakingTokens
					.sort((a: any, b: any) => {
						// Prioritize veCAKE positions
						if (a.protocol?.includes('veCAKE') && !b.protocol?.includes('veCAKE')) return -1;
						if (!a.protocol?.includes('veCAKE') && b.protocol?.includes('veCAKE')) return 1;
						// Then sort by value
						return (b.usd_value || 0) - (a.usd_value || 0);
					})
					.slice(0, 5); // Show top 5 staking positions
				
				for (const token of sortedStakingTokens) {
					// Use the pre-formatted amount for staking positions
					const balance = token.stakedAmountFormatted || formatTokenBalance(token.balance, token.decimals || 18);
					const symbol = token.symbol || await getTranslation(ctx, 'scanner.unknownSymbol');
					const usdValue = token.usd_value ? `$${token.usd_value.toFixed(2)}` : await getTranslation(ctx, 'scanner.priceNotAvailable');
					const protocol = token.protocol || await getTranslation(ctx, 'scanner.unknownProtocol');
					const contract = token.token_address || token.address || 'N/A';
					
					// Use contract address for staking contracts
					const contractForLink = token.contractAddress || contract;
					const bscScanUrl = protocol.includes('veCAKE') 
						? `https://bscscan.com/address/${contractForLink}#readContract`
						: `https://bscscan.com/token/${contract}`;
					
					message += `• *${symbol} - ${protocol}*\n`;
					message += `   💰 ${await getTranslation(ctx, 'scanner.amount')} ${balance} ${symbol}\n`;
					message += `   💵 ${await getTranslation(ctx, 'scanner.value')} ${usdValue}\n`;
					
					// Add protocol-specific benefits
					if (protocol.includes('veCAKE')) {
						message += `   📊 ${await getTranslation(ctx, 'scanner.benefits')}\n`;
						message += `      • ${await getTranslation(ctx, 'scanner.governanceRights')}\n`;
						message += `      • ${await getTranslation(ctx, 'scanner.boostedRewards')}\n`;
						message += `      • ${await getTranslation(ctx, 'scanner.tradingFeeSharing')}\n`;
						message += `   🗳️ ${await getTranslation(ctx, 'scanner.votingPower')} ${balance} veCAKE\n`;
					}
					
					// Add unlock time if available
					if (token.unlockTime) {
						const unlockDate = new Date(token.unlockTime);
						const now = new Date();
						const daysUntilUnlock = Math.ceil((unlockDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
						
						message += `   🔓 ${await getTranslation(ctx, 'scanner.lockDetails')}\n`;
						message += `      • ${await getTranslation(ctx, 'scanner.unlockDate')} ${unlockDate.toLocaleDateString()} ${unlockDate.toLocaleTimeString()}\n`;
						message += `      • ${await getTranslation(ctx, 'scanner.daysRemaining')} ${daysUntilUnlock} ${await getTranslation(ctx, 'scanner.unlockTime')}\n`;
					}
					
					if (token.wallets.length > 1) {
						message += `   📍 ${await getTranslation(ctx, 'scanner.inWallets', { count: token.wallets.length })}\n`;
					}
					
					message += `   📝 [${await getTranslation(ctx, 'scanner.viewContract')}](${bscScanUrl})\n`;
					message += `\n`;
				}
				
				if (stakingTokens.length > 5) {
					message += await getTranslation(ctx, 'scanner.moreStaking', { count: stakingTokens.length - 5 }) + '\n';
				}
			}
			
			// Process and display combined DeFi positions
			const combinedDeFiPositions: { [key: string]: any } = {};
			let totalDeFiValue = 0;
			
			addresses.forEach((address, walletIndex) => {
				const defiPositions = allDeFiResults[walletIndex];
				if (defiPositions && defiPositions.length > 0) {
					defiPositions.forEach(protocol => {
						const key = protocol.protocol_id;
						const positionValue = protocol.position.balance_usd || 0;
						const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
						
						if (combinedDeFiPositions[key]) {
							// Aggregate values
							combinedDeFiPositions[key].position.balance_usd += positionValue;
							combinedDeFiPositions[key].position.total_unclaimed_usd_value += unclaimedValue;
							combinedDeFiPositions[key].walletCount++;
						} else {
							// Clone the protocol data
							combinedDeFiPositions[key] = {
								...protocol,
								walletCount: 1
							};
						}
						
						totalDeFiValue += positionValue + unclaimedValue;
					});
				}
			});
			
			// Display combined DeFi positions
			const defiArray = Object.values(combinedDeFiPositions);
			if (defiArray.length > 0) {
				message += `\n\n` + await getTranslation(ctx, 'scanner.combinedDefiPositions') + `\n`;
				message += await getTranslation(ctx, 'scanner.totalDefiValue') + ` $${totalDeFiValue.toFixed(2)}\n`;
				
				const sortedDefiArray = defiArray
					.sort((a: any, b: any) => (b.position.balance_usd || 0) - (a.position.balance_usd || 0))
					.slice(0, 5);
				
				for (let index = 0; index < sortedDefiArray.length; index++) {
					const protocol = sortedDefiArray[index];
					const positionValue = protocol.position.balance_usd || 0;
					const unclaimedValue = protocol.position.total_unclaimed_usd_value || 0;
					
					message += `\n*${index + 1}. ${protocol.protocol_name}*\n`;
					message += `💵 ${await getTranslation(ctx, 'scanner.position')}: $${positionValue.toFixed(2)}\n`;
					
					if (unclaimedValue > 0) {
						message += `🎁 Unclaimed ${await getTranslation(ctx, 'scanner.rewards')}: $${unclaimedValue.toFixed(2)}\n`;
					}
					
					if (protocol.walletCount > 1) {
						message += `📍 ${await getTranslation(ctx, 'scanner.inWallets', { count: protocol.walletCount })}\n`;
					}
				}
				
				if (defiArray.length > 5) {
					message += `\n` + await getTranslation(ctx, 'scanner.moreProtocols', { count: defiArray.length - 5 }) + '\n';
				}
			}
			
			// Calculate totals for summary
			const totalDeFiPositions = stakingTokens.length + defiArray.length;
			const combinedDeFiValue = totalStakingValue + totalDeFiValue;
			
			message += `\n` + await getTranslation(ctx, 'scanner.summary') + `\n`;
			message += await getTranslation(ctx, 'scanner.regularTokens') + ` ${regularTokens.length} ($${totalRegularValue.toFixed(2)})\n`;
			
			if (totalDeFiPositions > 0) {
				message += await getTranslation(ctx, 'scanner.defiPositionsCount') + ` ${totalDeFiPositions} ($${combinedDeFiValue.toFixed(2)})\n`;
				message += await getTranslation(ctx, 'scanner.totalPortfolio') + ` $${(totalRegularValue + combinedDeFiValue).toFixed(2)}`;
			} else {
				message += await getTranslation(ctx, 'scanner.totalPortfolio') + ` $${totalRegularValue.toFixed(2)}`;
			}
			message += ` ${t(lang, 'common.bscLabel')}`;
			message += `\n\n_${t(lang, 'scanner.bscOnlyDisclaimer')}_`;
			
			// Add buttons
			const keyboard = {
				inline_keyboard: [
					[{ text: await getTranslation(ctx, 'scanner.backToMenuButton'), callback_data: 'start' }]
				]
			};
			
			await ctx.reply(message, { 
				parse_mode: 'Markdown',
				reply_markup: keyboard
			});
		} catch (error: any) {
			await ctx.reply(await getTranslation(ctx, 'scanner.errorMultiple'));
			await ctx.reply(await getTranslation(ctx, 'scanner.errorDetail') + ' ' + (error?.message || String(error)));
		}
	}
	
	async handleRefreshDeFiPositions(ctx: Context, walletAddress: string) {
		const userId = ctx.from!.id;
		const session = global.userSessions.get(userId);
		if (!session) return;
		
		try {
			await ctx.answerCbQuery('Refreshing DeFi positions...');
			
			// Force cache refresh by setting lastRefreshAt to epoch
			await DeFiPosition.updateOne(
				{
					userId: userId,
					walletAddress: walletAddress.toLowerCase()
				},
				{
					$set: { lastRefreshAt: new Date(0) }
				}
			);
			
			// Re-scan the wallet
			await this.handleWalletInput(ctx, walletAddress);
		} catch (error) {
			logger.error('Error refreshing DeFi positions', { walletAddress, userId, error: error instanceof Error ? error.message : String(error) });
			await ctx.answerCbQuery('Failed to refresh. Please try again.');
		}
	}
}