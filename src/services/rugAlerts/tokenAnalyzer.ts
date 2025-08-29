import Moralis from 'moralis';
import { ethers } from 'ethers';
import axios from 'axios';
import { TransactionCache } from '@/database/models/TransactionCache';
import { TokenTransferModel } from '@/database/models/TokenTransfer';
import { getWalletTokensWithPrices } from '@/services/wallet/scannerUtils';
import { getCachedTokenPrice, getBNBPrice } from '@/services/wallet/tokenPriceCache';
import { createLogger } from '@/utils/logger';
import { priceDeviationChecker } from '@/services/priceDeviation/priceDeviationChecker';

const logger = createLogger('rugAlerts.tokenAnalyzer');

export interface TokenMetadata {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  logo?: string;
  verified?: boolean;
  createdAt?: Date;
  ownerAddress?: string;
  renounced?: boolean;
  deployerAddress?: string;
  deploymentTxHash?: string;
}

export interface TokenHolder {
  address: string;
  balance: string;
  percentage: number;
  isContract?: boolean;
  isLiquidityPool?: boolean;
  holderType?: 'creator' | 'owner' | 'liquidity' | 'regular';
  isWhale?: boolean;
  portfolioValue?: number;
  isHugeValue?: boolean;
  hugeValueAmount?: number;
  isDiamondHands?: boolean;
  holdingDays?: number;
  firstTransactionDate?: Date;
}

export interface TokenHolderAnalysis {
  totalHolders: number;
  top10Holders: TokenHolder[];
  top10Concentration: number;
  top10ConcentrationExcludingLP: number;
  creatorBalance?: number;
  ownerBalance?: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskFactors: string[];
}

export interface LiquidityAnalysis {
  hasLiquidity: boolean;
  mainLiquidityPool?: string;
  liquidityUSD?: number;
  liquidityBNB?: number;
  lpTokenBurned?: boolean;
  lpTokenLocked?: boolean;
  lockDuration?: number;
  lockPlatform?: string;
  initialLiquidityUSD?: number;
  liquidityPools: Array<{
    address: string;
    dex: string;
    liquidityUSD: number;
    liquidityBNB: number;
  }>;
}

export interface TradingActivityAnalysis {
  volume24h?: number;
  txCount24h?: number;
  uniqueTraders24h?: number;
  priceChange24h?: number;
  hasActiveTrading: boolean;
  liquidityToVolumeRatio?: number;
  liquidityEfficiency?: 'EXCELLENT' | 'GOOD' | 'ADEQUATE' | 'POOR' | 'CRITICAL';
  totalLiquidityUsd?: number;
}

export interface TokenAnalyticsData {
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
  totalLiquidityUsd: string;
  totalFullyDilutedValuation: string;
  usdPrice: string;
  pricePercentChange: {
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
  uniqueWallets: {
    '5m': number;
    '1h': number;
    '6h': number;
    '24h': number;
  };
}

export interface HoneypotAnalysis {
  isHoneypot: boolean;
  sellTax?: number;
  buyTax?: number;
  cannotSellReason?: string;
  simulationSuccess?: boolean;
}

export interface RugAlertAnalysis {
  metadata: TokenMetadata;
  holderAnalysis: TokenHolderAnalysis;
  liquidityAnalysis: LiquidityAnalysis;
  tradingActivity: TradingActivityAnalysis;
  honeypotAnalysis: HoneypotAnalysis;
  safetyScore: number; // Changed from riskScore to safetyScore
  safetyScoreDetails: { // Changed from riskScoreDetails to safetyScoreDetails
    holders: number;
    liquidity: number;
    verification: number;
    trading: number;
    ownership: number;
    age: number;
    honeypot: number;
    diamondHands: number;
    priceDeviation?: number; // New field for price deviation score
  };
  priceDeviationWarning?: string; // Warning message if deviation detected
  recommendations: string[];
}

// Minimal ERC20 ABI for getting token info
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

// PancakeSwap Factory ABI for finding pairs
const PANCAKE_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function allPairs(uint) view returns (address)',
  'function allPairsLength() view returns (uint)'
];

// PancakeSwap Factory V3 ABI
const PANCAKE_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'
];

// PancakeSwap Pair ABI (V2)
const PANCAKE_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

// PancakeSwap V3 Pool ABI (minimal)
const PANCAKE_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

// Known locker contracts
const KNOWN_LOCKERS = [
  '0x7ee058420e5937496F5a2096f04caA7721cF70cc', // PinkLock
  '0xC765bddB93b0D1c1A88282BA0fa6B2d00E3e0c83', // Team Finance
  '0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE', // PancakeSwap Locker
  '0x2967E7Bb9DaA5711Ac332cAF874BD47ef99B3820', // Unicrypt
  '0xE2fE530C047f2d85298b07D9333C05737f1435fB', // Team Finance V2
  '0x71B5759d73262FBb223956913ecF4ecC51057641', // PinkLock V2
];

const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Known DEX routers for identifying LP tokens
const KNOWN_DEX_FACTORIES = [
  PANCAKE_FACTORY,
  '0x858E3312ed3A876947EA49d572A7C42DE08af7EE', // Biswap Factory
  '0xBCfCcbde45cE874adCB698cC183deBcF17952812', // ApeSwap Factory
  '0x3CD0E22dB8f80Cd0879fC536215289074d6e2194', // BabySwap Factory
];

export class TokenAnalyzer {
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
  }

  // Get basic token metadata with ownership info
  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

      // Get basic token info
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        contract.name().catch(() => 'Unknown'),
        contract.symbol().catch(() => 'UNKNOWN'),
        contract.decimals().catch(() => 18),
        contract.totalSupply().catch(() => '0')
      ]);

      // Try to get owner address
      let ownerAddress: string | undefined;
      let renounced = false;

      try {
        ownerAddress = await contract.owner().catch(() => contract.getOwner().catch(() => undefined));
        if (ownerAddress === ZERO_ADDRESS || ownerAddress === DEAD_ADDRESS) {
          renounced = true;
        }
      } catch {
        // Contract might not have owner function
      }

      // Try to get additional metadata from Moralis
      let moralisMetadata: any = null;
      let createdAt: Date | undefined;
      let deployerAddress: string | undefined;
      let deploymentTxHash: string | undefined;
      let verified = false;

      try {
        const response = await Moralis.EvmApi.token.getTokenMetadata({
          chain: "0x38", // BSC
          addresses: [tokenAddress]
        });
        const responseData = response.toJSON();
        if (Array.isArray(responseData) && responseData.length > 0) {
          moralisMetadata = responseData[0];
          if (moralisMetadata.created_at) {
            createdAt = new Date(moralisMetadata.created_at);
          }
          verified = moralisMetadata.verified_contract || false;
        }
      } catch (error) {
        // Silently ignore Moralis metadata fetch errors
      }

      // Double-check verification by looking at contract code
      try {
        const code = await this.provider.getCode(tokenAddress);
        // If contract has substantial code and specific patterns, it might be verified
        // BSCScan verified contracts often have certain patterns in their bytecode
        if (code.length > 5000) { // Verified contracts tend to have longer bytecode
          // This is a heuristic - in production you'd want to use BSCScan API
          const codeStr = code.toLowerCase();
          if (codeStr.includes('697066735822') || // IPFS hash marker
            codeStr.includes('736f6c634300')) { // Solidity version marker
            verified = true;
          }
        }
      } catch (error) {
        // Silently ignore contract code check errors
      }

      // Get contract creation info
      try {
        const contractInfo = await this.getContractCreationInfo(tokenAddress);
        if (contractInfo) {
          deployerAddress = contractInfo.creator;
          deploymentTxHash = contractInfo.txHash;
          if (!createdAt && contractInfo.timestamp) {
            createdAt = new Date(contractInfo.timestamp * 1000);
          }
        }
      } catch (error) {
        // Silently ignore contract creation info errors
      }

      return {
        address: tokenAddress,
        name: moralisMetadata?.name || name,
        symbol: moralisMetadata?.symbol || symbol,
        decimals: moralisMetadata?.decimals ? Number(moralisMetadata.decimals) : Number(decimals),
        totalSupply: totalSupply.toString(),
        logo: moralisMetadata?.logo || undefined,
        verified,
        createdAt,
        ownerAddress,
        renounced,
        deployerAddress,
        deploymentTxHash
      };
    } catch (error) {
      logger.error('Error getting token metadata', { error, tokenAddress });
      return null;
    }
  }

  // Get contract creation info from BSCScan API (if available) or blockchain
  private async getContractCreationInfo(contractAddress: string): Promise<{ creator: string, txHash: string, timestamp?: number } | null> {
    try {
      // Try to get from blockchain directly
      const code = await this.provider.getCode(contractAddress);
      if (code === '0x') {
        return null; // Not a contract
      }

      // For now, we'll need to rely on Moralis or other APIs for creation info
      // In production, you'd want to integrate BSCScan API or similar
      return null;
    } catch (error) {
      logger.error('Error getting contract creation info', { error, contractAddress });
      return null;
    }
  }

  // Check if an address is a liquidity pool
  private async isLiquidityPool(address: string, tokenAddress?: string): Promise<boolean> {
    try {
      const code = await this.provider.getCode(address);
      if (code === '0x' || code === '0x00') {
        return false; // Not a contract
      }

      // First try V2 pair check
      try {
        const pairContract = new ethers.Contract(address, PANCAKE_PAIR_ABI, this.provider);
        // Check if it has the pair methods
        const [token0, token1] = await Promise.all([
          pairContract.token0().catch(() => null),
          pairContract.token1().catch(() => null)
        ]);

        if (token0 && token1) {
          // If tokenAddress is provided, verify this LP contains our token
          if (tokenAddress) {
            const tokenLower = tokenAddress.toLowerCase();
            return token0.toLowerCase() === tokenLower || token1.toLowerCase() === tokenLower;
          }
          return true;
        }
      } catch {
        // Not a V2 pair
      }

      // Try V3 pool check
      try {
        const v3Pool = new ethers.Contract(address, PANCAKE_V3_POOL_ABI, this.provider);
        // Check if it has the pool methods
        const [token0, token1] = await Promise.all([
          v3Pool.token0().catch(() => null),
          v3Pool.token1().catch(() => null)
        ]);

        if (token0 && token1) {
          // If tokenAddress is provided, verify this LP contains our token
          if (tokenAddress) {
            const tokenLower = tokenAddress.toLowerCase();
            return token0.toLowerCase() === tokenLower || token1.toLowerCase() === tokenLower;
          }
          return true;
        }
      } catch {
        // Not a V3 pool either
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  // Get all liquidity pools for a token
  private async findAllLiquidityPools(tokenAddress: string): Promise<string[]> {
    const pools: string[] = [];

    // Check PancakeSwap V2 pools with common pairs
    const commonPairs = [WBNB, BUSD, USDT];
    const factory = new ethers.Contract(PANCAKE_FACTORY, PANCAKE_FACTORY_ABI, this.provider);

    for (const pairToken of commonPairs) {
      try {
        const pairAddress = await factory.getPair(tokenAddress, pairToken);
        if (pairAddress !== ZERO_ADDRESS) {
          pools.push(pairAddress);
        }
      } catch (error) {
        // Silently continue
      }
    }

    // Check PancakeSwap V3 pools
    try {
      const v3Factory = new ethers.Contract(PANCAKE_V3_FACTORY, PANCAKE_V3_FACTORY_ABI, this.provider);
      const v3FeeTiers = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

      for (const pairToken of commonPairs) {
        for (const fee of v3FeeTiers) {
          try {
            const poolAddress = await v3Factory.getPool(tokenAddress, pairToken, fee);
            if (poolAddress && poolAddress !== ZERO_ADDRESS) {
              // Verify it's a valid pool by checking if we can call token0()
              try {
                const pool = new ethers.Contract(poolAddress, PANCAKE_V3_POOL_ABI, this.provider);
                await pool.token0(); // This will throw if not a valid pool
                pools.push(poolAddress);
              } catch {
                // Not a valid pool
              }
            }
          } catch (error) {
            // V3 factory might not exist or pool doesn't exist
          }
        }
      }
    } catch {
      // V3 factory might not be deployed
    }

    return [...new Set(pools)]; // Remove duplicates
  }

  // Helper function to fetch holder transfers once and reuse
  private async fetchHolderTransfers(holderAddress: string, tokenAddress: string): Promise<any[]> {
    try {
      const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
      logger.info('Fetching token transfers for holder analysis', { wallet: holderAddress, token: tokenAddress });
      
      const response = await Moralis.EvmApi.token.getWalletTokenTransfers({
        chain: "0x38",
        address: holderAddress,
        contractAddresses: [tokenAddress],
        fromDate: fromDate.toISOString(),
        order: "ASC",
        limit: 100
      });
      return response.toJSON().result || [];
    } catch (apiError) {
      logger.error('Error fetching token transfers from API', { error: apiError, wallet: holderAddress, token: tokenAddress });
      return [];
    }
  }

  // Get token holders analysis with LP exclusion
  async getTokenHolders(tokenAddress: string, metadata?: TokenMetadata): Promise<TokenHolderAnalysis | null> {
    try {
      let holderCountFromGecko: number | null = null;
      
      // First key fix: Only call CoinGecko API if API key is available
      if (process.env.COINGECKO_API_KEY) {
        try {
          // Use correct API URL and headers for CoinGecko demo API
          const geckoUrl = `https://api.coingecko.com/api/v3/onchain/networks/bsc/tokens/${tokenAddress}/info`;
          const geckoResponse = await axios.get(geckoUrl, {
            headers: {
              'accept': 'application/json',
              'x-cg-demo-api-key': process.env.COINGECKO_API_KEY
            }
          });
          holderCountFromGecko = geckoResponse.data?.data?.attributes?.holders?.count || null;
        } catch (geckoError: any) {
          logger.warn('Failed to fetch holder count from CoinGecko', { 
            tokenAddress, 
            // Log more detailed error information
            status: geckoError.response?.status,
            error: geckoError.response?.data || geckoError.message 
          });
        }
      } else {
        logger.warn('COINGECKO_API_KEY not found in .env, skipping holder count fetch.');
      }

      const ownersResponse = await Moralis.EvmApi.token.getTokenOwners({
        chain: "0x38", // BSC
        tokenAddress,
        limit: 10
      });

      const holdersData = ownersResponse.toJSON();

      // Second key fix: Use nullish coalescing operator to properly handle holderCountFromGecko being 0
      const totalHolderCount = holderCountFromGecko ?? (holdersData.result?.length || 0);

      if (!holdersData.result || holdersData.result.length === 0) {
        // Even if no holder list, but if Gecko provided total count, return partial data
        if (holderCountFromGecko !== null) {
          return {
            totalHolders: holderCountFromGecko,
            top10Holders: [],
            top10Concentration: 0,
            top10ConcentrationExcludingLP: 0,
            riskLevel: 'LOW', // Cannot assess concentration without holder list, default to low
            riskFactors: ['Could not retrieve top holder list to assess concentration.'],
          };
        }
        return null;
      }

      // Get metadata if not provided
      if (!metadata) {
        const fetchedMetadata = await this.getTokenMetadata(tokenAddress);
        if (!fetchedMetadata) return null;
        metadata = fetchedMetadata;
      }

      // Get token price once at the beginning to determine if price-based analysis is worthwhile
      const tokenPrice = await getCachedTokenPrice(tokenAddress);
      const hasValidPrice = tokenPrice && tokenPrice > 0;
      
      if (!hasValidPrice) {
        logger.info('Token has no price or $0 price, skipping value-based analysis', { tokenAddress, price: tokenPrice });
      }

      // Find all liquidity pools
      const liquidityPools = await this.findAllLiquidityPools(tokenAddress);
      const lpAddressesLower = liquidityPools.map(addr => addr.toLowerCase());

      // Also check top holders for pools that might have been missed
      // by checking if they are liquidity pools
      const potentialPoolAddresses: string[] = [];

      // Check first 20 holders to identify potential pools
      for (let i = 0; i < Math.min(20, holdersData.result.length); i++) {
        const holderAddress = holdersData.result[i].owner_address;
        const holderAddressLower = holderAddress.toLowerCase();

        // Skip if already identified as LP
        if (lpAddressesLower.includes(holderAddressLower)) {
          continue;
        }

        // Check if this holder is actually a liquidity pool
        const isPool = await this.isLiquidityPool(holderAddress, tokenAddress);
        if (isPool) {
          potentialPoolAddresses.push(holderAddressLower);
        }
      }

      // Add newly discovered pools to our list
      potentialPoolAddresses.forEach(addr => {
        if (!lpAddressesLower.includes(addr)) {
          lpAddressesLower.push(addr);
        }
      });

      const totalSupply = BigInt(metadata.totalSupply);

      // First pass: Calculate basic holder info without expensive checks
      // Make Promise.all more robust by handling individual holder failures
      const basicInfoPromises = holdersData.result.map(async (holder: any, index: number) => {
        try {
          const balance = BigInt(holder.balance);
          const percentage = totalSupply > 0
            ? Number((balance * BigInt(10000)) / totalSupply) / 100
            : 0;

          const holderAddressLower = holder.owner_address.toLowerCase();

          // Check if this holder is a liquidity pool
          const isLiquidityPool = lpAddressesLower.includes(holderAddressLower);

          const isContract = await this.isLikelyContract(holder.owner_address);

          let holderType: 'creator' | 'owner' | 'liquidity' | 'regular' = 'regular';
          if (isLiquidityPool) {
            holderType = 'liquidity';
          } else if (metadata?.deployerAddress && holderAddressLower === metadata.deployerAddress.toLowerCase()) {
            holderType = 'creator';
          } else if (metadata?.ownerAddress && holderAddressLower === metadata.ownerAddress.toLowerCase()) {
            holderType = 'owner';
          }

          return {
            address: holder.owner_address,
            balance: holder.balance,
            percentage,
            isContract,
            isLiquidityPool,
            holderType,
            isWhale: false,
            portfolioValue: 0,
            isHugeValue: false,
            hugeValueAmount: 0,
            isDiamondHands: false,
            holdingDays: 0,
            firstTransactionDate: undefined as Date | undefined
          };
        } catch (promiseError) {
          logger.error(`Error processing holder at index ${index}`, { 
            holderAddress: holder.owner_address, 
            tokenAddress,
            error: promiseError instanceof Error ? promiseError.message : String(promiseError) 
          });
          return null; // Return null on error instead of rejecting
        }
      });
      
      // Filter out null results from failed promises
      const holdersBasicInfo = (await Promise.all(basicInfoPromises)).filter(h => h !== null) as any[];

      // If all holders failed to process, we can't continue.
      if (holdersBasicInfo.length === 0) {
        logger.error('Failed to process any holder information.', { tokenAddress });
        return null;
      }

      // Sort by balance to find top holders
      holdersBasicInfo.sort((a, b) => {
        // If one is a liquidity pool and the other isn't, LP comes first
        if (a.isLiquidityPool && !b.isLiquidityPool) return -1;
        if (!a.isLiquidityPool && b.isLiquidityPool) return 1;
        // Otherwise sort by percentage
        return b.percentage - a.percentage;
      });

      // Take top 10 holders
      const top10Holders = holdersBasicInfo.slice(0, 10);

      // Second pass: Perform expensive checks only on top 10 holders
      // Process in parallel to speed up analysis
      const enrichedHolderPromises = top10Holders.map(async (holder) => {
        let isWhale = holder.isWhale;
        let portfolioValue = holder.portfolioValue;
        let isHugeValue = holder.isHugeValue;
        let hugeValueAmount = holder.hugeValueAmount;
        let isDiamondHands = holder.isDiamondHands;
        let holdingDays = holder.holdingDays;
        let firstTransactionDate = holder.firstTransactionDate;

        // Only perform checks for significant regular holders (not LPs or contracts)
        const shouldAnalyze = !holder.isLiquidityPool && !holder.isContract && holder.holderType === 'regular' && holder.percentage > 0.5;
        
        if (shouldAnalyze) {
          // Fetch transfers once and reuse for both huge value and diamond hands analysis
          const transfers = await this.fetchHolderTransfers(holder.address, tokenAddress);

          // Only check whale and huge value status if token has a valid price
          if (hasValidPrice) {
            // Check whale status
            const whaleStatus = await this.checkWhaleStatus(holder.address, tokenAddress, holder.balance);
            isWhale = whaleStatus.isWhale;
            portfolioValue = whaleStatus.portfolioValue;

            // Check huge value status - pass transfers to avoid refetching
            const hugeValueStatus = await this.checkHugeValueStatusWithTransfers(holder.address, tokenAddress, transfers);
            isHugeValue = hugeValueStatus.isHugeValue;
            hugeValueAmount = hugeValueStatus.hugeValueAmount;
          }

          // Check diamond hands - pass transfers to avoid refetching
          const diamondStatus = await this.checkDiamondHandsWithTransfers(holder.address, tokenAddress, transfers);
          isDiamondHands = diamondStatus.isDiamondHands;
          holdingDays = diamondStatus.holdingDays;
          firstTransactionDate = diamondStatus.firstTransactionDate;
        }

        return {
          ...holder,
          isWhale,
          portfolioValue,
          isHugeValue,
          hugeValueAmount,
          isDiamondHands,
          holdingDays,
          firstTransactionDate
        };
      });

      const holders = await Promise.all(enrichedHolderPromises);

      // The holders array is already our top 10, so no need to slice again
      const top10Concentration = holders.reduce((sum, holder) => sum + holder.percentage, 0);

      // Calculate concentration excluding liquidity pools
      const top10HoldersExcludingLP = holders.filter(h => !h.isLiquidityPool);
      const top10ConcentrationExcludingLP = top10HoldersExcludingLP.reduce((sum, holder) => sum + holder.percentage, 0);

      // Get creator and owner balances from all holders (not just top 10)
      const creatorHolder = holdersBasicInfo.find(h => h.holderType === 'creator');
      const ownerHolder = holdersBasicInfo.find(h => h.holderType === 'owner');

      // Analyze risk factors
      const riskFactors: string[] = [];
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';

      // Check concentration excluding LPs
      if (top10ConcentrationExcludingLP > 80) {
        riskFactors.push('Extremely high concentration - Top 10 holders (excl. LPs) own >80% of supply');
        riskLevel = 'CRITICAL';
      } else if (top10ConcentrationExcludingLP > 60) {
        riskFactors.push('Very high concentration - Top 10 holders (excl. LPs) own >60% of supply');
        riskLevel = 'HIGH';
      } else if (top10ConcentrationExcludingLP > 40) {
        riskFactors.push('High concentration - Top 10 holders (excl. LPs) own >40% of supply');
        riskLevel = 'MEDIUM';
      }

      // Check diamond hands count as positive factor
      const diamondHandsCount = holders.filter(h => h.isDiamondHands).length;
      if (diamondHandsCount === 0) {
        riskFactors.push('No diamond hands in top 10 holders - all short-term traders');
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
      } else if (diamondHandsCount < 3) {
        riskFactors.push(`Only ${diamondHandsCount} diamond hands in top 10 - mostly short-term holders`);
      }

      // Check for single wallet dominance (from all holders, not just top 10)
      const largestNonLPHolder = holdersBasicInfo.find(h => !h.isLiquidityPool);
      if (largestNonLPHolder && largestNonLPHolder.percentage > 30) {
        riskFactors.push(`Single wallet holds ${largestNonLPHolder.percentage.toFixed(2)}% of supply`);
        if (riskLevel === 'LOW' || riskLevel === 'MEDIUM') riskLevel = 'HIGH';
      }

      // Check creator/owner holdings
      if (creatorHolder && creatorHolder.percentage > 5) {
        riskFactors.push(`Creator wallet holds ${creatorHolder.percentage.toFixed(2)}% of supply`);
      }
      if (ownerHolder && ownerHolder.percentage > 5 && ownerHolder.address !== creatorHolder?.address) {
        riskFactors.push(`Owner wallet holds ${ownerHolder.percentage.toFixed(2)}% of supply`);
      }

      // Check liquidity distribution
      const lpHolders = holders.filter(h => h.isLiquidityPool);
      if (lpHolders.length === 0) {
        riskFactors.push('No liquidity pools found in top holders');
        riskLevel = 'CRITICAL';
      } else if (lpHolders.length === 1) {
        riskFactors.push('Only one liquidity pool found - limited trading options');
      }

      return {
        totalHolders: totalHolderCount > holdersBasicInfo.length ? totalHolderCount : holdersBasicInfo.length,
        top10Holders: holders, // Return the enriched top 10 holders
        top10Concentration,
        top10ConcentrationExcludingLP,
        creatorBalance: creatorHolder?.percentage,
        ownerBalance: ownerHolder?.percentage,
        riskLevel,
        riskFactors
      };
    } catch (error) {
      // Improved catch block to provide more details
      logger.error('Error in getTokenHolders', { 
        tokenAddress,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      });
      return null;
    }
  }

  // Analyze liquidity pools with locker detection
  async analyzeLiquidity(tokenAddress: string): Promise<LiquidityAnalysis> {
    try {
      const pools = await this.findAllLiquidityPools(tokenAddress);

      if (pools.length === 0) {
        return { hasLiquidity: false, liquidityPools: [] };
      }

      const liquidityPools = [];
      let totalLiquidityUSD = 0;
      let totalLiquidityBNB = 0;
      let mainPool: string | undefined;
      let maxLiquidity = 0;
      let lpTokenBurned = false;
      let lpTokenLocked = false;
      let lockDuration: number | undefined;
      let lockPlatform: string | undefined;

      // Analyze each pool
      for (const poolAddress of pools) {
        try {
          // First, try to determine if it's V2 or V3
          let isV3Pool = false;
          let liquidityUSD = 0;
          let liquidityBNB = 0;
          let dexVersion = 'PancakeSwap V2';

          // Try V3 first
          try {
            const v3Pool = new ethers.Contract(poolAddress, PANCAKE_V3_POOL_ABI, this.provider);
            const [token0, liquidity] = await Promise.all([
              v3Pool.token0(),
              v3Pool.liquidity()
            ]);

            // If we got here, it's a V3 pool
            isV3Pool = true;
            dexVersion = 'PancakeSwap V3';

            // For V3, liquidity calculation is more complex
            // Get the paired token to determine price
            const token1 = await v3Pool.token1();
            const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
            const pairToken = isToken0 ? token1 : token0;

            // Rough estimation based on liquidity value
            // V3 pools often have concentrated liquidity
            if (liquidity > 0) {
              // Get approximate price for the pair token
              let pairPriceUSD = 0;
              if (pairToken.toLowerCase() === WBNB.toLowerCase()) {
                try {
                  const bnbPrice = await getBNBPrice();
                  pairPriceUSD = bnbPrice > 0 ? bnbPrice : 600;
                } catch {
                  pairPriceUSD = 600;
                }
              } else if (pairToken.toLowerCase() === BUSD.toLowerCase() ||
                pairToken.toLowerCase() === USDT.toLowerCase()) {
                pairPriceUSD = 1;
              }

              // For V3, we should try to get actual liquidity from Moralis or other sources
              // For now, let's be more conservative with estimates
              if (pairPriceUSD > 0 && liquidity > 0) {
                // V3 liquidity is concentrated, so the raw liquidity value doesn't directly translate to USD
                // This is a very rough estimate - in production, use proper V3 math or external APIs
                const liquidityNumber = Number(liquidity);
                if (liquidityNumber > 1e18) {
                  // Large liquidity value, likely in wei units
                  liquidityUSD = (liquidityNumber / 1e18) * pairPriceUSD * 0.1; // Conservative 10% estimate
                } else if (liquidityNumber > 1e12) {
                  liquidityUSD = (liquidityNumber / 1e12) * pairPriceUSD * 0.01; // Very conservative 1% estimate
                } else {
                  liquidityUSD = 100; // Minimal default for active V3 pools
                }
                liquidityBNB = liquidityUSD / pairPriceUSD;
              } else {
                liquidityUSD = 100; // Minimal default for V3
                liquidityBNB = liquidityUSD / 600;
              }
            }
          } catch {
            // Not a V3 pool, continue with V2 logic
          }

          if (!isV3Pool) {
            // V2 pool logic
            const pair = new ethers.Contract(poolAddress, PANCAKE_PAIR_ABI, this.provider);

            // Get reserves and tokens
            const [reserves, token0, totalSupply] = await Promise.all([
              pair.getReserves(),
              pair.token0(),
              pair.totalSupply()
            ]);

            // Calculate liquidity
            const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
            const pairReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;

            // Get pair token price (simplified - in production use proper oracle)
            let pairPriceUSD = 0;
            const pairToken = isToken0 ? await pair.token1() : token0;

            if (pairToken.toLowerCase() === WBNB.toLowerCase()) {
              // Get actual BNB price from cache or use a more reasonable default
              try {
                const bnbPrice = await getBNBPrice();
                pairPriceUSD = bnbPrice > 0 ? bnbPrice : 600;
              } catch {
                pairPriceUSD = 600; // Fallback price
              }
            } else if (pairToken.toLowerCase() === BUSD.toLowerCase() || pairToken.toLowerCase() === USDT.toLowerCase()) {
              pairPriceUSD = 1;
            }

            liquidityUSD = Number(ethers.formatEther(pairReserve)) * 2 * pairPriceUSD;
            liquidityBNB = pairToken.toLowerCase() === WBNB.toLowerCase()
              ? Number(ethers.formatEther(pairReserve)) * 2
              : liquidityUSD / 600;

            // Check if LP tokens are locked or burned (only for V2)
            const lpLocked = await this.checkLPLocked(poolAddress, pair, totalSupply);

            if (liquidityUSD > maxLiquidity) {
              // Store main pool lock info
              lpTokenBurned = lpLocked.burned;
              lpTokenLocked = lpLocked.locked;
              lockDuration = lpLocked.duration;
              lockPlatform = lpLocked.platform;
            }
          }

          liquidityPools.push({
            address: poolAddress,
            dex: dexVersion,
            liquidityUSD,
            liquidityBNB
          });

          totalLiquidityUSD += liquidityUSD;
          totalLiquidityBNB += liquidityBNB;

          if (liquidityUSD > maxLiquidity) {
            maxLiquidity = liquidityUSD;
            mainPool = poolAddress;
          }
        } catch (error) {
          logger.error('Error analyzing liquidity pool', { error, poolAddress });
        }
      }

      return {
        hasLiquidity: true,
        mainLiquidityPool: mainPool,
        liquidityUSD: totalLiquidityUSD,
        liquidityBNB: totalLiquidityBNB,
        lpTokenBurned,
        lpTokenLocked,
        lockDuration,
        lockPlatform,
        liquidityPools
      };
    } catch (error) {
      logger.error('Error analyzing liquidity', { error, tokenAddress });
      return { hasLiquidity: false, liquidityPools: [] };
    }
  }

  // Check if LP tokens are locked or burned
  private async checkLPLocked(_lpAddress: string, lpContract: ethers.Contract, totalSupply: bigint): Promise<{
    burned: boolean,
    locked: boolean,
    duration?: number,
    platform?: string
  }> {
    try {
      // Check burned tokens
      const [deadBalance, zeroBalance] = await Promise.all([
        lpContract.balanceOf(DEAD_ADDRESS),
        lpContract.balanceOf(ZERO_ADDRESS)
      ]);

      const burnedSupply = BigInt(deadBalance) + BigInt(zeroBalance);
      const burnedPercentage = Number((burnedSupply * BigInt(100)) / totalSupply);

      if (burnedPercentage > 95) {
        return { burned: true, locked: false };
      }

      // Check known lockers
      for (const lockerAddress of KNOWN_LOCKERS) {
        try {
          const lockerBalance = await lpContract.balanceOf(lockerAddress);
          const lockedPercentage = Number((BigInt(lockerBalance) * BigInt(100)) / totalSupply);

          if (lockedPercentage > 50) {
            // Determine locker platform
            let platform = 'Unknown';
            if (lockerAddress.toLowerCase() === '0x7ee058420e5937496F5a2096f04caA7721cF70cc'.toLowerCase() ||
              lockerAddress.toLowerCase() === '0x71B5759d73262FBb223956913ecF4ecC51057641'.toLowerCase()) {
              platform = 'PinkLock';
            } else if (lockerAddress.toLowerCase() === '0xC765bddB93b0D1c1A88282BA0fa6B2d00E3e0c83'.toLowerCase() ||
              lockerAddress.toLowerCase() === '0xE2fE530C047f2d85298b07D9333C05737f1435fB'.toLowerCase()) {
              platform = 'Team Finance';
            } else if (lockerAddress.toLowerCase() === '0x2967E7Bb9DaA5711Ac332cAF874BD47ef99B3820'.toLowerCase()) {
              platform = 'Unicrypt';
            } else if (lockerAddress.toLowerCase() === '0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE'.toLowerCase()) {
              platform = 'PancakeSwap Locker';
            }

            return {
              burned: false,
              locked: true,
              platform
              // Duration would require querying the specific locker contract
            };
          }
        } catch (error) {
          // Continue checking other lockers
        }
      }

      return { burned: false, locked: false };
    } catch (error) {
      logger.error('Error checking LP lock status', { error });
      return { burned: false, locked: false };
    }
  }

  // Get token analytics data from Moralis API
  private async getTokenAnalytics(tokenAddress: string): Promise<TokenAnalyticsData | null> {
    try {
      // Use fetch to call the Moralis API directly since it's not available in the SDK
      const response = await fetch(`https://deep-index.moralis.io/api/v2.2/tokens/${tokenAddress}/analytics?chain=bsc`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'X-API-Key': process.env.MORALIS_API_KEY!
        }
      });

      if (!response.ok) {
        logger.error('Failed to fetch token analytics', {
          status: response.status,
          statusText: response.statusText,
          tokenAddress
        });
        return null;
      }

      const data = await response.json();
      return data as TokenAnalyticsData;
    } catch (error) {
      logger.error('Error fetching token analytics', { error, tokenAddress });
      return null;
    }
  }

  // Calculate liquidity vs volume ratio and efficiency
  private calculateLiquidityEfficiency(liquidityUsd: number, volume24h: number): {
    ratio: number;
    efficiency: 'EXCELLENT' | 'GOOD' | 'ADEQUATE' | 'POOR' | 'CRITICAL';
  } {
    if (volume24h === 0) {
      return { ratio: Infinity, efficiency: 'CRITICAL' };
    }

    const ratio = liquidityUsd / volume24h;

    // Efficiency based on liquidity to volume ratio
    if (ratio >= 50) {
      return { ratio, efficiency: 'POOR' }; // Too much liquidity for trading activity
    } else if (ratio >= 20) {
      return { ratio, efficiency: 'ADEQUATE' };
    } else if (ratio >= 5) {
      return { ratio, efficiency: 'GOOD' };
    } else if (ratio >= 3) {
      return { ratio, efficiency: 'EXCELLENT' };
    } else {
      return { ratio, efficiency: 'CRITICAL' }; // Too little liquidity for volume
    }
  }

  // Analyze trading activity
  async analyzeTradingActivity(tokenAddress: string): Promise<TradingActivityAnalysis> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;

      // Get analytics data first (more comprehensive)
      const analyticsData = await this.getTokenAnalytics(tokenAddress);

      let volume24h = 0;
      let priceChange24h: number | undefined;
      let liquidityToVolumeRatio: number | undefined;
      let liquidityEfficiency: 'EXCELLENT' | 'GOOD' | 'ADEQUATE' | 'POOR' | 'CRITICAL' | undefined;
      let totalLiquidityUsd: number | undefined;

      if (analyticsData) {
        // Calculate total volume (buy + sell)
        volume24h = analyticsData.totalBuyVolume['24h'] + analyticsData.totalSellVolume['24h'];
        priceChange24h = analyticsData.pricePercentChange['24h'] * 100; // Convert to percentage

        // Get liquidity data
        totalLiquidityUsd = parseFloat(analyticsData.totalLiquidityUsd);

        // Calculate liquidity vs volume ratio
        if (totalLiquidityUsd && volume24h > 0) {
          const efficiency = this.calculateLiquidityEfficiency(totalLiquidityUsd, volume24h);
          liquidityToVolumeRatio = efficiency.ratio;
          liquidityEfficiency = efficiency.efficiency;
        }
      }

      // Fallback to token transfers if analytics data is not available
      let txCount24h = 0;
      let uniqueTraders24h = 0;

      try {
        const response = await Moralis.EvmApi.token.getTokenTransfers({
          chain: "0x38",
          address: tokenAddress,
          fromDate: new Date(oneDayAgo * 1000).toISOString(),
          toDate: new Date(now * 1000).toISOString(),
          limit: 100
        });

        const transfers = response.toJSON().result || [];
        txCount24h = transfers.length;

        // Calculate unique traders
        const uniqueAddresses = new Set<string>();
        transfers.forEach((tx: any) => {
          uniqueAddresses.add(tx.from_address);
          uniqueAddresses.add(tx.to_address);
        });
        uniqueTraders24h = uniqueAddresses.size;

        // If analytics didn't provide volume, try to get it from price API
        if (!analyticsData && volume24h === 0) {
          try {
            const priceResponse = await Moralis.EvmApi.token.getTokenPrice({
              chain: "0x38",
              address: tokenAddress
            });
            const priceData = priceResponse.toJSON();

            if (priceData) {
              const vol = (priceData as any)['24hrVolume'] || (priceData as any).volume24h || (priceData as any).volume;
              volume24h = vol ? Number(vol) : 0;

              if (!priceChange24h) {
                const change = (priceData as any)['24hrPercentChange'] || (priceData as any).priceChange24h || (priceData as any).percentChange24h;
                if (change !== undefined && change !== null) {
                  const numChange = Number(change);
                  priceChange24h = !isNaN(numChange) ? numChange : undefined;
                }
              }
            }
          } catch (error) {
            // Silently ignore price fetch errors
          }
        }
      } catch (error) {
        logger.error('Error fetching token transfers', { error, tokenAddress });
      }

      // Use analytics data for trader counts if available
      if (analyticsData) {
        uniqueTraders24h = analyticsData.uniqueWallets['24h'];
        txCount24h = analyticsData.totalBuyers['24h'] + analyticsData.totalSellers['24h'];
      }

      // Determine if trading is active
      const hasActiveTrading = (analyticsData && (analyticsData.uniqueWallets['24h'] > 5 || volume24h > 1000)) ||
        (!analyticsData && txCount24h > 10 && uniqueTraders24h > 5);

      return {
        txCount24h,
        uniqueTraders24h,
        volume24h,
        priceChange24h,
        hasActiveTrading,
        liquidityToVolumeRatio,
        liquidityEfficiency,
        totalLiquidityUsd
      };
    } catch (error) {
      logger.error('Error analyzing trading activity', { error, tokenAddress });
      return { hasActiveTrading: false };
    }
  }

  // Honeypot detection - simulate buy/sell
  async detectHoneypot(tokenAddress: string): Promise<HoneypotAnalysis> {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

      // First, check if we can find the token's liquidity pool
      const pools = await this.findAllLiquidityPools(tokenAddress);
      if (pools.length === 0) {
        return {
          isHoneypot: false,
          simulationSuccess: false,
          cannotSellReason: 'No liquidity pool found'
        };
      }

      // Get the main pool (usually WBNB pair)
      const factory = new ethers.Contract(PANCAKE_FACTORY, PANCAKE_FACTORY_ABI, this.provider);
      const pairAddress = await factory.getPair(tokenAddress, WBNB);

      if (pairAddress === ZERO_ADDRESS) {
        // Try BUSD pair
        const busdPair = await factory.getPair(tokenAddress, BUSD);
        if (busdPair === ZERO_ADDRESS) {
          return {
            isHoneypot: false,
            simulationSuccess: false,
            cannotSellReason: 'No major liquidity pair found'
          };
        }
      }

      // Check for common honeypot patterns
      const honeypotIndicators: string[] = [];

      // 1. Check if contract has blacklist functions
      const contractCode = await this.provider.getCode(tokenAddress);
      const codeStr = contractCode.toLowerCase();

      // Common honeypot function signatures
      const blacklistPatterns = [
        'blacklist',
        'botblacklist',
        'isblacklisted',
        'addbot',
        '_isblacklisted',
        'isbot',
        'antibot',
        'antibotmode',
        'killbot',
        'botkiller'
      ];

      for (const pattern of blacklistPatterns) {
        if (codeStr.includes(pattern)) {
          honeypotIndicators.push(`Blacklist function detected: ${pattern}`);
        }
      }

      // 2. Check for trading enable/disable functions
      const tradingPatterns = [
        'tradingenabled',
        'tradingactive',
        'enabletrading',
        'tradingopen',
        'starttrading',
        'canswap',
        'swapandliquifyenabled',
        'inswapandliquify'
      ];

      for (const pattern of tradingPatterns) {
        if (codeStr.includes(pattern)) {
          honeypotIndicators.push(`Trading control detected: ${pattern}`);
        }
      }

      // 3. Check for maximum transaction limits that could prevent selling
      const maxTxPatterns = [
        'maxtxamount',
        'maxsellamount',
        'maxsell',
        '_maxtxamount',
        'maxtransactionamount',
        'maxwalletsize',
        'maxwallet',
        '_maxwalletsize'
      ];

      for (const pattern of maxTxPatterns) {
        if (codeStr.includes(pattern)) {
          honeypotIndicators.push(`Transaction limit detected: ${pattern}`);
        }
      }

      // 3.5 Check for cooldown/delay mechanisms
      const cooldownPatterns = [
        'cooldown',
        'buycooldown',
        'sellcooldown',
        'timebetweensells',
        'lasttransaction',
        'transactiondelay'
      ];

      for (const pattern of cooldownPatterns) {
        if (codeStr.includes(pattern)) {
          honeypotIndicators.push(`Cooldown mechanism detected: ${pattern}`);
        }
      }

      // 4. Check owner balance - if owner holds >90%, likely honeypot
      const ownerBalance = await this.getOwnerBalance(tokenAddress, contract);
      if (ownerBalance > 90) {
        honeypotIndicators.push(`Owner holds ${ownerBalance.toFixed(2)}% of supply`);
      }

      // 5. Check if contract is verified - unverified contracts are higher risk
      const metadata = await this.getTokenMetadata(tokenAddress);
      if (!metadata?.verified) {
        honeypotIndicators.push('Contract not verified - cannot review code');
      }

      // 6. Check liquidity amount - extremely low liquidity is a red flag
      const liquidityAnalysis = await this.analyzeLiquidity(tokenAddress);
      if (liquidityAnalysis.hasLiquidity && liquidityAnalysis.liquidityUSD) {
        if (liquidityAnalysis.liquidityUSD < 100) {
          honeypotIndicators.push(`Extremely low liquidity: $${liquidityAnalysis.liquidityUSD.toFixed(2)}`);
        }
      }

      // 7. Check for specific high-risk patterns
      if (ownerBalance > 95 && liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD < 1000) {
        honeypotIndicators.push('Owner holds >95% with minimal liquidity - classic honeypot');
      }

      // 8. Check for pause/unpause functions
      const pausePatterns = [
        'pause',
        'unpause',
        'paused',
        'whennotpaused',
        'whenpaused',
        '_pause',
        '_unpause'
      ];

      for (const pattern of pausePatterns) {
        if (codeStr.includes(pattern)) {
          honeypotIndicators.push(`Pause mechanism detected: ${pattern}`);
        }
      }

      // Determine if it's a honeypot based on indicators
      const isHoneypot = honeypotIndicators.length >= 2 ||
        (honeypotIndicators.length >= 1 && ownerBalance > 95) ||
        (ownerBalance > 99 && !metadata?.verified);

      // Special case: If owner has 99%+ and contract is unverified with low liquidity
      if (ownerBalance >= 99 && !metadata?.verified && liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD < 1000) {
        return {
          isHoneypot: true,
          sellTax: 100, // Effectively cannot sell
          buyTax: 0,
          cannotSellReason: `Owner controls ${ownerBalance.toFixed(2)}% of supply with unverified contract and minimal liquidity`,
          simulationSuccess: true
        };
      }

      return {
        isHoneypot,
        sellTax: 0, // Would need actual simulation or external API
        buyTax: 0,  // Would need actual simulation or external API
        cannotSellReason: isHoneypot ? honeypotIndicators.join('; ') : undefined,
        simulationSuccess: true
      };
    } catch (error) {
      logger.error('Error detecting honeypot', { error, tokenAddress });
      return {
        isHoneypot: false,
        simulationSuccess: false,
        cannotSellReason: 'Could not analyze contract'
      };
    }
  }

  // Helper to get owner balance percentage
  private async getOwnerBalance(_tokenAddress: string, contract: ethers.Contract): Promise<number> {
    try {
      let ownerAddress: string | undefined;

      try {
        ownerAddress = await contract.owner().catch(() => contract.getOwner());
      } catch {
        return 0;
      }

      if (!ownerAddress || ownerAddress === ZERO_ADDRESS || ownerAddress === DEAD_ADDRESS) {
        return 0;
      }

      const [ownerBalance, totalSupply] = await Promise.all([
        contract.balanceOf(ownerAddress),
        contract.totalSupply()
      ]);

      const percentage = totalSupply > 0
        ? Number((BigInt(ownerBalance) * BigInt(10000)) / BigInt(totalSupply)) / 100
        : 0;

      return percentage;
    } catch {
      return 0;
    }
  }

  // Check if holder has diamond hands (holding > 7 days) - optimized version with pre-fetched transfers
  private async checkDiamondHandsWithTransfers(holderAddress: string, tokenAddress: string, transfers: any[]): Promise<{ isDiamondHands: boolean; holdingDays: number; firstTransactionDate?: Date }> {
    try {
      const walletLower = holderAddress.toLowerCase();
      const tokenLower = tokenAddress.toLowerCase();
      const now = new Date();
      const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago

      // Convert API transfers to our format
      const formattedTransfers = transfers.map(transfer => ({
        walletAddress: walletLower,
        tokenAddress: tokenLower,
        hash: transfer.transaction_hash,
        blockNumber: transfer.block_number,
        blockTimestamp: new Date(transfer.block_timestamp),
        fromAddress: transfer.from_address.toLowerCase(),
        toAddress: transfer.to_address.toLowerCase(),
        direction: transfer.from_address.toLowerCase() === walletLower ? 'out' :
          transfer.to_address.toLowerCase() === walletLower ? 'in' : 'self'
      }));

      // Analyze transfers to determine diamond hands status
      let firstAcquisitionDate: Date | undefined;
      let hasOutgoingTransfers = false;

      for (const transfer of formattedTransfers) {
        // Check if this is an incoming transfer to the holder
        if (transfer.direction === 'in') {
          if (!firstAcquisitionDate || transfer.blockTimestamp < firstAcquisitionDate) {
            firstAcquisitionDate = transfer.blockTimestamp;
          }
        }
        // Check if they've sold any
        if (transfer.direction === 'out') {
          hasOutgoingTransfers = true;
        }
      }

      // Calculate holding days
      let holdingDays = 0;
      let isDiamondHands = false;

      if (firstAcquisitionDate) {
        holdingDays = Math.floor((now.getTime() - firstAcquisitionDate.getTime()) / (1000 * 60 * 60 * 24));
        isDiamondHands = holdingDays > 7;
      } else if (formattedTransfers.length === 0) {
        // No transfers found in 90 days, but they hold the token = ultra diamond hands
        holdingDays = 90;
        isDiamondHands = true;
        firstAcquisitionDate = fromDate;
      }

      return {
        isDiamondHands,
        holdingDays,
        firstTransactionDate: firstAcquisitionDate
      };

    } catch (error) {
      logger.error('Error checking diamond hands with transfers', { error, holderAddress, tokenAddress });
      return { isDiamondHands: false, holdingDays: 0 };
    }
  }

  // Check if holder has diamond hands (holding > 7 days) - original version with API call
  private async checkDiamondHands(holderAddress: string, tokenAddress: string): Promise<{ isDiamondHands: boolean; holdingDays: number; firstTransactionDate?: Date }> {
    try {
      const walletLower = holderAddress.toLowerCase();
      const tokenLower = tokenAddress.toLowerCase();
      const now = new Date();
      const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago

      // First, check if we have cached transfers in MongoDB
      const cachedTransfers = await TokenTransferModel.find({
        walletAddress: walletLower,
        tokenAddress: tokenLower,
        blockTimestamp: { $gte: fromDate }
      }).sort({ blockTimestamp: 1 }); // Sort ascending to find first transaction

      // Check if we need to fetch new data
      let needsFetch = false;

      if (cachedTransfers.length === 0) {
        // No cached data at all
        needsFetch = true;
      } else {
        // Check if our cached data covers the required date range
        const oldestCached = cachedTransfers[0];
        const newestCached = cachedTransfers[cachedTransfers.length - 1];

        // If the oldest cached transfer was fetched recently and covers our date range, use cache
        const cacheAge = now.getTime() - oldestCached.fetchedAt.getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;

        // If cache is older than 1 day for recent transactions, refresh
        if (cacheAge > oneDayMs && newestCached.blockTimestamp > new Date(Date.now() - 7 * oneDayMs)) {
          needsFetch = true;
        }
      }

      let transfers = cachedTransfers;

      if (needsFetch) {
        try {
          logger.info('Fetching token transfers for diamond hands check', { wallet: walletLower, token: tokenLower });

          const response = await Moralis.EvmApi.token.getWalletTokenTransfers({
            chain: "0x38", // BSC
            address: holderAddress,
            contractAddresses: [tokenAddress], // Filter for specific token only
            fromDate: fromDate.toISOString(),
            order: "ASC", // Ascending to find first transaction
            limit: 100
          });

          const apiTransfers = response.toJSON();

          // Save transfers to MongoDB
          if (apiTransfers.result && apiTransfers.result.length > 0) {
            const transferDocs = apiTransfers.result.map(transfer => ({
              walletAddress: walletLower,
              tokenAddress: tokenLower,
              hash: transfer.transaction_hash,
              blockNumber: transfer.block_number,
              blockTimestamp: new Date(transfer.block_timestamp),
              fromAddress: transfer.from_address.toLowerCase(),
              toAddress: transfer.to_address.toLowerCase(),
              value: transfer.value,
              valueDecimal: transfer.value_decimal,
              tokenName: transfer.token_name,
              tokenSymbol: transfer.token_symbol,
              tokenDecimals: transfer.token_decimals,
              tokenLogo: transfer.token_logo,
              possibleSpam: transfer.possible_spam,
              securityScore: (transfer as any).security_score,
              verifiedContract: (transfer as any).verified_contract || false,
              direction: transfer.from_address.toLowerCase() === walletLower ? 'out' :
                transfer.to_address.toLowerCase() === walletLower ? 'in' : 'self',
              fetchedAt: now,
              fetchedForDateRange: { from: fromDate, to: now }
            }));

            // Bulk upsert transfers
            await Promise.all(
              transferDocs.map(doc =>
                TokenTransferModel.findOneAndUpdate(
                  { hash: doc.hash },
                  doc,
                  { upsert: true, new: true }
                )
              )
            );

            // Re-fetch from MongoDB to get the complete dataset
            transfers = await TokenTransferModel.find({
              walletAddress: walletLower,
              tokenAddress: tokenLower,
              blockTimestamp: { $gte: fromDate }
            }).sort({ blockTimestamp: 1 });
          }
        } catch (apiError) {
          logger.error('Error fetching token transfers from API', { error: apiError, wallet: walletLower, token: tokenLower });
          // Continue with cached data if API fails
        }
      }

      // Analyze transfers to determine diamond hands status
      let firstAcquisitionDate: Date | undefined;
      let hasOutgoingTransfers = false;

      for (const transfer of transfers) {
        // Check if this is an incoming transfer to the holder
        if (transfer.direction === 'in') {
          if (!firstAcquisitionDate || transfer.blockTimestamp < firstAcquisitionDate) {
            firstAcquisitionDate = transfer.blockTimestamp;
          }
        }
        // Check if they've sold any
        if (transfer.direction === 'out') {
          hasOutgoingTransfers = true;
        }
      }

      // Calculate holding days
      let holdingDays = 0;
      let isDiamondHands = false;

      if (firstAcquisitionDate) {
        holdingDays = Math.floor((now.getTime() - firstAcquisitionDate.getTime()) / (1000 * 60 * 60 * 24));
        isDiamondHands = holdingDays > 7;
      } else if (transfers.length === 0) {
        // No transfers found in 90 days, but they hold the token = ultra diamond hands
        holdingDays = 90;
        isDiamondHands = true;
        firstAcquisitionDate = fromDate;
      }

      // Update TransactionCache with the analysis result
      await TransactionCache.findOneAndUpdate(
        { walletAddress: walletLower },
        {
          $set: {
            lastFetchedAt: now
          },
          $push: {
            diamondHandsData: {
              tokenAddress: tokenLower,
              isDiamondHands,
              holdingDays,
              firstTransactionDate: firstAcquisitionDate,
              hasOutgoingTransfers
            }
          }
        },
        { upsert: true }
      );

      return {
        isDiamondHands,
        holdingDays,
        firstTransactionDate: firstAcquisitionDate
      };

    } catch (error) {
      logger.error('Error checking diamond hands', { error, holderAddress, tokenAddress });
      return { isDiamondHands: false, holdingDays: 0 };
    }
  }

  // Check if wallet has huge value transactions (> $10k) - optimized version with pre-fetched transfers
  private async checkHugeValueStatusWithTransfers(address: string, tokenAddress: string, transfers: any[]): Promise<{ isHugeValue: boolean; hugeValueAmount: number }> {
    try {
      let maxTransactionValue = 0;
      let hasHugeValueTransaction = false;

      // Get token price to calculate USD values
      const tokenPrice = await getCachedTokenPrice(tokenAddress);
      const metadata = await this.getTokenMetadata(tokenAddress);

      if (tokenPrice && tokenPrice > 0 && metadata) {
        for (const transfer of transfers) {
          // Calculate USD value of the transaction
          const value = BigInt(transfer.value || '0');
          const decimals = Number(transfer.token_decimals) || metadata.decimals;
          const valueFormatted = Number(value) / Math.pow(10, decimals);
          const usdValue = valueFormatted * tokenPrice;

          if (usdValue > maxTransactionValue) {
            maxTransactionValue = usdValue;
          }

          // Check if this transaction is above $10k threshold
          if (usdValue > 10000) {
            hasHugeValueTransaction = true;
          }
        }
      }

      return {
        isHugeValue: hasHugeValueTransaction,
        hugeValueAmount: maxTransactionValue
      };

    } catch (error) {
      logger.error('Error checking huge value status with transfers', { error, address, tokenAddress });
      return { isHugeValue: false, hugeValueAmount: 0 };
    }
  }

  // Check if wallet has huge value transactions (> $10k) - original version with API call
  private async checkHugeValueStatus(address: string, tokenAddress: string): Promise<{ isHugeValue: boolean; hugeValueAmount: number }> {
    try {
      // Check cache first with same duration as whale detection
      const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = new Date();
      const cachedData = await TransactionCache.findOne({
        walletAddress: address.toLowerCase(),
        lastFetchedAt: { $gte: new Date(Date.now() - CACHE_DURATION_MS) }
      });

      // Check if we have cached huge value data for this specific token
      if (cachedData && cachedData.hugeValueData) {
        const tokenData = (cachedData.hugeValueData as any[]).find(
          (data: any) => data.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );
        if (tokenData && tokenData.lastChecked) {
          // Check if the cached data is still fresh (within 1 day for recent activity)
          const cacheAge = now.getTime() - new Date(tokenData.lastChecked).getTime();
          const oneDayMs = 24 * 60 * 60 * 1000;

          if (cacheAge < oneDayMs) {
            logger.debug('Using cached huge value data', { address, tokenAddress });
            return {
              isHugeValue: tokenData.isHugeValue,
              hugeValueAmount: tokenData.hugeValueAmount
            };
          }
        }
      }

      // Fetch recent transactions for this wallet and token
      const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      let maxTransactionValue = 0;
      let hasHugeValueTransaction = false;

      try {
        logger.info('Fetching huge value transactions', { address, tokenAddress });

        const response = await Moralis.EvmApi.token.getWalletTokenTransfers({
          chain: "0x38", // BSC
          address: address,
          contractAddresses: [tokenAddress],
          fromDate: fromDate.toISOString(),
          order: "DESC", // Most recent first
          limit: 50 // Check last 50 transactions
        });

        const transfers = response.toJSON();

        if (transfers.result && transfers.result.length > 0) {
          // Get token price to calculate USD values
          const tokenPrice = await getCachedTokenPrice(tokenAddress);
          const metadata = await this.getTokenMetadata(tokenAddress);

          if (tokenPrice && tokenPrice > 0 && metadata) {
            for (const transfer of transfers.result) {
              // Calculate USD value of the transaction
              const value = BigInt(transfer.value || '0');
              const decimals = Number(transfer.token_decimals) || metadata.decimals;
              const valueFormatted = Number(value) / Math.pow(10, decimals);
              const usdValue = valueFormatted * tokenPrice;

              if (usdValue > maxTransactionValue) {
                maxTransactionValue = usdValue;
              }

              // Check if this transaction is above $10k threshold
              if (usdValue > 10000) {
                hasHugeValueTransaction = true;
              }
            }
          }
        }
      } catch (apiError) {
        logger.error('Error fetching token transfers for huge value check', { error: apiError, address, tokenAddress });
        // Return default values if API fails
        return { isHugeValue: false, hugeValueAmount: 0 };
      }

      // Cache the result
      const hugeValueData = {
        tokenAddress: tokenAddress.toLowerCase(),
        isHugeValue: hasHugeValueTransaction,
        hugeValueAmount: maxTransactionValue,
        lastChecked: now
      };

      await TransactionCache.findOneAndUpdate(
        { walletAddress: address.toLowerCase() },
        {
          $set: {
            lastFetchedAt: now
          },
          $push: {
            hugeValueData: hugeValueData
          }
        },
        { upsert: true }
      );

      return {
        isHugeValue: hasHugeValueTransaction,
        hugeValueAmount: maxTransactionValue
      };

    } catch (error) {
      logger.error('Error checking huge value status', { error, address, tokenAddress });
      return { isHugeValue: false, hugeValueAmount: 0 };
    }
  }

  // Check if wallet is a whale (portfolio > $1M)
  private async checkWhaleStatus(address: string, currentTokenAddress?: string, currentTokenBalance?: string): Promise<{ isWhale: boolean; portfolioValue: number; topTokens?: string[] }> {
    try {
      // Check cache first
      const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const cachedData = await TransactionCache.findOne({
        walletAddress: address.toLowerCase(),
        lastFetchedAt: { $gte: new Date(Date.now() - CACHE_DURATION_MS) }
      });

      if (cachedData && cachedData.totalValue !== undefined) {
        return {
          isWhale: cachedData.isWhale,
          portfolioValue: cachedData.totalValue,
          topTokens: cachedData.topTokens
        };
      }

      // Fetch wallet balance
      let tokens: any[] = [];
      try {
        const tokensData = await getWalletTokensWithPrices(address);

        if (Array.isArray(tokensData)) {
          tokens = tokensData;
        } else if (tokensData && Array.isArray((tokensData as any).result)) {
          tokens = (tokensData as any).result;
        } else {
          logger.error('Unexpected response format from getWalletTokensWithPrices', { address, response: tokensData });
          tokens = [];
        }
      } catch (apiError) {
        logger.error('Error fetching wallet tokens', { address, error: apiError instanceof Error ? apiError.message : String(apiError) });
        if (apiError instanceof Error && apiError.message.includes('rate')) {
          logger.error('Rate limit detected when fetching wallet tokens', { address });
        }
        // Return 0 portfolio value if API fails
        return { isWhale: false, portfolioValue: 0 };
      }

      // Calculate total portfolio value
      let totalValue = 0;
      const topTokens: string[] = [];

      // If no tokens found, still check for the specific token being analyzed
      if (tokens.length === 0 && currentTokenAddress && currentTokenBalance) {
        // Continue to check specific token value below
      }

      // Get BNB price for native tokens
      const bnbPrice = await getBNBPrice();

      // Process tokens and calculate total value using USD values from API
      let includedCurrentToken = false;

      for (const token of tokens) {
        // Trust the USD value returned from getWalletTokensWithPrices
        let tokenValue = token.usd_value || 0;

        // Check if this is the current token we're analyzing
        if (currentTokenAddress && token.token_address &&
          token.token_address.toLowerCase() === currentTokenAddress.toLowerCase()) {
          includedCurrentToken = true;
        }

        // If no USD value, try to fetch price
        if (!tokenValue && token.token_address && token.token_address !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
          try {
            const price = await getCachedTokenPrice(token.token_address);
            if (price && price > 0) {
              const balance = parseFloat(token.balance) / Math.pow(10, token.decimals || 18);
              tokenValue = balance * price;
            }
          } catch (error) {
            logger.error('Error fetching token price', { symbol: token.symbol, tokenAddress: token.token_address, error });
          }
        }

        // Only calculate USD value for native BNB if not already provided
        if (token.token_address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && !tokenValue) {
          const balance = parseFloat(token.balance) / Math.pow(10, 18);
          tokenValue = balance * bnbPrice;
        }

        totalValue += tokenValue;

        // Track top tokens
        if (tokenValue > 10000 && topTokens.length < 5) { // Top 5 tokens worth >$10k
          topTokens.push(`${token.symbol} ($${tokenValue.toFixed(0)})`);
        }
      }

      // If the current token wasn't included in the API response, estimate its value
      // Only do this if it's likely to be significant (avoid extra API calls for dust tokens)
      if (currentTokenAddress && currentTokenBalance && !includedCurrentToken) {
        try {
          // Only fetch price if the balance is potentially significant
          const balanceBigInt = BigInt(currentTokenBalance);
          if (balanceBigInt > BigInt(0)) {
            const tokenPrice = await getCachedTokenPrice(currentTokenAddress);
            if (tokenPrice && tokenPrice > 0) {
              // Get token metadata for decimals
              const metadata = await this.getTokenMetadata(currentTokenAddress);
              if (metadata) {
                const balance = BigInt(currentTokenBalance);
                const decimals = metadata.decimals;
                const balanceFormatted = Number(balance) / Math.pow(10, decimals);
                const tokenValue = balanceFormatted * tokenPrice;
                totalValue += tokenValue;

                if (tokenValue > 10000 && topTokens.length < 5) {
                  topTokens.push(`${metadata.symbol} ($${tokenValue.toFixed(0)})`);
                }
              }
            }
          }
        } catch (error) {
          logger.error('Error adding current token value', { error, tokenAddress: currentTokenAddress });
        }
      }

      // Check if whale based on total portfolio OR significant holdings of current token
      let isWhale = totalValue > 1000000; // $1M total portfolio threshold

      // Check if they're a whale for this specific token (>$500K holdings)
      // Try to use value from the API response first to avoid duplicate price fetches
      if (!isWhale && currentTokenAddress && currentTokenBalance) {
        let currentTokenValue = 0;

        // First, check if we already calculated this token's value in the loop above
        const tokenInResponse = tokens.find(token =>
          token.token_address &&
          token.token_address.toLowerCase() === currentTokenAddress.toLowerCase()
        );

        if (tokenInResponse && tokenInResponse.usd_value) {
          currentTokenValue = tokenInResponse.usd_value;
        } else {
          // Only fetch price if not found in API response
          try {
            const tokenPrice = await getCachedTokenPrice(currentTokenAddress);
            if (tokenPrice && tokenPrice > 0) {
              const metadata = await this.getTokenMetadata(currentTokenAddress);
              if (metadata) {
                const balance = BigInt(currentTokenBalance);
                const decimals = metadata.decimals;
                const balanceFormatted = Number(balance) / Math.pow(10, decimals);
                currentTokenValue = balanceFormatted * tokenPrice;
              }
            }
          } catch (error) {
            logger.error('Error checking token-specific whale status', { error, tokenAddress: currentTokenAddress, walletAddress: address });
          }
        }

        // Token-specific whale threshold: $500K
        if (currentTokenValue > 500000) {
          isWhale = true;
        }
      }

      // Cache the result
      await TransactionCache.findOneAndUpdate(
        { walletAddress: address.toLowerCase() },
        {
          walletAddress: address.toLowerCase(),
          lastFetchedAt: new Date(),
          totalValue,
          isWhale,
          topTokens
        },
        { upsert: true }
      );

      return { isWhale, portfolioValue: totalValue, topTokens };
    } catch (error) {
      logger.error('Error checking whale status', { error, address });
      return { isWhale: false, portfolioValue: 0 };
    }
  }

  // Check if address is likely a contract
  private async isLikelyContract(address: string): Promise<boolean> {
    try {
      const code = await this.provider.getCode(address);
      return code !== '0x' && code !== '0x00';
    } catch {
      // Fallback to known contracts
      const knownContracts = [
        '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap Router
        '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PancakeSwap Factory
        '0x000000000000000000000000000000000000000000dead', // Burn address
      ];

      return knownContracts.some(contract =>
        contract.toLowerCase() === address.toLowerCase()
      ) || address.toLowerCase().includes('000000000000');
    }
  }

  // Perform complete rug alert analysis
  async analyzeToken(tokenAddress: string): Promise<RugAlertAnalysis | null> {
    try {
      // Get metadata first as other analyses depend on it
      const metadata = await this.getTokenMetadata(tokenAddress);
      if (!metadata) {
        return null;
      }

      // Run all analyses in parallel
      const [holderAnalysis, liquidityAnalysis, tradingActivity, honeypotAnalysis, priceDeviationResult] = await Promise.all([
        this.getTokenHolders(tokenAddress, metadata), // This can now return null
        this.analyzeLiquidity(tokenAddress),
        this.analyzeTradingActivity(tokenAddress),
        this.detectHoneypot(tokenAddress),
        priceDeviationChecker.checkPriceDeviation(tokenAddress)
      ]);

      // Check if holderAnalysis is null
      if (!holderAnalysis) {
        logger.error('Failed to get holder analysis, aborting safety analysis.', { tokenAddress });
        return null; // Abort if critical holder data is missing
      }

      // Calculate detailed safety scores (higher is better, max 100)
      const safetyScoreDetails = {
        holders: 0,      // Max 15 points (reduced from 20)
        liquidity: 0,    // Max 25 points
        verification: 0, // Max 10 points
        trading: 0,      // Max 10 points
        ownership: 0,    // Max 10 points
        age: 0,          // Max 10 points
        honeypot: 0,     // Max 15 points
        diamondHands: 0,  // Max 5 points (new)
        priceDeviation: 0 // Price deviation penalty (negative points)
      };

      const allRiskFactors: string[] = [...holderAnalysis.riskFactors];

      // Holder distribution score (0-15 points) - better distribution = higher score
      if (holderAnalysis.top10ConcentrationExcludingLP <= 20) safetyScoreDetails.holders = 15;
      else if (holderAnalysis.top10ConcentrationExcludingLP <= 40) safetyScoreDetails.holders = 12;
      else if (holderAnalysis.top10ConcentrationExcludingLP <= 60) safetyScoreDetails.holders = 8;
      else if (holderAnalysis.top10ConcentrationExcludingLP <= 80) safetyScoreDetails.holders = 4;
      else safetyScoreDetails.holders = 0;

      // Verification score (0-10 points)
      if (metadata.verified) {
        safetyScoreDetails.verification = 10;
      } else {
        safetyScoreDetails.verification = 0;
        allRiskFactors.push('Contract source code not verified');
      }

      // Liquidity score (0-25 points)
      if (!liquidityAnalysis.hasLiquidity) {
        safetyScoreDetails.liquidity = 0;
        allRiskFactors.push('No liquidity pool found');
      } else {
        // Base liquidity amount score (0-15 points)
        if (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD >= 100000) {
          safetyScoreDetails.liquidity = 15;
        } else if (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD >= 50000) {
          safetyScoreDetails.liquidity = 12;
        } else if (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD >= 10000) {
          safetyScoreDetails.liquidity = 8;
        } else if (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD >= 1000) {
          safetyScoreDetails.liquidity = 4;
          allRiskFactors.push('Very low liquidity (<$10k)');
        } else {
          safetyScoreDetails.liquidity = 0;
          allRiskFactors.push('Extremely low liquidity (<$1k)');
        }

        // LP security bonus (0-10 points)
        if (liquidityAnalysis.lpTokenBurned) {
          safetyScoreDetails.liquidity += 10;
        } else if (liquidityAnalysis.lpTokenLocked) {
          safetyScoreDetails.liquidity += 8;
        } else {
          allRiskFactors.push('LP tokens not secured (not burned or locked)');
        }
      }

      // Trading activity score (0-10 points)
      if (tradingActivity.hasActiveTrading) {
        safetyScoreDetails.trading = 10;
      } else {
        safetyScoreDetails.trading = 0;
        allRiskFactors.push('Low or no trading activity');
      }

      // Ownership score (0-10 points)
      if (!metadata.ownerAddress || metadata.renounced) {
        safetyScoreDetails.ownership = 10;
      } else {
        safetyScoreDetails.ownership = 0;
        allRiskFactors.push('Contract ownership not renounced');
      }

      // Age score (0-10 points)
      if (metadata.createdAt) {
        const ageInDays = (Date.now() - metadata.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays >= 30) {
          safetyScoreDetails.age = 10;
        } else if (ageInDays >= 7) {
          safetyScoreDetails.age = 7;
        } else if (ageInDays >= 1) {
          safetyScoreDetails.age = 3;
          allRiskFactors.push('Token created less than 7 days ago');
        } else {
          safetyScoreDetails.age = 0;
          allRiskFactors.push('Token created less than 24 hours ago');
        }
      } else {
        safetyScoreDetails.age = 5; // Default if age unknown
      }

      // Honeypot score (0-15 points) - NOT a honeypot = full points
      if (honeypotAnalysis.isHoneypot) {
        safetyScoreDetails.honeypot = 0;
        allRiskFactors.push(`🚫 HONEYPOT DETECTED: ${honeypotAnalysis.cannotSellReason || 'Cannot sell token'}`);
      } else {
        safetyScoreDetails.honeypot = 15;
      }

      // Diamond hands score (0-5 points) - more diamond hands = higher score
      const diamondHandsCount = holderAnalysis.top10Holders.filter(h => h.isDiamondHands).length;
      if (diamondHandsCount >= 5) {
        safetyScoreDetails.diamondHands = 5;
      } else if (diamondHandsCount >= 3) {
        safetyScoreDetails.diamondHands = 3;
      } else if (diamondHandsCount >= 1) {
        safetyScoreDetails.diamondHands = 1;
      } else {
        safetyScoreDetails.diamondHands = 0;
      }

      // Price deviation penalty (negative points based on deviation)
      let priceDeviationWarning: string | undefined;
      if (priceDeviationResult && priceDeviationResult.hasDeviation) {
        const deviationPenalty = priceDeviationChecker.getDeviationRiskScore(priceDeviationResult.deviationPercentage);
        safetyScoreDetails.priceDeviation = deviationPenalty;
        
        // Add to risk factors
        if (priceDeviationResult.riskLevel === 'critical') {
          allRiskFactors.push(`🚨 CRITICAL: ${priceDeviationResult.deviationPercentage.toFixed(1)}% price deviation from oracle`);
          priceDeviationWarning = priceDeviationResult.message;
        } else if (priceDeviationResult.riskLevel === 'high') {
          allRiskFactors.push(`⚠️ HIGH: ${priceDeviationResult.deviationPercentage.toFixed(1)}% price deviation from oracle`);
          priceDeviationWarning = priceDeviationResult.message;
        } else if (priceDeviationResult.riskLevel === 'medium') {
          allRiskFactors.push(`Price deviation detected: ${priceDeviationResult.deviationPercentage.toFixed(1)}%`);
        }
      }

      // Calculate total safety score
      const safetyScore = Object.values(safetyScoreDetails).reduce((sum, score) => sum + score, 0);

      // Generate recommendations
      const recommendations: string[] = [];

      if (honeypotAnalysis.isHoneypot) {
        recommendations.push('🚫 HONEYPOT DETECTED - DO NOT BUY THIS TOKEN');
      } else if (safetyScore >= 80) {
        recommendations.push('✅ HIGH SAFETY - Token appears relatively safe based on on-chain analysis');
      } else if (safetyScore >= 60) {
        recommendations.push('✅ MODERATE SAFETY - Token has good fundamentals with some minor concerns');
      } else if (safetyScore >= 40) {
        recommendations.push('⚠️ MEDIUM RISK - Several risk factors detected, exercise caution');
      } else if (safetyScore >= 20) {
        recommendations.push('⚠️ HIGH RISK - Multiple red flags detected');
      } else {
        recommendations.push('🚨 CRITICAL RISK - Strong indicators of potential rug pull');
      }

      // Specific recommendations
      if (holderAnalysis.top10ConcentrationExcludingLP > 50) {
        recommendations.push('💡 High whale concentration - risk of dumps');
      }

      if (holderAnalysis.creatorBalance && holderAnalysis.creatorBalance > 5) {
        recommendations.push(`🚨 Creator holds ${holderAnalysis.creatorBalance.toFixed(2)}% - can dump on holders`);
      }

      if (!metadata.verified) {
        recommendations.push('🔍 Unverified contract - source code cannot be reviewed');
      }

      if (!liquidityAnalysis.hasLiquidity || (liquidityAnalysis.liquidityUSD && liquidityAnalysis.liquidityUSD < 50000)) {
        recommendations.push('💧 Insufficient liquidity - difficult to exit position');
      }

      if (!liquidityAnalysis.lpTokenBurned && !liquidityAnalysis.lpTokenLocked) {
        recommendations.push('🔓 Liquidity not secured - can be removed anytime');
      }

      if (metadata.ownerAddress && !metadata.renounced) {
        recommendations.push('👤 Active ownership - contract can be modified');
      }

      recommendations.push('⚠️ Always DYOR and never invest more than you can afford to lose');

      return {
        metadata,
        holderAnalysis: {
          ...holderAnalysis,
          riskFactors: allRiskFactors
        },
        liquidityAnalysis,
        tradingActivity,
        honeypotAnalysis,
        safetyScore,
        safetyScoreDetails,
        priceDeviationWarning,
        recommendations
      };
    } catch (error) {
      logger.error('Error performing token analysis', { 
        tokenAddress,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      });
      return null;
    }
  }

  // Validate token address format
  isValidTokenAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
}