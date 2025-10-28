// src/services/hapiLabs/index.ts
import axios from 'axios';
import { createLogger } from '@/utils/logger';
import { SCSecurityCache } from '@/database/models/SCSecurityCache';

const logger = createLogger('hapiLabs');

/**
 * HAPI Labs smart contract security check result
 */
export interface HapiSecurityCheck {
  name: string;
  value: string;
  impact: string;
  severityChanges: any[];
  description: string;
}

/**
 * Contract token security data from HAPI Labs
 */
export interface HapiContractSecurity {
  vulnerable_withdrawal: HapiSecurityCheck;
  reentrancy_risk: HapiSecurityCheck;
  locks: HapiSecurityCheck;
  opensource: HapiSecurityCheck;
  mintable: HapiSecurityCheck;
  pausable: HapiSecurityCheck;
  upgradable: HapiSecurityCheck;
  blacklisting: HapiSecurityCheck;
  transfer_fees: HapiSecurityCheck;
  transfer_limits: HapiSecurityCheck;
  approval_vulnerability: HapiSecurityCheck;
  owner_can_abuse_approvals: HapiSecurityCheck;
  interface_error: HapiSecurityCheck;
  blocking_loops: HapiSecurityCheck;
  centralized_balance: HapiSecurityCheck;
  transfer_cooldown: HapiSecurityCheck;
  approval_restriction: HapiSecurityCheck;
  external_calls: HapiSecurityCheck;
  airdrop_specific_code: HapiSecurityCheck;
  vulnerable_ownership: HapiSecurityCheck;
  retrievable_ownership: HapiSecurityCheck;
  mixer_utilized: HapiSecurityCheck;
  adjustable_maximum_supply: HapiSecurityCheck;
  owner_scams: HapiSecurityCheck;
  recent_interaction_was_within_30_days: HapiSecurityCheck;
  native_token_drainage: HapiSecurityCheck;
}

/**
 * HAPI Labs API response structure
 */
export interface HapiSCResponse {
  errorCode: number;
  errorDescription: string;
  data: {
    public_name: string;
    contract_token_security: HapiContractSecurity;
  };
  requests_left: number;
}

/**
 * Categorized security issues for easier analysis
 */
export interface SecurityIssues {
  critical: string[];
  high: string[];
  medium: string[];
  low: string[];
  informational: string[];
}

/**
 * Processed security analysis result
 */
export interface SCSecurityAnalysis {
  hasData: boolean;
  publicName?: string;
  securityIssues: SecurityIssues;
  positiveFeatures: string[];
  riskLevel: 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  securityScore: number; // 0-15 points for safety score integration
  rawData?: HapiContractSecurity;
  requestsLeft?: number;
  cachedAt?: Date;
}

/**
 * HAPI Labs smart contract screening service
 */
export class HapiLabsService {
  private apiKey: string;
  private apiUrl: string;
  private cacheEnabled: boolean;
  private cacheDurationMs: number;

  constructor() {
    this.apiKey = process.env.HAPI_LABS_API_KEY || '';
    this.apiUrl = process.env.HAPI_LABS_API_URL || 'https://research.hapilabs.one';
    this.cacheEnabled = true;
    this.cacheDurationMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    if (!this.apiKey) {
      logger.warn('HAPI_LABS_API_KEY not configured, SC screening will be disabled');
    }
  }

  /**
   * Check if HAPI Labs service is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Get smart contract security analysis for a token
   * @param tokenAddress Token contract address
   * @param chain Blockchain (default: bsc)
   */
  async getContractSecurity(tokenAddress: string, chain: string = 'bsc'): Promise<SCSecurityAnalysis> {
    if (!this.isAvailable()) {
      logger.warn('HAPI Labs API key not configured, skipping SC screening');
      return this.getEmptyAnalysis();
    }

    try {
      // Check cache first
      if (this.cacheEnabled) {
        const cached = await this.getCachedSecurity(tokenAddress, chain);
        if (cached) {
          logger.info('Using cached SC security data', { tokenAddress, chain });
          return cached;
        }
      }

      // Fetch from API
      logger.info('Fetching SC security from HAPI Labs', { tokenAddress, chain });
      const response = await axios.get<HapiSCResponse>(
        `${this.apiUrl}/v2/checksc/${chain}/${tokenAddress}`,
        {
          headers: {
            'HAPI-Token': this.apiKey
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (response.data.errorCode !== 0) {
        logger.error('HAPI Labs API error', {
          tokenAddress,
          errorCode: response.data.errorCode,
          errorDescription: response.data.errorDescription
        });
        return this.getEmptyAnalysis();
      }

      // Process the security data
      const analysis = this.processSecurity(response.data);

      // Cache the result
      if (this.cacheEnabled) {
        await this.cacheSecurity(tokenAddress, chain, analysis);
      }

      logger.info('SC security analysis completed', {
        tokenAddress,
        riskLevel: analysis.riskLevel,
        securityScore: analysis.securityScore,
        requestsLeft: response.data.requests_left
      });

      return analysis;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          logger.error('HAPI Labs rate limit exceeded', { tokenAddress });
        } else if (error.response?.status === 401) {
          logger.error('HAPI Labs authentication failed - check API key', { tokenAddress });
        } else {
          logger.error('HAPI Labs API request failed', {
            tokenAddress,
            status: error.response?.status,
            message: error.message
          });
        }
      } else {
        logger.error('Error fetching SC security', {
          tokenAddress,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return this.getEmptyAnalysis();
    }
  }

  /**
   * Process raw HAPI Labs data into categorized security analysis
   */
  private processSecurity(data: HapiSCResponse): SCSecurityAnalysis {
    const securityIssues: SecurityIssues = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      informational: []
    };

    const positiveFeatures: string[] = [];
    const security = data.data.contract_token_security;

    // Define risk categorization based on security check
    const criticalChecks = [
      'vulnerable_withdrawal',
      'reentrancy_risk',
      'approval_vulnerability',
      'owner_can_abuse_approvals',
      'vulnerable_ownership',
      'native_token_drainage',
      'owner_scams'
    ];

    const highRiskChecks = [
      'upgradable',
      'blacklisting',
      'mintable',
      'pausable',
      'mixer_utilized',
      'adjustable_maximum_supply',
      'retrievable_ownership'
    ];

    const mediumRiskChecks = [
      'transfer_fees',
      'transfer_limits',
      'transfer_cooldown',
      'centralized_balance',
      'approval_restriction',
      'locks'
    ];

    const lowRiskChecks = [
      'blocking_loops',
      'interface_error',
      'external_calls',
      'airdrop_specific_code'
    ];

    // Process each security check
    Object.entries(security).forEach(([key, check]) => {
      const isNegative = check.value === 'Yes' && check.impact !== 'Informational';
      const isPositive = check.value === 'No' && check.impact !== 'Informational';

      // Categorize based on risk level
      if (criticalChecks.includes(key)) {
        if (isNegative) {
          securityIssues.critical.push(`${check.name}: ${check.description}`);
        } else if (isPositive) {
          positiveFeatures.push(`✓ ${check.name}`);
        }
      } else if (highRiskChecks.includes(key)) {
        if (isNegative) {
          securityIssues.high.push(`${check.name}: ${check.description}`);
        } else if (isPositive) {
          positiveFeatures.push(`✓ ${check.name}`);
        }
      } else if (mediumRiskChecks.includes(key)) {
        if (isNegative) {
          securityIssues.medium.push(`${check.name}: ${check.description}`);
        } else if (isPositive) {
          positiveFeatures.push(`✓ ${check.name}`);
        }
      } else if (lowRiskChecks.includes(key)) {
        if (isNegative) {
          securityIssues.low.push(`${check.name}: ${check.description}`);
        }
      } else {
        // Informational checks
        if (key === 'opensource' && check.value === 'Yes') {
          positiveFeatures.push('✓ Open Source (Verified)');
        }
        if (key === 'recent_interaction_was_within_30_days' && check.value === 'Yes') {
          positiveFeatures.push('✓ Recently Active');
        }
      }
    });

    // Calculate risk level
    let riskLevel: 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'SAFE';
    if (securityIssues.critical.length > 0) {
      riskLevel = 'CRITICAL';
    } else if (securityIssues.high.length >= 3) {
      riskLevel = 'CRITICAL';
    } else if (securityIssues.high.length > 0) {
      riskLevel = 'HIGH';
    } else if (securityIssues.medium.length >= 3) {
      riskLevel = 'HIGH';
    } else if (securityIssues.medium.length > 0) {
      riskLevel = 'MEDIUM';
    } else if (securityIssues.low.length > 0) {
      riskLevel = 'LOW';
    }

    // Calculate security score (0-15 points)
    let securityScore = 15; // Start with max score

    // Deduct points based on issues
    securityScore -= securityIssues.critical.length * 15; // Critical = all points lost
    securityScore -= securityIssues.high.length * 5;
    securityScore -= securityIssues.medium.length * 2;
    securityScore -= securityIssues.low.length * 1;

    // Ensure score is within bounds
    securityScore = Math.max(0, Math.min(15, securityScore));

    return {
      hasData: true,
      publicName: data.data.public_name,
      securityIssues,
      positiveFeatures,
      riskLevel,
      securityScore,
      rawData: security,
      requestsLeft: data.requests_left,
      cachedAt: new Date()
    };
  }

  /**
   * Get cached security data
   */
  private async getCachedSecurity(tokenAddress: string, chain: string): Promise<SCSecurityAnalysis | null> {
    try {
      const cached = await SCSecurityCache.findOne({
        contractAddress: tokenAddress.toLowerCase(),
        chain: chain.toLowerCase(),
        cachedAt: { $gte: new Date(Date.now() - this.cacheDurationMs) }
      });

      if (cached && cached.securityData) {
        return {
          ...cached.securityData,
          cachedAt: cached.cachedAt
        } as SCSecurityAnalysis;
      }

      return null;
    } catch (error) {
      logger.error('Error reading SC security cache', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Cache security data
   */
  private async cacheSecurity(tokenAddress: string, chain: string, analysis: SCSecurityAnalysis): Promise<void> {
    try {
      await SCSecurityCache.findOneAndUpdate(
        {
          contractAddress: tokenAddress.toLowerCase(),
          chain: chain.toLowerCase()
        },
        {
          contractAddress: tokenAddress.toLowerCase(),
          chain: chain.toLowerCase(),
          securityData: analysis,
          cachedAt: new Date()
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      logger.error('Error caching SC security data', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get empty analysis (when API is unavailable or fails)
   */
  private getEmptyAnalysis(): SCSecurityAnalysis {
    return {
      hasData: false,
      securityIssues: {
        critical: [],
        high: [],
        medium: [],
        low: [],
        informational: []
      },
      positiveFeatures: [],
      riskLevel: 'SAFE',
      securityScore: 0 // Neutral - don't affect score if data unavailable
    };
  }
}

// Export singleton instance
export const hapiLabsService = new HapiLabsService();
