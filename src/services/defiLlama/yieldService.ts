import axios from 'axios';
import { t, interpolate } from '@/i18n';
import { DeFiProtocolPosition, StakingPosition } from '@/database/models/DeFiPosition';
import { createLogger } from '@/utils/logger';

const logger = createLogger('defiLlama.yield');

interface YieldPool {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  apyBase?: number;
  apyReward?: number;
  apy?: number;
  tvlUsd: number;
  poolMeta?: string;
  exposure?: string;
  rewardTokens?: string[];
  url?: string;
  apyBorrow?: number;
  apyBaseBorrow?: number;
  apyRewardBorrow?: number;
  totalSupplyUsd?: number;
  totalBorrowUsd?: number;
  ltv?: number;
  createdAt?: string;
}

interface TokenHolding {
  symbol: string;
  name: string;
  token_address: string;
  balance: string;
  decimals: number;
  usd_value?: number;
  usd_price?: number;
}

export interface YieldOpportunity {
  tokenSymbol: string;
  tokenAddress: string;
  project: string;
  apy: number;
  tvlUsd: number;
  url?: string;
  type: string;
  poolId: string;
  rewardTokens?: string[];
}

export interface ProtocolSuggestion {
  protocol: string;
  poolName: string;
  tokenSymbol: string;
  apy: number;
  tvlUsd: number;
  reason: string;
  apyImprovement?: number;
  riskLevel?: 'low' | 'medium' | 'high';
}

const DEFILLAMA_API_BASE = 'https://yields.llama.fi';
const BSC_CHAIN_NAME = 'BSC';

// Cache for pools data
let poolsCache: { data: YieldPool[]; timestamp: number } | null = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Fetch all yield pools from DeFiLlama
 */
export async function getAllYieldPools(): Promise<YieldPool[]> {
  try {
    // Check if we have cached data
    if (poolsCache && Date.now() - poolsCache.timestamp < CACHE_DURATION) {
      return poolsCache.data;
    }

    const response = await axios.get(`${DEFILLAMA_API_BASE}/pools`);
    const pools = response.data.data || [];
    
    // Update cache
    poolsCache = {
      data: pools,
      timestamp: Date.now()
    };
    
    return pools;
  } catch (error) {
    logger.error('Error fetching yield pools:', error);
    return [];
  }
}

/**
 * Find yield opportunities for a specific token on BSC
 */
export async function findYieldOpportunitiesForToken(
  tokenSymbol: string,
  tokenAddress?: string
): Promise<YieldOpportunity[]> {
  try {
    const allPools = await getAllYieldPools();
    
    // Filter for BSC pools that contain the token symbol
    const relevantPools = allPools.filter(pool => {
      // Check if it's on BSC
      if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) return false;
      
      // Check if the symbol contains our token
      const poolSymbol = pool.symbol.toUpperCase();
      const searchSymbol = tokenSymbol.toUpperCase();
      
      // Match exact token, pairs, or LP tokens
      return poolSymbol === searchSymbol || 
             poolSymbol.includes(`${searchSymbol}-`) ||
             poolSymbol.includes(`-${searchSymbol}`) ||
             poolSymbol.includes(`${searchSymbol}/`) ||
             poolSymbol.includes(`/${searchSymbol}`) ||
             poolSymbol.includes(`${searchSymbol} `) ||
             poolSymbol.includes(` ${searchSymbol}`);
    });

    // Convert to YieldOpportunity format
    return relevantPools.map(pool => ({
      tokenSymbol: tokenSymbol,
      tokenAddress: tokenAddress || '',
      project: pool.project,
      apy: pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0),
      tvlUsd: pool.tvlUsd,
      url: pool.url,
      type: pool.exposure || 'single',
      poolId: pool.pool,
      rewardTokens: pool.rewardTokens
    }))
    .filter(opp => opp.apy > 0) // Only show opportunities with positive APY
    .sort((a, b) => b.apy - a.apy); // Sort by APY descending
  } catch (error) {
    logger.error('Error finding yield opportunities:', error);
    return [];
  }
}

/**
 * Find yield opportunities for multiple tokens
 */
export async function findYieldOpportunitiesForTokens(
  tokens: TokenHolding[]
): Promise<Map<string, YieldOpportunity[]>> {
  try {
    const allPools = await getAllYieldPools();
    const opportunitiesMap = new Map<string, YieldOpportunity[]>();

    // Initialize map for all tokens
    tokens.forEach(token => {
      opportunitiesMap.set(token.symbol, []);
    });

    // Check each pool against all tokens
    for (const pool of allPools) {
      // Skip non-BSC pools
      if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) continue;
      
      const poolSymbol = pool.symbol.toUpperCase();
      
      // Check against each token
      for (const token of tokens) {
        const tokenSymbol = token.symbol.toUpperCase();
        
        // Check if pool contains this token
        if (poolSymbol === tokenSymbol || 
            poolSymbol.includes(`${tokenSymbol}-`) ||
            poolSymbol.includes(`-${tokenSymbol}`) ||
            poolSymbol.includes(`${tokenSymbol}/`) ||
            poolSymbol.includes(`/${tokenSymbol}`) ||
            poolSymbol.includes(`${tokenSymbol} `) ||
            poolSymbol.includes(` ${tokenSymbol}`)) {
          
          const opportunity: YieldOpportunity = {
            tokenSymbol: token.symbol,
            tokenAddress: token.token_address,
            project: pool.project,
            apy: pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0),
            tvlUsd: pool.tvlUsd,
            url: pool.url,
            type: pool.exposure || 'single',
            poolId: pool.pool,
            rewardTokens: pool.rewardTokens
          };

          if (opportunity.apy > 0) { // Only add if has positive APY
            const existing = opportunitiesMap.get(token.symbol) || [];
            existing.push(opportunity);
            opportunitiesMap.set(token.symbol, existing);
          }
        }
      }
    }

    // Sort opportunities by APY for each token
    opportunitiesMap.forEach((opportunities, symbol) => {
      opportunities.sort((a, b) => b.apy - a.apy);
    });

    return opportunitiesMap;
  } catch (error) {
    logger.error('Error finding yield opportunities for multiple tokens:', error);
    return new Map();
  }
}

/**
 * Get top yield opportunities across all BSC pools
 */
export async function getTopBSCYieldOpportunities(limit: number = 10): Promise<YieldPool[]> {
  try {
    const allPools = await getAllYieldPools();
    
    return allPools
      .filter(pool => 
        pool.chain.toUpperCase() === BSC_CHAIN_NAME && 
        pool.apy && 
        pool.apy > 0 &&
        pool.tvlUsd > 10000 // Filter out low liquidity pools
      )
      .sort((a, b) => (b.apy || 0) - (a.apy || 0))
      .slice(0, limit);
  } catch (error) {
    logger.error('Error getting top BSC yield opportunities:', error);
    return [];
  }
}

/**
 * Calculates a "smart score" for a yield pool to rank its quality.
 * @param pool The yield pool data from DeFiLlama.
 * @returns A score from 0 to 100+. Higher is better.
 */
function calculateOpportunityScore(pool: YieldPool): number {
  const apy = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
  const tvl = pool.tvlUsd || 0;

  // APY Score (logarithmic scale to handle extreme values)
  // Max score for APY is around 50. APY of 100% gives ~40 points. 1000% gives ~46.
  const apyScore = Math.log10(apy + 1) * 20;

  // TVL Score (logarithmic scale)
  // Max score for TVL is around 40. TVL of $1M gives ~24 points. $10M gives ~28.
  const tvlScore = Math.log10(tvl + 1) * 4;

  // Risk Penalty
  let riskPenalty = 0;
  const poolNameLower = (pool.symbol + pool.project).toLowerCase();
  const highRiskKeywords = ['meme', 'doge', 'shiba', 'broc', 'cousin', 'mubarak', 'safe', 'moon'];
  if (highRiskKeywords.some(keyword => poolNameLower.includes(keyword))) {
    riskPenalty += 30; // Heavy penalty for risky-sounding names
  }
  if (tvl < 50000) {
    riskPenalty += 20; // Penalty for very low TVL
  }
  if (apy > 500) {
    riskPenalty += (apy / 100); // Penalty for absurdly high APY
  }

  // Project Trust Score (simple version)
  let trustScore = 0;
  const trustedProjects = ['pancakeswap', 'venus', 'beefy', 'alpaca', 'ellipsis'];
  if (trustedProjects.some(proj => pool.project.toLowerCase().includes(proj))) {
    trustScore += 15;
  }

  const finalScore = apyScore + tvlScore + trustScore - riskPenalty;

  return Math.max(0, finalScore); // Ensure score is not negative
}

/**
 * Gets top yield opportunities based on a smart scoring system, not just raw APY.
 * This provides more balanced and safer recommendations.
 * @param limit The number of opportunities to return.
 * @returns An array of top-quality yield pools.
 */
export async function getSmartYieldOpportunities(limit: number = 10): Promise<YieldPool[]> {
  try {
    const allPools = await getAllYieldPools();
    
    return allPools
      .filter(pool => 
        pool.chain.toUpperCase() === BSC_CHAIN_NAME && 
        pool.apy && 
        pool.apy > 1 && // APY should be at least 1%
        pool.tvlUsd &&
        pool.tvlUsd > 10000 // Minimum TVL of $10k to be considered
      )
      .map(pool => ({
        ...pool,
        // apy is already calculated in the filter, ensure it's on the object
        apy: pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0), 
        score: calculateOpportunityScore(pool) // Calculate smart score
      }))
      .sort((a, b) => (b as any).score - (a as any).score) // Sort by the new smart score
      .slice(0, limit);
  } catch (error) {
    logger.error('Error getting smart yield opportunities:', error);
    return [];
  }
}

/**
 * Get top yield opportunities for daily summaries
 */
export async function getTopYieldOpportunities(limit: number = 5): Promise<YieldPool[]> {
  return getTopBSCYieldOpportunities(limit);
}

/**
 * Format yield opportunity for display
 */
export function formatYieldOpportunity(opportunity: YieldOpportunity): string {
  // Create pool-specific link using the pool ID
  const poolUrl = `https://defillama.com/yields/pool/${opportunity.poolId}`;
  
  let message = `🌾 [${opportunity.project}](${poolUrl})\n`;
  message += `   APY: ${opportunity.apy.toFixed(2)}%\n`;
  message += `   TVL: $${(opportunity.tvlUsd / 1000000).toFixed(2)}M\n`;
  
  if (opportunity.rewardTokens && opportunity.rewardTokens.length > 0) {
    // Format reward tokens with BSCScan links
    const formattedRewards = opportunity.rewardTokens.map(token => {
      // Check if it's an address
      if (token.startsWith('0x') && token.length === 42) {
        return `[${token.slice(0, 6)}...${token.slice(-4)}](https://bscscan.com/token/${token})`;
      }
      return token;
    });
    message += `   Rewards: ${formattedRewards.join(', ')}\n`;
  }
  
  return message;
}

/**
 * Format yield opportunity for display with risk indicators
 */
export function formatYieldOpportunityWithRisk(pool: YieldPool): string {
  // Create pool-specific link using the pool ID
  const poolUrl = `https://defillama.com/yields/pool/${pool.pool}`;
  
  // Get risk assessment
  const { riskLevel, indicators } = getRiskIndicators(pool);
  
  let message = `${riskLevel === 'extreme' ? '🚨' : riskLevel === 'high' ? '🚩' : riskLevel === 'medium' ? '⚠️' : '🌾'} [${pool.project}](${poolUrl}) - ${pool.symbol}\n`;
  message += `   APY: ${pool.apy?.toFixed(2)}%\n`;
  message += `   TVL: $${(pool.tvlUsd / 1000000).toFixed(6)}M (${pool.tvlUsd.toFixed(0)})\n`;
  
  // Add risk indicators if any
  if (indicators.length > 0) {
    message += `   Risk: ${indicators.join(', ')}\n`;
  }
  
  if (pool.rewardTokens && pool.rewardTokens.length > 0) {
    // Format reward tokens with BSCScan links
    const formattedRewards = pool.rewardTokens.map(token => {
      // Check if it's an address
      if (token.startsWith('0x') && token.length === 42) {
        return `[${token.slice(0, 6)}...${token.slice(-4)}](https://bscscan.com/token/${token})`;
      }
      return token;
    });
    message += `   Rewards: ${formattedRewards.join(', ')}\n`;
  }
  
  return message;
}

/**
 * Format multiple yield opportunities for a token
 */
export function formatTokenYieldOpportunities(
  tokenSymbol: string,
  opportunities: YieldOpportunity[],
  lang: 'en' | 'zh' = 'en'
): string {
  if (opportunities.length === 0) {
    return '';
  }

  // Create the title with token symbol
  const title = lang === 'zh' 
    ? `\n💰 *${tokenSymbol} 收益机会*\n\n`
    : `\n💰 *${tokenSymbol} Yield Opportunities*\n\n`;
  
  let message = title;
  
  // Show top 3 opportunities
  const topOpportunities = opportunities.slice(0, 3);
  
  topOpportunities.forEach((opp, index) => {
    message += `${index + 1}. ${formatYieldOpportunity(opp)}\n`;
  });

  if (opportunities.length > 3) {
    // Create a DeFiLlama link to see all opportunities for this token
    const defiLlamaUrl = `https://defillama.com/yields?token=${tokenSymbol.toUpperCase()}&chain=BSC`;
    const remainingCount = opportunities.length - 3;
    
    const linkText = interpolate(t(lang, 'yieldTips.viewAllOpportunities'), { count: remainingCount });
    message += `\n[${linkText}](${defiLlamaUrl})\n`;
  }

  return message;
}

/**
 * Format multiple yield opportunities for a token with risk indicators
 */
export function formatTokenYieldOpportunitiesWithRisk(
  tokenSymbol: string,
  opportunities: YieldOpportunity[],
  lang: 'en' | 'zh' = 'en'
): string {
  if (opportunities.length === 0) {
    return '';
  }

  // Create the title with token symbol
  const title = lang === 'zh' 
    ? `\n💰 *${tokenSymbol} 收益机会*\n\n`
    : `\n💰 *${tokenSymbol} Yield Opportunities*\n\n`;
  
  let message = title;
  
  // Show top 3 opportunities
  const topOpportunities = opportunities.slice(0, 3);
  
  topOpportunities.forEach((opp, index) => {
    // Convert YieldOpportunity to YieldPool format for risk assessment
    const pool: YieldPool = {
      chain: 'BSC',
      project: opp.project,
      symbol: opp.tokenSymbol,
      pool: opp.poolId,
      apy: opp.apy,
      tvlUsd: opp.tvlUsd,
      rewardTokens: opp.rewardTokens,
      url: opp.url
    };
    
    // Get risk assessment
    const { riskLevel, indicators } = getRiskIndicators(pool);
    
    // Create pool-specific link using the pool ID
    const poolUrl = `https://defillama.com/yields/pool/${opp.poolId}`;
    
    // Use appropriate emoji based on risk level
    const riskEmoji = riskLevel === 'extreme' ? '🚨' : 
                     riskLevel === 'high' ? '🚩' : 
                     riskLevel === 'medium' ? '⚠️' : '🌾';
    
    message += `${index + 1}. ${riskEmoji} [${opp.project}](${poolUrl})\n`;
    message += `   APY: ${opp.apy.toFixed(2)}%\n`;
    message += `   TVL: $${(opp.tvlUsd / 1000000).toFixed(6)}M\n`;
    
    // Add risk indicators if any
    if (indicators.length > 0) {
      const riskText = lang === 'zh' ? '风险' : 'Risk';
      message += `   ${riskText}: ${indicators.join(', ')}\n`;
    }
    
    if (opp.rewardTokens && opp.rewardTokens.length > 0) {
      // Format reward tokens with BSCScan links
      const formattedRewards = opp.rewardTokens.map(token => {
        // Check if it's an address
        if (token.startsWith('0x') && token.length === 42) {
          return `[${token.slice(0, 6)}...${token.slice(-4)}](https://bscscan.com/token/${token})`;
        }
        return token;
      });
      message += `   ${lang === 'zh' ? '奖励' : 'Rewards'}: ${formattedRewards.join(', ')}\n`;
    }
    
    message += '\n';
  });

  if (opportunities.length > 3) {
    // Create a DeFiLlama link to see all opportunities for this token
    const defiLlamaUrl = `https://defillama.com/yields?token=${tokenSymbol.toUpperCase()}&chain=BSC`;
    const remainingCount = opportunities.length - 3;
    
    const linkText = interpolate(t(lang, 'yieldTips.viewAllOpportunities'), { count: remainingCount });
    message += `\n[${linkText}](${defiLlamaUrl})\n`;
  }

  return message;
}

/**
 * Find better yield opportunities for existing DeFi positions
 */
export async function findBetterYieldForPositions(
  defiPositions: DeFiProtocolPosition[],
  stakingPositions: StakingPosition[],
  minAPYImprovement: number = 2
): Promise<ProtocolSuggestion[]> {
  try {
    const allPools = await getAllYieldPools();
    const suggestions: ProtocolSuggestion[] = [];
    
    // Process DeFi protocol positions
    for (const position of defiPositions) {
      if (position.balance_usd < 10) continue;
      
      // Estimate current APY from yearly earnings
      const currentAPY = position.yearly_earnings_usd > 0 
        ? (position.yearly_earnings_usd / position.balance_usd) * 100 
        : 0;
      
      // Check each token in the position
      for (const token of position.tokens || []) {
        const tokenSymbol = token.symbol.toUpperCase();
        
        // Find BSC pools with this token
        const betterPools = allPools.filter(pool => {
          if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) return false;
          
          const poolSymbol = pool.symbol.toUpperCase();
          const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
          
          // Must have better APY and decent TVL
          if (poolAPY <= currentAPY + minAPYImprovement || pool.tvlUsd < 100000) {
            return false;
          }
          
          // Check if pool contains the token
          return poolSymbol === tokenSymbol || 
                 poolSymbol.includes(`${tokenSymbol}-`) ||
                 poolSymbol.includes(`-${tokenSymbol}`) ||
                 poolSymbol.includes(`${tokenSymbol}/`) ||
                 poolSymbol.includes(`/${tokenSymbol}`);
        });
        
        // Add top 2 suggestions per token
        betterPools
          .sort((a, b) => (b.apy || 0) - (a.apy || 0))
          .slice(0, 2)
          .forEach(pool => {
            const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
            
            suggestions.push({
              protocol: pool.project,
              poolName: pool.symbol,
              tokenSymbol: token.symbol,
              apy: poolAPY,
              tvlUsd: pool.tvlUsd,
              reason: `${poolAPY.toFixed(1)}% APY vs current ${currentAPY.toFixed(1)}%`,
              apyImprovement: poolAPY - currentAPY,
              riskLevel: determineRiskLevel(pool)
            });
          });
      }
    }
    
    // Process staking positions
    for (const position of stakingPositions) {
      if (position.usdValue < 10) continue;
      
      const tokenSymbol = position.tokenSymbol.toUpperCase();
      
      // Find better opportunities
      const betterPools = allPools.filter(pool => {
        if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) return false;
        
        const poolSymbol = pool.symbol.toUpperCase();
        const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
        
        // Must have decent APY and TVL
        if (poolAPY < minAPYImprovement || pool.tvlUsd < 100000) {
          return false;
        }
        
        return poolSymbol === tokenSymbol || 
               poolSymbol.includes(`${tokenSymbol}-`) ||
               poolSymbol.includes(`-${tokenSymbol}`) ||
               poolSymbol.includes(`${tokenSymbol}/`) ||
               poolSymbol.includes(`/${tokenSymbol}`);
      });
      
      betterPools
        .sort((a, b) => (b.apy || 0) - (a.apy || 0))
        .slice(0, 2)
        .forEach(pool => {
          const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
          
          suggestions.push({
            protocol: pool.project,
            poolName: pool.symbol,
            tokenSymbol: position.tokenSymbol,
            apy: poolAPY,
            tvlUsd: pool.tvlUsd,
            reason: `${poolAPY.toFixed(1)}% APY opportunity`,
            apyImprovement: poolAPY,
            riskLevel: determineRiskLevel(pool)
          });
        });
    }
    
    // Sort by APY improvement
    return suggestions.sort((a, b) => (b.apyImprovement || 0) - (a.apyImprovement || 0));
  } catch (error) {
    logger.error('Error finding better yield opportunities:', error);
    return [];
  }
}

/**
 * Determine risk level based on pool characteristics
 */
function determineRiskLevel(pool: YieldPool): 'low' | 'medium' | 'high' {
  // High TVL and established project = low risk
  if (pool.tvlUsd > 10000000 && ['pancakeswap', 'venus', 'alpaca'].includes(pool.project.toLowerCase())) {
    return 'low';
  }
  
  // Medium TVL or newer protocols = medium risk
  if (pool.tvlUsd > 1000000) {
    return 'medium';
  }
  
  // Low TVL or very high APY (possible unsustainable) = high risk
  return 'high';
}

/**
 * Get risk indicators for yield opportunities based on TVL/APY ratio and other factors
 */
export function getRiskIndicators(pool: YieldPool): { riskLevel: 'low' | 'medium' | 'high' | 'extreme', indicators: string[] } {
  const indicators: string[] = [];
  const apy = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
  const tvlUsd = pool.tvlUsd;
  
  // Calculate TVL/APY ratio for risk assessment
  const tvlApyRatio = apy > 0 ? tvlUsd / apy : 0;
  
  // Red flags based on your criteria
  if (tvlUsd < 50000) {
    indicators.push('🚩 Extremely Low TVL');
  } else if (tvlUsd < 100000) {
    indicators.push('⚠️ Low TVL');
  }
  
  if (apy > 1000) {
    indicators.push('🔥 Extremely High APY');
  } else if (apy > 500) {
    indicators.push('⚠️ Very High APY');
  } else if (apy > 200) {
    indicators.push('⚠️ High APY');
  }
  
  // TVL/APY ratio warnings
  if (tvlApyRatio < 100) {
    indicators.push('🚨 High Risk Ratio');
  } else if (tvlApyRatio < 500) {
    indicators.push('⚠️ Medium Risk Ratio');
  }
  
  // Project age and reputation (basic check)
  const suspiciousProjects = ['babydogeswap', 'memeswap', 'shitcoin'];
  if (suspiciousProjects.some(proj => pool.project.toLowerCase().includes(proj))) {
    indicators.push('⚠️ New/Unverified Project');
  }
  
  // Determine overall risk level
  let riskLevel: 'low' | 'medium' | 'high' | 'extreme' = 'low';
  
  if (tvlUsd < 50000 || apy > 1000 || tvlApyRatio < 100) {
    riskLevel = 'extreme';
  } else if (tvlUsd < 100000 || apy > 500 || tvlApyRatio < 500) {
    riskLevel = 'high';
  } else if (tvlUsd < 1000000 || apy > 200) {
    riskLevel = 'medium';
  }
  
  return { riskLevel, indicators };
}

/**
 * Match DeFi positions with DeFiLlama pools and get their APYs
 */
export async function getAPYsForDeFiPositions(
  defiPositions: DeFiProtocolPosition[]
): Promise<Map<string, { protocolName: string; apy: number; poolId?: string }>> {
  try {
    const allPools = await getAllYieldPools();
    const positionAPYs = new Map<string, { protocolName: string; apy: number; poolId?: string }>();
    
    for (const position of defiPositions) {
      // Skip positions with no value
      if (!position.balance_usd || position.balance_usd < 0.01) continue;
      
      const protocolName = position.protocol_name.toLowerCase();
      const positionKey = `${position.protocol_name}_${position.protocol_id}`;
      
      // Get all tokens in this position
      const tokenSymbols = position.tokens?.map(t => t.symbol.toUpperCase()) || [];
      
      // Find matching pools
      const matchingPools = allPools.filter(pool => {
        // Check chain
        if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) return false;
        
        // Check protocol name match (fuzzy matching)
        const poolProject = pool.project.toLowerCase();
        if (!poolProject.includes(protocolName) && !protocolName.includes(poolProject)) {
          // Special cases for protocol name variations
          const protocolAliases: Record<string, string[]> = {
            'pancakeswap': ['pancakeswap', 'pancake', 'pcs', 'pancakeswap-amm', 'pancakeswap-v3'],
            'pancakeswap v3': ['pancakeswap', 'pancake', 'pcs', 'pancakeswap-amm', 'pancakeswap-v3'],
            'venus': ['venus', 'venusbsc'],
            'alpaca': ['alpaca', 'alpaca-finance'],
            'beefy': ['beefy', 'beefy-finance'],
            'autofarm': ['autofarm', 'auto']
          };
          
          let aliasMatch = false;
          for (const [key, aliases] of Object.entries(protocolAliases)) {
            if (aliases.includes(protocolName) && aliases.some(alias => poolProject.includes(alias))) {
              aliasMatch = true;
              break;
            }
          }
          if (!aliasMatch) return false;
        }
        
        // Check if pool contains any of the position's tokens
        const poolSymbol = pool.symbol.toUpperCase();
        return tokenSymbols.some(tokenSymbol => 
          poolSymbol === tokenSymbol || 
          poolSymbol.includes(tokenSymbol)
        );
      });
      
      if (matchingPools.length > 0) {
        // Get the pool with highest TVL (most likely to be the main pool)
        const bestMatch = matchingPools.sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
        const apy = bestMatch.apy || (bestMatch.apyBase || 0) + (bestMatch.apyReward || 0);
        
        positionAPYs.set(positionKey, {
          protocolName: position.protocol_name,
          apy: apy,
          poolId: bestMatch.pool
        });
        
        logger.info(`✅ Matched ${position.protocol_name} to pool ${bestMatch.project} - ${bestMatch.symbol} with APY ${apy.toFixed(2)}%`);
      } else {
        // No match found, use 0 APY
        positionAPYs.set(positionKey, {
          protocolName: position.protocol_name,
          apy: 0,
          poolId: undefined
        });
        
        logger.info(`❌ No APY match found for ${position.protocol_name} with tokens: ${tokenSymbols.join(', ')}`);
        logger.info(`   Protocol variations checked: ${protocolName}`);
      }
    }
    
    return positionAPYs;
  } catch (error) {
    logger.error('Error fetching APYs for DeFi positions:', error);
    return new Map();
  }
}

/**
 * Calculate weighted average APY for positions
 */
export function calculateWeightedAverageAPY(
  positions: DeFiProtocolPosition[],
  apyMap: Map<string, { protocolName: string; apy: number; poolId?: string }>
): { averageAPY: number; positionsWithAPY: Array<{ protocol: string; apy: number; value: number }> } {
  let totalWeightedAPY = 0;
  let totalValue = 0;
  const positionsWithAPY: Array<{ protocol: string; apy: number; value: number }> = [];
  
  for (const position of positions) {
    const positionKey = `${position.protocol_name}_${position.protocol_id}`;
    const apyData = apyMap.get(positionKey);
    const value = position.balance_usd || 0;
    
    if (value > 0) {
      const apy = apyData?.apy || 0;
      totalWeightedAPY += apy * value;
      totalValue += value;
      
      positionsWithAPY.push({
        protocol: position.protocol_name,
        apy: apy,
        value: value
      });
    }
  }
  
  const averageAPY = totalValue > 0 ? totalWeightedAPY / totalValue : 0;
  
  return { averageAPY, positionsWithAPY };
}

/**
 * Get yield opportunities for idle tokens
 */
export async function getYieldOpportunitiesForIdleTokens(
  idleTokens: Array<{ symbol: string; usdValue: number }>,
  limit: number = 3
): Promise<Map<string, ProtocolSuggestion[]>> {
  try {
    const allPools = await getAllYieldPools();
    const suggestionsMap = new Map<string, ProtocolSuggestion[]>();
    
    for (const token of idleTokens) {
      const tokenSymbol = token.symbol.toUpperCase();
      
      const opportunities = allPools
        .filter(pool => {
          if (pool.chain.toUpperCase() !== BSC_CHAIN_NAME) return false;
          
          const poolSymbol = pool.symbol.toUpperCase();
          const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
          
          // Must have decent APY and TVL
          if (poolAPY < 1 || pool.tvlUsd < 50000) return false;
          
          return poolSymbol === tokenSymbol || 
                 poolSymbol.includes(`${tokenSymbol}-`) ||
                 poolSymbol.includes(`-${tokenSymbol}`) ||
                 poolSymbol.includes(`${tokenSymbol}/`) ||
                 poolSymbol.includes(`/${tokenSymbol}`);
        })
        .sort((a, b) => (b.apy || 0) - (a.apy || 0))
        .slice(0, limit)
        .map(pool => {
          const poolAPY = pool.apy || (pool.apyBase || 0) + (pool.apyReward || 0);
          
          return {
            protocol: pool.project,
            poolName: pool.symbol,
            tokenSymbol: token.symbol,
            apy: poolAPY,
            tvlUsd: pool.tvlUsd,
            reason: `Earn ${poolAPY.toFixed(1)}% APY on idle ${token.symbol}`,
            riskLevel: determineRiskLevel(pool)
          };
        });
      
      if (opportunities.length > 0) {
        suggestionsMap.set(token.symbol, opportunities);
      }
    }
    
    return suggestionsMap;
  } catch (error) {
    logger.error('Error getting yield opportunities for idle tokens:', error);
    return new Map();
  }
}

// Export the yield service as a singleton
export const yieldService = {
  getAllYieldPools,
  findYieldOpportunitiesForToken,
  findYieldOpportunitiesForTokens,
  getTopBSCYieldOpportunities,
  getTopYieldOpportunities,
  formatYieldOpportunity,
  formatYieldOpportunityWithRisk,
  formatTokenYieldOpportunities,
  formatTokenYieldOpportunitiesWithRisk,
  findBetterYieldForPositions,
  getAPYsForDeFiPositions,
  calculateWeightedAverageAPY,
  getYieldOpportunitiesForIdleTokens,
  getRiskIndicators
};