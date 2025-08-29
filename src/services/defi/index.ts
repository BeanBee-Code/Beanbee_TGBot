import axios from 'axios';
import { createLogger } from '@/utils/logger';

const logger = createLogger('defi');

export interface DeFiToken {
  token_type: 'supplied' | 'reward' | 'debt';
  name: string;
  symbol: string;
  contract_address: string;
  decimals: string;
  logo?: string;
  thumbnail?: string;
  balance: string;
  balance_formatted: string;
  usd_price?: number;
  usd_value?: number;
}

export interface DeFiPosition {
  label: string;
  balance_usd: number;
  total_unclaimed_usd_value?: number;
  tokens: DeFiToken[];
}

export interface DeFiProtocol {
  protocol_name: string;
  protocol_id: string;
  protocol_url?: string;
  protocol_logo?: string;
  account_data?: any;
  total_projected_earnings_usd?: {
    daily?: number | null;
    weekly?: number | null;
    monthly?: number | null;
    yearly?: number | null;
  };
  position: DeFiPosition;
}

export async function getDeFiPositions(walletAddress: string): Promise<DeFiProtocol[]> {
  try {
    const response = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/wallets/${walletAddress}/defi/positions`,
      {
        params: {
          chain: 'bsc'
        },
        headers: {
          'accept': 'application/json',
          'X-API-Key': process.env.MORALIS_API_KEY!
        }
      }
    );

    return response.data || [];
  } catch (error: any) {
    logger.error('Error fetching DeFi positions', { 
      error: error.response?.data || error.message,
      address: walletAddress,
      chain: 'bsc' 
    });
    
    // If it's a 404 or positions not found, return empty array
    if (error.response?.status === 404) {
      return [];
    }
    
    // For other errors, throw
    throw error;
  }
}

export function formatDeFiPositions(positions: DeFiProtocol[]): string {
  // This function is now deprecated as DeFi positions are integrated into the unified DeFi section
  // Keeping it for backwards compatibility but returning empty string
  return '';
}