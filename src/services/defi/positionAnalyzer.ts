import { DeFiProtocolPosition, StakingPosition } from '@/database/models/DeFiPosition';
import { YieldOpportunity } from '../defiLlama/yieldService';

export interface TokenHolding {
  symbol: string;
  balance: number;
  usdValue: number;
  address?: string;
}

export interface IdleCapitalReport {
  totalIdleUsd: number;
  idleTokens: Array<{
    symbol: string;
    usdValue: number;
    percentage: number;
  }>;
  suggestions: string[];
}

export interface APYComparison {
  currentPosition: {
    protocol: string;
    tokenSymbol: string;
    currentAPY: number;
    usdValue: number;
  };
  betterOptions: Array<{
    protocol: string;
    poolName: string;
    apy: number;
    apyImprovement: number;
    tvlUsd: number;
  }>;
}

export interface RebalancingSuggestion {
  fromProtocol: string;
  toProtocol: string;
  tokenSymbol: string;
  reason: string;
  apyImprovement?: number;
  riskScore?: number;
}

export interface DeFiPositionSummary {
  totalValueLocked: number;
  totalYearlyEarnings: number;
  averageAPY: number;
  protocolCount: number;
  topProtocols: Array<{
    name: string;
    valueUsd: number;
    percentage: number;
  }>;
  positionsWithAPY?: Array<{
    protocol: string;
    apy: number;
    value: number;
  }>;
}

export class PositionAnalyzer {
  /**
   * Analyze idle capital that could be deployed to earn yield
   */
  analyzeIdleCapital(
    holdings: TokenHolding[],
    defiPositions: DeFiProtocolPosition[],
    stakingPositions: StakingPosition[]
  ): IdleCapitalReport {
    // Calculate total value in DeFi
    const totalInDeFi = this.calculateTotalDeFiValue(defiPositions, stakingPositions);
    
    // Calculate total holdings value
    const totalHoldingsValue = holdings.reduce((sum, token) => sum + token.usdValue, 0);
    
    // Find tokens not in any DeFi position
    const tokensInDeFi = new Set<string>();
    
    // Add tokens from DeFi protocol positions
    defiPositions.forEach(pos => {
      pos.tokens?.forEach((token: any) => {
        tokensInDeFi.add(token.symbol.toUpperCase());
      });
    });
    
    // Add tokens from staking positions
    stakingPositions.forEach(pos => {
      tokensInDeFi.add(pos.tokenSymbol.toUpperCase());
    });
    
    // Identify idle tokens
    const idleTokens = holdings
      .filter(token => !tokensInDeFi.has(token.symbol.toUpperCase()) && token.usdValue > 10)
      .sort((a, b) => b.usdValue - a.usdValue);
    
    const totalIdleUsd = idleTokens.reduce((sum, token) => sum + token.usdValue, 0);
    const idlePercentage = totalHoldingsValue > 0 ? (totalIdleUsd / totalHoldingsValue) * 100 : 0;
    
    // Generate suggestions
    const suggestions: string[] = [];
    
    if (idlePercentage > 50) {
      suggestions.push(`⚠️ ${idlePercentage.toFixed(1)}% of your portfolio is idle and not earning yield!`);
    } else if (idlePercentage > 25) {
      suggestions.push(`💡 ${idlePercentage.toFixed(1)}% of your portfolio could be earning yield`);
    }
    
    if (idleTokens.length > 0) {
      const topIdleToken = idleTokens[0];
      suggestions.push(`🎯 Your largest idle holding is ${topIdleToken.symbol} ($${topIdleToken.usdValue.toFixed(2)})`);
    }
    
    return {
      totalIdleUsd,
      idleTokens: idleTokens.map(token => ({
        symbol: token.symbol,
        usdValue: token.usdValue,
        percentage: (token.usdValue / totalHoldingsValue) * 100
      })),
      suggestions
    };
  }
  
  /**
   * Compare current position APYs with available market opportunities
   */
  compareAPYs(
    defiPositions: DeFiProtocolPosition[],
    stakingPositions: StakingPosition[],
    marketOpportunities: YieldOpportunity[]
  ): APYComparison[] {
    const comparisons: APYComparison[] = [];
    
    // Process DeFi protocol positions
    defiPositions.forEach(position => {
      if (position.balance_usd > 10) {
        // Estimate current APY from yearly earnings
        const estimatedAPY = position.yearly_earnings_usd > 0 
          ? (position.yearly_earnings_usd / position.balance_usd) * 100 
          : 0;
        
        position.tokens?.forEach((token: any) => {
          const tokenSymbol = token.symbol.toUpperCase();
          
          // Find better opportunities for this token
          const betterOptions = marketOpportunities
            .filter(opp => 
              opp.tokenSymbol.toUpperCase() === tokenSymbol &&
              opp.apy > estimatedAPY + 2 && // At least 2% better
              opp.tvlUsd > 100000 // Minimum TVL for safety
            )
            .sort((a, b) => b.apy - a.apy)
            .slice(0, 3);
          
          if (betterOptions.length > 0) {
            comparisons.push({
              currentPosition: {
                protocol: position.protocol_name,
                tokenSymbol,
                currentAPY: estimatedAPY,
                usdValue: token.usd_value || 0
              },
              betterOptions: betterOptions.map(opt => ({
                protocol: opt.project,
                poolName: opt.poolId,
                apy: opt.apy,
                apyImprovement: opt.apy - estimatedAPY,
                tvlUsd: opt.tvlUsd
              }))
            });
          }
        });
      }
    });
    
    return comparisons;
  }
  
  /**
   * Suggest rebalancing opportunities based on risk, APY, and diversification
   */
  suggestRebalancing(
    defiPositions: DeFiProtocolPosition[],
    stakingPositions: StakingPosition[]
  ): RebalancingSuggestion[] {
    const suggestions: RebalancingSuggestion[] = [];
    
    // Calculate protocol concentration
    const protocolValues = new Map<string, number>();
    const totalValue = this.calculateTotalDeFiValue(defiPositions, stakingPositions);
    
    defiPositions.forEach(pos => {
      const current = protocolValues.get(pos.protocol_name) || 0;
      const value = pos.balance_usd || 0;
      protocolValues.set(pos.protocol_name, current + (isNaN(value) ? 0 : value));
    });
    
    stakingPositions.forEach(pos => {
      const current = protocolValues.get(pos.protocol) || 0;
      const value = pos.usdValue || 0;
      protocolValues.set(pos.protocol, current + (isNaN(value) ? 0 : value));
    });
    
    // Check for over-concentration
    protocolValues.forEach((value, protocol) => {
      const percentage = (value / totalValue) * 100;
      if (percentage > 50 && protocolValues.size > 1) {
        suggestions.push({
          fromProtocol: protocol,
          toProtocol: 'Other protocols',
          tokenSymbol: 'Various',
          reason: `${percentage.toFixed(1)}% concentration in ${protocol} - consider diversifying`,
        });
      }
    });
    
    // Check for low-value positions that could be consolidated
    defiPositions.forEach(pos => {
      if (pos.balance_usd < 50 && pos.balance_usd > 0) {
        suggestions.push({
          fromProtocol: pos.protocol_name,
          toProtocol: 'Higher value positions',
          tokenSymbol: 'Various',
          reason: `Small position ($${pos.balance_usd.toFixed(2)}) - consider consolidating for gas efficiency`,
        });
      }
    });
    
    return suggestions;
  }
  
  /**
   * Generate a summary of all DeFi positions
   */
  generatePositionSummary(
    defiPositions: DeFiProtocolPosition[],
    stakingPositions: StakingPosition[]
  ): DeFiPositionSummary {
    const totalValueLocked = this.calculateTotalDeFiValue(defiPositions, stakingPositions);
    
    // Calculate total yearly earnings
    const totalYearlyEarnings = defiPositions.reduce(
      (sum, pos) => {
        const earnings = pos.yearly_earnings_usd || 0;
        return sum + (isNaN(earnings) ? 0 : earnings);
      }, 
      0
    );
    
    // Calculate average APY
    const averageAPY = totalValueLocked > 0 
      ? (totalYearlyEarnings / totalValueLocked) * 100 
      : 0;
    
    // Count unique protocols
    const protocols = new Set<string>();
    defiPositions.forEach(pos => protocols.add(pos.protocol_name));
    stakingPositions.forEach(pos => protocols.add(pos.protocol));
    
    // Calculate top protocols by value
    const protocolValues = new Map<string, number>();
    
    defiPositions.forEach(pos => {
      const current = protocolValues.get(pos.protocol_name) || 0;
      const value = pos.balance_usd || 0;
      protocolValues.set(pos.protocol_name, current + (isNaN(value) ? 0 : value));
    });
    
    stakingPositions.forEach(pos => {
      const current = protocolValues.get(pos.protocol) || 0;
      const value = pos.usdValue || 0;
      protocolValues.set(pos.protocol, current + (isNaN(value) ? 0 : value));
    });
    
    const topProtocols = Array.from(protocolValues.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, valueUsd]) => ({
        name,
        valueUsd,
        percentage: totalValueLocked > 0 ? (valueUsd / totalValueLocked) * 100 : 0
      }));
    
    return {
      totalValueLocked,
      totalYearlyEarnings,
      averageAPY,
      protocolCount: protocols.size,
      topProtocols
    };
  }
  
  /**
   * Calculate total value locked across all DeFi positions
   */
  private calculateTotalDeFiValue(
    defiPositions: DeFiProtocolPosition[],
    stakingPositions: StakingPosition[]
  ): number {
    const defiValue = defiPositions.reduce((sum, pos) => {
      const value = pos.balance_usd || 0;
      return sum + (isNaN(value) ? 0 : value);
    }, 0);
    const stakingValue = stakingPositions.reduce((sum, pos) => {
      const value = pos.usdValue || 0;
      return sum + (isNaN(value) ? 0 : value);
    }, 0);
    return defiValue + stakingValue;
  }
}