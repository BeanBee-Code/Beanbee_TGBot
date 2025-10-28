// src/services/hapiLabs/addressRisk.ts
import axios from 'axios';
import { createLogger } from '@/utils/logger';
import { AddressRiskCache } from '@/database/models/AddressRiskCache';

const logger = createLogger('hapiLabs.addressRisk');

/**
 * HAPI Labs address risk assessment result
 */
export interface AddressRiskResult {
  address: string;
  network: string;
  risk: number; // 0-10 scale
  category: string; // "Theft", "Scam", "Phishing", "Clean", etc.
  scamfari: boolean;
  riskDescriptionHeader: string;
  riskDescription: string;
  isSafe: boolean; // risk <= 3
  isModerate: boolean; // risk 4-6
  isRisky: boolean; // risk >= 7
  riskLevel: 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  hasData: boolean;
  cachedAt?: Date;
  requestsLeft?: number;
}

/**
 * HAPI Labs API response structure for address risk
 */
interface HapiAddressRiskResponse {
  errorCode: number;
  errorDescription: string;
  data: {
    risk: number;
    category: string;
    scamfari: boolean;
    riskDescriptionHeader: string;
    riskDescription: string;
  };
  requests_left: number;
}

/**
 * HAPI Labs address risk checking service
 */
export class HapiAddressRiskService {
  private apiKey: string;
  private apiUrl: string;
  private cacheEnabled: boolean;
  private cacheDurationMs: number;

  constructor() {
    this.apiKey = process.env.HAPI_LABS_API_KEY || '';
    this.apiUrl = process.env.HAPI_LABS_API_URL || 'https://research.hapilabs.one';
    this.cacheEnabled = true;
    this.cacheDurationMs = 24 * 60 * 60 * 1000; // 24 hours

    if (!this.apiKey) {
      logger.warn('HAPI_LABS_API_KEY not configured, address risk checking will be disabled');
    }
  }

  /**
   * Check if HAPI Labs service is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Get address risk assessment
   * @param address Wallet address to check
   * @param network Blockchain network (optional, BSC by default for EVM)
   */
  async checkAddressRisk(address: string, network: string = 'bsc'): Promise<AddressRiskResult> {
    if (!this.isAvailable()) {
      logger.warn('HAPI Labs API key not configured, skipping address risk check');
      return this.getEmptyResult(address, network);
    }

    try {
      // Check cache first
      if (this.cacheEnabled) {
        const cached = await this.getCachedRisk(address, network);
        if (cached) {
          logger.info('Using cached address risk data', { address, network });
          return cached;
        }
      }

      // Fetch from API
      logger.info('Fetching address risk from HAPI Labs', { address, network });
      const response = await axios.post<HapiAddressRiskResponse>(
        `${this.apiUrl}/v2/checkrisk`,
        {
          address,
          network
        },
        {
          headers: {
            'HAPI-Token': this.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (response.data.errorCode !== 0) {
        logger.error('HAPI Labs API error', {
          address,
          errorCode: response.data.errorCode,
          errorDescription: response.data.errorDescription
        });
        return this.getEmptyResult(address, network);
      }

      // Process the risk data
      const result = this.processRiskData(address, network, response.data);

      // Cache the result
      if (this.cacheEnabled) {
        await this.cacheRisk(address, network, result);
      }

      logger.info('Address risk check completed', {
        address,
        risk: result.risk,
        riskLevel: result.riskLevel,
        category: result.category,
        requestsLeft: response.data.requests_left
      });

      return result;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          logger.error('HAPI Labs rate limit exceeded', { address });
        } else if (error.response?.status === 401) {
          logger.error('HAPI Labs authentication failed - check API key', { address });
        } else {
          logger.error('HAPI Labs API request failed', {
            address,
            status: error.response?.status,
            message: error.message
          });
        }
      } else {
        logger.error('Error checking address risk', {
          address,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return this.getEmptyResult(address, network);
    }
  }

  /**
   * Process raw HAPI Labs risk data into structured result
   */
  private processRiskData(
    address: string,
    network: string,
    data: HapiAddressRiskResponse
  ): AddressRiskResult {
    const risk = data.data.risk;

    // Determine risk classifications
    const isSafe = risk <= 3;
    const isModerate = risk >= 4 && risk <= 6;
    const isRisky = risk >= 7;

    // Determine risk level
    let riskLevel: 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    if (risk === 0) {
      riskLevel = 'SAFE';
    } else if (risk <= 3) {
      riskLevel = 'LOW';
    } else if (risk <= 6) {
      riskLevel = 'MEDIUM';
    } else if (risk <= 8) {
      riskLevel = 'HIGH';
    } else {
      riskLevel = 'CRITICAL';
    }

    return {
      address,
      network,
      risk,
      category: data.data.category || 'Unknown',
      scamfari: data.data.scamfari,
      riskDescriptionHeader: data.data.riskDescriptionHeader,
      riskDescription: data.data.riskDescription,
      isSafe,
      isModerate,
      isRisky,
      riskLevel,
      hasData: true,
      requestsLeft: data.requests_left,
      cachedAt: new Date()
    };
  }

  /**
   * Get cached address risk data
   */
  private async getCachedRisk(address: string, network: string): Promise<AddressRiskResult | null> {
    try {
      const cached = await AddressRiskCache.findOne({
        address: address.toLowerCase(),
        network: network.toLowerCase(),
        cachedAt: { $gte: new Date(Date.now() - this.cacheDurationMs) }
      });

      if (cached && cached.riskData) {
        return {
          ...cached.riskData,
          cachedAt: cached.cachedAt
        } as AddressRiskResult;
      }

      return null;
    } catch (error) {
      logger.error('Error reading address risk cache', {
        address,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Cache address risk data
   */
  private async cacheRisk(address: string, network: string, result: AddressRiskResult): Promise<void> {
    try {
      await AddressRiskCache.findOneAndUpdate(
        {
          address: address.toLowerCase(),
          network: network.toLowerCase()
        },
        {
          address: address.toLowerCase(),
          network: network.toLowerCase(),
          riskData: result,
          cachedAt: new Date()
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      logger.error('Error caching address risk data', {
        address,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get empty result when API is unavailable or fails
   */
  private getEmptyResult(address: string, network: string): AddressRiskResult {
    return {
      address,
      network,
      risk: 0,
      category: 'Unknown',
      scamfari: false,
      riskDescriptionHeader: 'Risk data unavailable',
      riskDescription: 'Address risk screening is currently unavailable',
      isSafe: true,
      isModerate: false,
      isRisky: false,
      riskLevel: 'SAFE',
      hasData: false
    };
  }

  /**
   * Get risk emoji based on risk level
   */
  getRiskEmoji(riskLevel: string): string {
    switch (riskLevel) {
      case 'SAFE': return '✅';
      case 'LOW': return '🟢';
      case 'MEDIUM': return '🟡';
      case 'HIGH': return '🟠';
      case 'CRITICAL': return '🔴';
      default: return '⚪';
    }
  }

  /**
   * Get compact risk display for lists
   */
  getCompactDisplay(result: AddressRiskResult): string {
    if (!result.hasData) {
      return '';
    }

    const emoji = this.getRiskEmoji(result.riskLevel);

    if (result.risk === 0) {
      return `${emoji} Safe`;
    }

    if (result.risk >= 7) {
      return `${emoji} ${result.riskLevel} (${result.risk}/10 - ${result.category})`;
    }

    return `${emoji} ${result.riskLevel} (${result.risk}/10)`;
  }
}

// Export singleton instance
export const hapiAddressRiskService = new HapiAddressRiskService();
