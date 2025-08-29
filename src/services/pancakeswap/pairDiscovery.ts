import { ethers, Contract } from 'ethers';
import { createLogger } from '@/utils/logger';
import { getBNBPrice } from '@/services/wallet/tokenPriceCache';
import { DexScreenerService } from '@/services/tokenSearch/dexScreenerService';

const logger = createLogger('services.pancakeswap.pairDiscovery');
const dexScreenerService = new DexScreenerService();

// PancakeSwap V2 Factory and Pair ABIs
const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint256)'
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)'
];

// BSC Constants
const BSC_RPC = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/';
const PANCAKESWAP_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD_ADDRESS = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const USD1_ADDRESS = '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d';
const DAI_ADDRESS = '0x1af3f329e8be154074d26654075ac426c1bca4a2';

// Common paired tokens in order of preference
const PAIRED_TOKENS = [
    { address: WBNB_ADDRESS, symbol: 'WBNB', decimals: 18 },
    { address: BUSD_ADDRESS, symbol: 'BUSD', decimals: 18 },
    { address: USDT_ADDRESS, symbol: 'USDT', decimals: 18 },
    { address: USD1_ADDRESS, symbol: 'USD1', decimals: 18 },
    { address: DAI_ADDRESS, symbol: 'DAI', decimals: 18 }
];

export interface TokenPairInfo {
    pairAddress: string;
    pairedToken: string;
    reserve0: string;
    reserve1: string;
    totalLiquidity: string;
    isToken0: boolean;
}

export interface TokenDiscoveryResult {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    currentPrice?: string;
    marketCap?: string;
    bestPair?: TokenPairInfo;
    allPairs: TokenPairInfo[];
}

export class PairDiscoveryService {
    private provider: ethers.JsonRpcProvider;
    private factory: Contract;

    constructor() {
        this.provider = new ethers.JsonRpcProvider(BSC_RPC);
        this.factory = new Contract(PANCAKESWAP_FACTORY, FACTORY_ABI, this.provider);
    }

    /**
     * Discover the best trading pair for a token and return comprehensive information
     */
    async discoverTokenPair(tokenAddress: string): Promise<TokenDiscoveryResult | null> {
        try {
            logger.info('Starting advanced token pair discovery', { tokenAddress });

            // First, try DexScreener for comprehensive discovery
            const dexDetails = await dexScreenerService.getTokenDetailsByAddress(tokenAddress);
            
            if (dexDetails && dexDetails.pairAddress && dexDetails.priceUsd) {
                logger.info('Found token pair via DexScreener', { 
                    symbol: dexDetails.symbol,
                    pairAddress: dexDetails.pairAddress,
                    price: dexDetails.priceUsd,
                    liquidity: dexDetails.liquidity
                });
                
                // Get basic token info (we still need this for total supply and decimals)
                const tokenInfo = await this.getTokenBasicInfo(tokenAddress);
                if (!tokenInfo) {
                    logger.warn('Failed to get basic token info via contract, using DexScreener data', { tokenAddress });
                    // Use DexScreener data as fallback
                    const estimatedDecimals = 18; // Most BSC tokens use 18 decimals
                    const result: TokenDiscoveryResult = {
                        address: dexDetails.address,
                        name: dexDetails.name,
                        symbol: dexDetails.symbol,
                        decimals: estimatedDecimals,
                        totalSupply: '0', // We can't get this from DexScreener alone
                        currentPrice: dexDetails.priceUsd.toString(),
                        marketCap: dexDetails.marketCap?.toString(),
                        bestPair: {
                            pairAddress: dexDetails.pairAddress,
                            pairedToken: 'USD', // DexScreener provides USD prices
                            reserve0: '0',
                            reserve1: '0',
                            totalLiquidity: (dexDetails.liquidity || 0).toString(),
                            isToken0: false
                        },
                        allPairs: [{
                            pairAddress: dexDetails.pairAddress,
                            pairedToken: 'USD',
                            reserve0: '0',
                            reserve1: '0',
                            totalLiquidity: (dexDetails.liquidity || 0).toString(),
                            isToken0: false
                        }]
                    };
                    return result;
                }

                // Construct result from DexScreener data
                const bestPair: TokenPairInfo = {
                    pairAddress: dexDetails.pairAddress,
                    pairedToken: 'USD', // DexScreener provides USD prices directly
                    reserve0: '0', // We don't need exact reserves since we have USD price
                    reserve1: '0',
                    totalLiquidity: (dexDetails.liquidity || 0).toString(),
                    isToken0: false
                };

                // Calculate market cap if we have total supply
                let calculatedMarketCap = dexDetails.marketCap?.toString();
                if (!calculatedMarketCap && tokenInfo.totalSupply && dexDetails.priceUsd) {
                    const totalSupplyNormalized = parseFloat(ethers.formatUnits(tokenInfo.totalSupply, tokenInfo.decimals));
                    const marketCapValue = totalSupplyNormalized * dexDetails.priceUsd;
                    calculatedMarketCap = marketCapValue.toString();
                }

                const result: TokenDiscoveryResult = {
                    ...tokenInfo,
                    currentPrice: dexDetails.priceUsd.toString(),
                    marketCap: calculatedMarketCap,
                    bestPair,
                    allPairs: [bestPair]
                };

                logger.info('Token pair discovery completed via DexScreener', { 
                    tokenAddress, 
                    bestPair: bestPair.pairAddress,
                    price: dexDetails.priceUsd,
                    liquidity: dexDetails.liquidity
                });

                return result;
            }

            // Fallback to manual PancakeSwap discovery if DexScreener fails
            logger.warn('DexScreener discovery failed, falling back to manual pair search', { tokenAddress });
            
            const tokenInfo = await this.getTokenBasicInfo(tokenAddress);
            if (!tokenInfo) {
                logger.error('Failed to get basic token info in fallback', { tokenAddress });
                return null;
            }

            const allPairs = await this.findAllPairs(tokenAddress);
            if (allPairs.length === 0) {
                logger.warn('No trading pairs found for token in fallback', { tokenAddress });
                return {
                    ...tokenInfo,
                    allPairs: []
                };
            }

            const bestPair = this.selectBestPair(allPairs);
            const { currentPrice, marketCap } = await this.calculatePriceAndMarketCap(tokenInfo, bestPair);

            const result: TokenDiscoveryResult = {
                ...tokenInfo,
                currentPrice,
                marketCap,
                bestPair,
                allPairs
            };

            logger.info('Token pair discovery completed via fallback', { 
                tokenAddress, 
                bestPair: bestPair.pairAddress,
                pairsFound: allPairs.length 
            });

            return result;

        } catch (error) {
            logger.error('Error in advanced token pair discovery', { error, tokenAddress });
            return null;
        }
    }

    /**
     * Get basic token information from contract
     */
    private async getTokenBasicInfo(tokenAddress: string): Promise<{
        address: string;
        name: string;
        symbol: string;
        decimals: number;
        totalSupply: string;
    } | null> {
        try {
            const contract = new Contract(tokenAddress, ERC20_ABI, this.provider);

            const [name, symbol, decimals, totalSupply] = await Promise.all([
                contract.name(),
                contract.symbol(),
                contract.decimals(),
                contract.totalSupply()
            ]);

            return {
                address: tokenAddress,
                name,
                symbol,
                decimals: Number(decimals),
                totalSupply: totalSupply.toString()
            };
        } catch (error) {
            logger.error('Error getting token basic info', { error, tokenAddress });
            return null;
        }
    }

    /**
     * Find all available pairs for the token
     */
    private async findAllPairs(tokenAddress: string): Promise<TokenPairInfo[]> {
        const pairs: TokenPairInfo[] = [];

        for (const pairedToken of PAIRED_TOKENS) {
            try {
                const pairAddress = await this.factory.getPair(tokenAddress, pairedToken.address);
                
                if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                    const pairInfo = await this.getPairInfo(pairAddress, tokenAddress, pairedToken);
                    if (pairInfo) {
                        pairs.push(pairInfo);
                    }
                }
            } catch (error) {
                logger.warn('Error checking pair', { 
                    error, 
                    tokenAddress, 
                    pairedWith: pairedToken.symbol 
                });
            }
        }

        return pairs;
    }

    /**
     * Get detailed information about a specific pair
     */
    private async getPairInfo(
        pairAddress: string, 
        tokenAddress: string, 
        pairedToken: { address: string; symbol: string; decimals: number }
    ): Promise<TokenPairInfo | null> {
        try {
            const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);

            const [token0Address, reserves, totalSupply] = await Promise.all([
                pairContract.token0(),
                pairContract.getReserves(),
                pairContract.totalSupply()
            ]);

            const isToken0 = token0Address.toLowerCase() === tokenAddress.toLowerCase();

            return {
                pairAddress,
                pairedToken: pairedToken.symbol,
                reserve0: reserves[0].toString(),
                reserve1: reserves[1].toString(),
                totalLiquidity: totalSupply.toString(),
                isToken0
            };
        } catch (error) {
            logger.error('Error getting pair info', { error, pairAddress });
            return null;
        }
    }

    /**
     * Select the best pair based on liquidity
     */
    private selectBestPair(pairs: TokenPairInfo[]): TokenPairInfo {
        return pairs.reduce((best, current) => {
            const bestLiquidity = BigInt(best.totalLiquidity);
            const currentLiquidity = BigInt(current.totalLiquidity);
            return currentLiquidity > bestLiquidity ? current : best;
        });
    }

    /**
     * Calculate current price and market cap in USD
     */
    private async calculatePriceAndMarketCap(
        tokenInfo: { decimals: number; totalSupply: string },
        pairInfo: TokenPairInfo
    ): Promise<{ currentPrice?: string; marketCap?: string }> {
        try {
            const reserve0 = BigInt(pairInfo.reserve0);
            const reserve1 = BigInt(pairInfo.reserve1);

            if (reserve0 === 0n || reserve1 === 0n) {
                return {};
            }

            // Calculate price based on reserves
            const [tokenReserve, pairedTokenReserve] = pairInfo.isToken0 
                ? [reserve0, reserve1] 
                : [reserve1, reserve0];

            // Price = pairedTokenReserve / tokenReserve (normalized for decimals)
            const price = (pairedTokenReserve * BigInt(1e18)) / tokenReserve;
            let priceInPairedToken = parseFloat(ethers.formatEther(price));

            // Convert to USD based on paired token
            let priceInUSD = priceInPairedToken;
            if (pairInfo.pairedToken === 'WBNB') {
                // Convert WBNB price to USD
                const bnbPrice = await getBNBPrice();
                priceInUSD = priceInPairedToken * bnbPrice;
            }
            // For BUSD and USDT, price is already in USD terms
            
            const currentPrice = priceInUSD.toString();

            // Calculate market cap in USD
            const totalSupply = BigInt(tokenInfo.totalSupply);
            const totalSupplyNormalized = parseFloat(ethers.formatUnits(totalSupply, tokenInfo.decimals));
            const marketCapValue = totalSupplyNormalized * priceInUSD;
            const marketCap = marketCapValue.toString();

            return {
                currentPrice,
                marketCap
            };
        } catch (error) {
            logger.error('Error calculating price and market cap', { error });
            return {};
        }
    }

    /**
     * Get current price for an existing pair in USD
     */
    async getCurrentPrice(pairAddress: string, isToken0: boolean, pairedToken?: string): Promise<string> {
        try {
            const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
            const reserves = await pairContract.getReserves();
            
            const reserve0 = BigInt(reserves[0]);
            const reserve1 = BigInt(reserves[1]);

            if (reserve0 === 0n || reserve1 === 0n) {
                return '0';
            }

            const [tokenReserve, pairedTokenReserve] = isToken0 
                ? [reserve0, reserve1] 
                : [reserve1, reserve0];

            const price = (pairedTokenReserve * BigInt(1e18)) / tokenReserve;
            let priceInPairedToken = parseFloat(ethers.formatEther(price));

            // Convert to USD if we know the paired token
            if (pairedToken === 'WBNB') {
                const bnbPrice = await getBNBPrice();
                const priceInUSD = priceInPairedToken * bnbPrice;
                return priceInUSD.toString();
            }

            // For BUSD/USDT or unknown paired tokens, return as-is
            return priceInPairedToken.toString();
        } catch (error) {
            logger.error('Error getting current price', { error, pairAddress });
            return '0';
        }
    }
}

export const pairDiscoveryService = new PairDiscoveryService();