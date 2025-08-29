import axios from 'axios';
import { DeFiProtocolPosition } from '@/database/models/DeFiPosition';
import { createLogger } from '@/utils/logger';

const logger = createLogger('defi.apyCalculator');

interface ProtocolFees {
  protocol: string;
  dailyFees?: number;
  dailyRevenue?: number;
  tvl?: number;
}

interface VolumeData {
  protocol: string;
  dailyVolume?: number;
  tvl?: number;
}

/**
 * Calculate APY for DeFi positions using fee data when pool APY is not available
 * APY Formula: (Daily Fees * 365 / TVL) * 100
 */
export async function calculateAPYForPositions(
  positions: DeFiProtocolPosition[]
): Promise<Map<string, { apy: number; source: string }>> {
  const apyMap = new Map<string, { apy: number; source: string }>();
  
  try {
    // Fetch fees data from DeFiLlama
    const feesResponse = await axios.get('https://api.llama.fi/overview/fees/bsc', {
      params: {
        excludeTotalDataChart: true,
        excludeTotalDataChartBreakdown: true
      }
    });
    
    const feesData: ProtocolFees[] = feesResponse.data?.protocols || [];
    logger.info(`Fetched ${feesData.length} protocols with fee data from DeFiLlama`);
    
    // Also fetch volume data as a fallback
    const volumeResponse = await axios.get('https://api.llama.fi/overview/dexs/bsc', {
      params: {
        excludeTotalDataChart: true,
        excludeTotalDataChartBreakdown: true
      }
    });
    
    const volumeData: VolumeData[] = volumeResponse.data?.protocols || [];
    logger.info(`Fetched ${volumeData.length} DEXs with volume data from DeFiLlama`);
    
    // Create lookup maps
    const feesMap = new Map<string, ProtocolFees>();
    feesData.forEach(protocol => {
      if (protocol.protocol) {
        const name = protocol.protocol.toLowerCase();
        feesMap.set(name, protocol);
        
        // Also add variations
        if (name.includes('pancake')) {
          feesMap.set('pancakeswap', protocol);
          feesMap.set('pancakeswap-v3', protocol);
          feesMap.set('pancakeswap v3', protocol);
          logger.info(`Added PancakeSwap fees data: ${name}`);
        }
      }
    });
    
    const volumeMap = new Map<string, VolumeData>();
    volumeData.forEach(protocol => {
      if (protocol.protocol) {
        const name = protocol.protocol.toLowerCase();
        volumeMap.set(name, protocol);
        
        // Also add variations
        if (name.includes('pancake')) {
          volumeMap.set('pancakeswap', protocol);
          volumeMap.set('pancakeswap-v3', protocol);
          volumeMap.set('pancakeswap v3', protocol);
          logger.info(`Added PancakeSwap volume data: ${name}, Volume: $${((protocol.dailyVolume || 0)/1000000).toFixed(2)}M`);
        }
      }
    });
    
    // Calculate APY for each position
    for (const position of positions) {
      const positionKey = `${position.protocol_name}_${position.protocol_id}`;
      const protocolName = position.protocol_name.toLowerCase();
      
      // Skip if position has no value
      if (!position.balance_usd || position.balance_usd < 0.01) {
        apyMap.set(positionKey, { apy: 0, source: 'no_value' });
        continue;
      }
      
      // Try to find fees data with multiple variations
      let feesInfo = feesMap.get(protocolName);
      if (!feesInfo && protocolName.includes('pancakeswap')) {
        // Try variations for PancakeSwap
        feesInfo = feesMap.get('pancakeswap') || 
                  feesMap.get('pancakeswap-v3') || 
                  feesMap.get('pancakeswap-v2') ||
                  feesMap.get('pancakeswap-amm-v3');
      }
      
      if (feesInfo && feesInfo.dailyFees && feesInfo.tvl) {
        // Calculate APY from fees: (Daily Fees * 365 / TVL) * 100
        const apy = (feesInfo.dailyFees * 365 / feesInfo.tvl) * 100;
        apyMap.set(positionKey, { 
          apy: Math.max(0, apy), 
          source: 'fees' 
        });
        logger.info(`✅ Calculated APY for ${position.protocol_name} from fees: ${apy.toFixed(2)}%`);
        continue;
      }
      
      // Try volume-based estimation for DEXs
      let volumeInfo = volumeMap.get(protocolName);
      if (!volumeInfo && protocolName.includes('pancakeswap')) {
        // Try variations for PancakeSwap
        volumeInfo = volumeMap.get('pancakeswap') || 
                    volumeMap.get('pancakeswap-v3') || 
                    volumeMap.get('pancakeswap-v2') ||
                    volumeMap.get('pancakeswap-amm-v3');
      }
      
      if (volumeInfo && volumeInfo.dailyVolume && volumeInfo.tvl) {
        // Estimate APY from volume: assume 0.3% fee tier for most pools
        // For stable pools, use 0.05% fee tier
        const isStablePool = position.tokens.some(t => 
          ['USDT', 'USDC', 'BUSD', 'DAI', 'USD1'].includes(t.symbol.toUpperCase())
        );
        const feeRate = isStablePool ? 0.0005 : 0.003;
        
        const estimatedDailyFees = volumeInfo.dailyVolume * feeRate;
        const apy = (estimatedDailyFees * 365 / volumeInfo.tvl) * 100;
        apyMap.set(positionKey, { 
          apy: Math.max(0, apy), 
          source: 'volume_estimate' 
        });
        logger.info(`📊 Estimated APY for ${position.protocol_name} from volume: ${apy.toFixed(2)}%`);
        continue;
      }
      
      // Special cases for known protocols
      if (protocolName.includes('vecake')) {
        // veCAKE typically has 5-15% APY
        apyMap.set(positionKey, { apy: 8.5, source: 'estimated' });
        logger.info(`📌 Using estimated APY for veCAKE: 8.5%`);
      } else if (protocolName.includes('venus')) {
        // Venus typically has 2-5% APY for BNB
        apyMap.set(positionKey, { apy: 3.5, source: 'estimated' });
        logger.info(`📌 Using estimated APY for Venus: 3.5%`);
      } else if (protocolName.includes('pancakeswap')) {
        // Estimate APY based on token pairs
        let estimatedApy = 5.0; // Default for unknown pairs
        
        const tokenSymbols = position.tokens.map(t => t.symbol.toUpperCase());
        
        // Major pairs typically have higher APY
        if (tokenSymbols.includes('BNB') && tokenSymbols.includes('USDT')) {
          estimatedApy = 8.0;
        } else if (tokenSymbols.includes('BNB') && tokenSymbols.includes('ETH')) {
          estimatedApy = 10.0;
        } else if (tokenSymbols.includes('BNB') && tokenSymbols.includes('CAKE')) {
          estimatedApy = 15.0;
        } else if (tokenSymbols.includes('CAKE') && tokenSymbols.includes('USDT')) {
          estimatedApy = 12.0;
        } else if (tokenSymbols.some(t => ['USDT', 'USDC', 'BUSD', 'DAI', 'USD1'].includes(t))) {
          estimatedApy = 4.0; // Stable pairs have lower APY
        }
        
        apyMap.set(positionKey, { apy: estimatedApy, source: 'estimated' });
        logger.info(`📌 Using estimated APY for PancakeSwap LP (${tokenSymbols.join('-')}): ${estimatedApy}%`);
      } else {
        // No data available
        apyMap.set(positionKey, { apy: 0, source: 'no_data' });
        logger.info(`❌ No APY data available for ${position.protocol_name}`);
      }
    }
    
    return apyMap;
  } catch (error) {
    logger.error('Error calculating APY for positions:', { error });
    // Return empty APYs on error
    positions.forEach(pos => {
      const positionKey = `${pos.protocol_name}_${pos.protocol_id}`;
      apyMap.set(positionKey, { apy: 0, source: 'error' });
    });
    return apyMap;
  }
}

/**
 * Get a more accurate APY by combining multiple data sources
 */
export async function getEnhancedAPYForPositions(
  positions: DeFiProtocolPosition[],
  poolAPYs: Map<string, { protocolName: string; apy: number; poolId?: string }>
): Promise<Map<string, { apy: number; poolId?: string; source: string }>> {
  // First, get calculated APYs
  const calculatedAPYs = await calculateAPYForPositions(positions);
  
  // Combine with pool APYs, preferring pool data when available
  const enhancedAPYs = new Map<string, { apy: number; poolId?: string; source: string }>();
  
  positions.forEach(position => {
    const positionKey = `${position.protocol_name}_${position.protocol_id}`;
    
    // Check if we have pool APY
    const poolAPY = poolAPYs.get(positionKey);
    const calculatedAPY = calculatedAPYs.get(positionKey);
    
    if (poolAPY && poolAPY.apy > 0) {
      // Use pool APY if available
      enhancedAPYs.set(positionKey, {
        apy: poolAPY.apy,
        poolId: poolAPY.poolId,
        source: 'pool'
      });
    } else if (calculatedAPY && calculatedAPY.apy > 0) {
      // Use calculated APY as fallback
      enhancedAPYs.set(positionKey, {
        apy: calculatedAPY.apy,
        poolId: undefined,
        source: calculatedAPY.source
      });
    } else {
      // No APY data
      enhancedAPYs.set(positionKey, {
        apy: 0,
        poolId: undefined,
        source: 'no_data'
      });
    }
  });
  
  return enhancedAPYs;
}