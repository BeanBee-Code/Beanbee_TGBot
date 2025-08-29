import { createLogger } from '@/utils/logger';
import { pythPriceService } from '@/services/pyth/priceService';
import { pairDiscoveryService } from '@/services/pancakeswap/pairDiscovery';
import { ethers } from 'ethers';

const logger = createLogger('priceDeviationChecker');

export interface PriceDeviationResult {
  hasDeviation: boolean;
  deviationPercentage: number;
  pythPrice: number | null;
  dexPrice: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export class PriceDeviationChecker {
  private static readonly WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  
  // Deviation thresholds
  private static readonly LOW_RISK_THRESHOLD = 3;      // < 3% deviation
  private static readonly MEDIUM_RISK_THRESHOLD = 6;   // 3-6% deviation  
  private static readonly HIGH_RISK_THRESHOLD = 10;    // 6-10% deviation
  // > 10% is critical
  
  /**
   * Check price deviation between Pyth oracle and DEX prices
   */
  static async checkPriceDeviation(tokenAddress: string): Promise<PriceDeviationResult> {
    try {
      logger.info('Checking price deviation', { tokenAddress });
      
      // Fetch prices in parallel
      const [pythPriceUSD, tokenDiscovery] = await Promise.all([
        pythPriceService.fetchPriceByAddress(tokenAddress),
        pairDiscoveryService.discoverTokenPair(tokenAddress)
      ]);
      
      // Parse DEX price from currentPrice string
      const dexPriceUSD = tokenDiscovery?.currentPrice ? parseFloat(tokenDiscovery.currentPrice) : null;
      
      // If we don't have both prices, we can't calculate deviation
      if (!pythPriceUSD || !dexPriceUSD) {
        logger.info('Insufficient price data for deviation check', { 
          hasPythPrice: !!pythPriceUSD, 
          hasDexPrice: !!dexPriceUSD 
        });
        
        return {
          hasDeviation: false,
          deviationPercentage: 0,
          pythPrice: pythPriceUSD,
          dexPrice: dexPriceUSD,
          riskLevel: 'low',
          message: 'Unable to calculate price deviation (missing price data)'
        };
      }
      
      // Calculate percentage deviation
      const deviationPercentage = Math.abs((dexPriceUSD - pythPriceUSD) / pythPriceUSD) * 100;
      
      // Determine risk level
      let riskLevel: 'low' | 'medium' | 'high' | 'critical';
      let message: string;
      
      if (deviationPercentage < this.LOW_RISK_THRESHOLD) {
        riskLevel = 'low';
        message = `Price deviation is minimal (${deviationPercentage.toFixed(2)}%)`;
      } else if (deviationPercentage < this.MEDIUM_RISK_THRESHOLD) {
        riskLevel = 'medium';
        message = `⚠️ Moderate price deviation detected (${deviationPercentage.toFixed(2)}%)`;
      } else if (deviationPercentage < this.HIGH_RISK_THRESHOLD) {
        riskLevel = 'high';
        message = `⚠️ HIGH PRICE DEVIATION: DEX price differs ${deviationPercentage.toFixed(2)}% from market price. High slippage expected!`;
      } else {
        riskLevel = 'critical';
        message = `🚨 CRITICAL PRICE DEVIATION: ${deviationPercentage.toFixed(2)}% difference! Possible liquidity manipulation or scam. EXTREME CAUTION ADVISED!`;
      }
      
      logger.info('Price deviation analysis complete', {
        tokenAddress,
        deviationPercentage: deviationPercentage.toFixed(2),
        riskLevel,
        pythPriceUSD,
        dexPriceUSD
      });
      
      return {
        hasDeviation: deviationPercentage >= this.LOW_RISK_THRESHOLD,
        deviationPercentage,
        pythPrice: pythPriceUSD,
        dexPrice: dexPriceUSD,
        riskLevel,
        message
      };
      
    } catch (error) {
      logger.error('Error checking price deviation', { 
        error: error instanceof Error ? error.message : String(error),
        tokenAddress 
      });
      
      return {
        hasDeviation: false,
        deviationPercentage: 0,
        pythPrice: null,
        dexPrice: null,
        riskLevel: 'low',
        message: 'Price deviation check failed'
      };
    }
  }
  
  /**
   * Get risk score adjustment based on price deviation
   * Returns a negative number to subtract from safety score
   */
  static getDeviationRiskScore(deviationPercentage: number): number {
    if (deviationPercentage < this.LOW_RISK_THRESHOLD) {
      return 0; // No penalty
    } else if (deviationPercentage < this.MEDIUM_RISK_THRESHOLD) {
      return -5; // Small penalty
    } else if (deviationPercentage < this.HIGH_RISK_THRESHOLD) {
      return -15; // Significant penalty
    } else if (deviationPercentage < 20) {
      return -30; // Major penalty
    } else {
      return -50; // Severe penalty for extreme deviations
    }
  }
  
  /**
   * Format deviation warning for display
   */
  static formatDeviationWarning(result: PriceDeviationResult): string {
    if (!result.hasDeviation) {
      return '';
    }
    
    let warning = '\n━━━━━━━━━━━━━━━━━━━━━━\n';
    
    if (result.riskLevel === 'critical') {
      warning += '🚨 **CRITICAL PRICE WARNING** 🚨\n';
    } else if (result.riskLevel === 'high') {
      warning += '⚠️ **HIGH PRICE DEVIATION** ⚠️\n';
    } else {
      warning += '⚠️ **Price Deviation Alert** ⚠️\n';
    }
    
    warning += `\nDEX Price vs Oracle Price: **${result.deviationPercentage.toFixed(2)}% difference**\n`;
    
    if (result.pythPrice && result.dexPrice) {
      warning += `• Oracle Price: $${result.pythPrice.toFixed(6)}\n`;
      warning += `• DEX Price: $${result.dexPrice.toFixed(6)}\n`;
    }
    
    if (result.riskLevel === 'critical') {
      warning += '\n⚠️ This extreme deviation suggests:\n';
      warning += '• Possible liquidity manipulation\n';
      warning += '• Potential scam or rug pull\n';
      warning += '• Very high slippage expected\n';
      warning += '\n**STRONGLY RECOMMEND AVOIDING THIS TRADE**';
    } else if (result.riskLevel === 'high') {
      warning += '\n⚠️ This deviation may cause:\n';
      warning += '• Higher than expected slippage\n';
      warning += '• Unfavorable execution price\n';
      warning += '\nProceed with caution!';
    }
    
    warning += '\n━━━━━━━━━━━━━━━━━━━━━━\n';
    
    return warning;
  }
}

export const priceDeviationChecker = PriceDeviationChecker;