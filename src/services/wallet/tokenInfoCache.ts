import { createLogger } from '@/utils/logger';
import { TokenPriceModel } from '@/database/models/TokenPrice';
import { ethers } from 'ethers';
import Moralis from 'moralis';

const logger = createLogger('wallet.tokenInfoCache');

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logo?: string;
}

// In-memory cache for ultra-fast access
const tokenInfoMemoryCache = new Map<string, TokenInfo>();

const ERC20_ABI_MINIMAL = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
];

/**
 * Gets token information (symbol, name, decimals), using a multi-layer cache.
 * 1. Memory Cache (fastest)
 * 2. Database Cache (persistent)
 * 3. Moralis API (rich data)
 * 4. On-chain Fetch (fallback)
 * @param tokenAddress The contract address of the token.
 * @param provider An ethers.js provider instance.
 * @returns TokenInfo object or null if not found.
 */
export async function getTokenInfo(tokenAddress: string, provider: ethers.Provider): Promise<TokenInfo | null> {
    const normalizedAddress = tokenAddress.toLowerCase();

    // 1. Check Memory Cache
    if (tokenInfoMemoryCache.has(normalizedAddress)) {
        logger.debug(`Token info found in memory cache: ${normalizedAddress}`);
        return tokenInfoMemoryCache.get(normalizedAddress)!;
    }

    // 2. Check Database Cache (using TokenPriceModel as it already stores this info)
    try {
        const dbCache = await TokenPriceModel.findOne({ tokenAddress: normalizedAddress });
        if (dbCache && dbCache.symbol && dbCache.name && dbCache.decimals) {
            const info: TokenInfo = {
                address: normalizedAddress,
                name: dbCache.name,
                symbol: dbCache.symbol,
                decimals: dbCache.decimals,
            };
            tokenInfoMemoryCache.set(normalizedAddress, info); // Populate memory cache
            logger.debug(`Token info found in database cache: ${normalizedAddress} -> ${info.symbol}`);
            return info;
        }
    } catch (dbError) {
        logger.error('Error reading token info from DB cache', { address: normalizedAddress, error: dbError });
    }
    
    // 3. Fetch from Moralis API and on-chain as a last resort
    logger.info(`Fetching fresh token info for ${normalizedAddress}`);
    try {
        // Try Moralis first for richer data (like logos)
        try {
            const response = await Moralis.EvmApi.token.getTokenMetadata({ 
                chain: "0x38", 
                addresses: [normalizedAddress] 
            });
            const moralisData = response.toJSON()[0];
            if (moralisData && moralisData.symbol) {
                const info: TokenInfo = {
                    address: normalizedAddress,
                    name: moralisData.name || 'Unknown Token',
                    symbol: moralisData.symbol,
                    decimals: parseInt(moralisData.decimals || '18'),
                    logo: moralisData.logo || undefined
                };
                await saveTokenInfoToCache(info);
                logger.info(`Token info fetched from Moralis: ${normalizedAddress} -> ${info.symbol}`);
                return info;
            }
        } catch (moralisError) {
            logger.debug(`Moralis metadata fetch failed for ${normalizedAddress}, falling back to direct contract call`, { error: moralisError });
        }

        // Fallback to direct on-chain call
        const contract = new ethers.Contract(normalizedAddress, ERC20_ABI_MINIMAL, provider);
        const [name, symbol, decimals] = await Promise.all([
            contract.name().catch(() => 'Unknown Token'),
            contract.symbol().catch(() => `TOKEN_${normalizedAddress.slice(2, 8).toUpperCase()}`),
            contract.decimals().catch(() => 18),
        ]);

        const info: TokenInfo = {
            address: normalizedAddress,
            name,
            symbol,
            decimals: Number(decimals),
        };

        await saveTokenInfoToCache(info);
        logger.info(`Token info fetched from on-chain: ${normalizedAddress} -> ${info.symbol}`);
        return info;

    } catch (fetchError) {
        logger.error('Failed to fetch token info', { address: normalizedAddress, error: fetchError });
        return null;
    }
}

/**
 * Gets only the token symbol quickly (optimized for TransactionDecoder)
 */
export async function getTokenSymbol(tokenAddress: string, provider: ethers.Provider): Promise<string> {
    const info = await getTokenInfo(tokenAddress, provider);
    if (info) {
        return info.symbol;
    }
    // Fallback placeholder
    return `TOKEN_${tokenAddress.slice(2, 8).toUpperCase()}`;
}

/**
 * Saves fetched token info to both memory and database cache.
 */
async function saveTokenInfoToCache(info: TokenInfo): Promise<void> {
    // Save to memory
    tokenInfoMemoryCache.set(info.address, info);

    // Save to database
    try {
        await TokenPriceModel.findOneAndUpdate(
            { tokenAddress: info.address },
            { 
                name: info.name,
                symbol: info.symbol,
                decimals: info.decimals,
                // We can update lastUpdated here to signify fresh data
                lastUpdated: new Date()
            },
            { upsert: true }
        );
        logger.debug(`Token info saved to database cache: ${info.address} -> ${info.symbol}`);
    } catch (dbError) {
        logger.error('Error saving token info to DB cache', { address: info.address, error: dbError });
    }
}

/**
 * Pre-populate cache with common BSC tokens for faster access
 */
export function preloadCommonTokens() {
    const commonTokens: TokenInfo[] = [
        {
            address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
            name: 'PancakeSwap Token',
            symbol: 'CAKE',
            decimals: 18
        },
        {
            address: '0x55d398326f99059ff775485246999027b3197955',
            name: 'Tether USD',
            symbol: 'USDT',
            decimals: 18
        },
        {
            address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 18
        },
        {
            address: '0xe9e7cea3dedca5984780bafc599bd69add087d56',
            name: 'BUSD Token',
            symbol: 'BUSD',
            decimals: 18
        },
        {
            address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
            name: 'Wrapped BNB',
            symbol: 'WBNB',
            decimals: 18
        }
    ];

    commonTokens.forEach(token => {
        tokenInfoMemoryCache.set(token.address, token);
    });

    logger.info(`Pre-loaded ${commonTokens.length} common tokens into memory cache`);
}