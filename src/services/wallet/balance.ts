import { ethers } from 'ethers';
import Moralis from 'moralis';
import { createLogger } from '../../utils/logger';

const logger = createLogger('wallet.balance');

const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

/**
 * Get BNB balance for a wallet address
 */
export async function getBNBBalance(address: string): Promise<string> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
    const balance = await provider.getBalance(address);
    
    // Convert from wei to BNB with 4 decimal places
    return ethers.formatEther(balance);
  } catch (error) {
    logger.error('Error fetching BNB balance', { address, error });
    return '0';
  }
}

/**
 * Get BNB balances for multiple addresses
 */
export async function getMultipleBNBBalances(addresses: string[]): Promise<{ [address: string]: string }> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  const balances: { [address: string]: string } = {};
  
  try {
    // Fetch all balances in parallel
    const balancePromises = addresses.map(async (address) => {
      try {
        const balance = await provider.getBalance(address);
        return { address, balance: ethers.formatEther(balance) };
      } catch (error) {
        logger.error('Error fetching balance for address', { address, error });
        return { address, balance: '0' };
      }
    });
    
    const results = await Promise.all(balancePromises);
    
    // Convert to object
    results.forEach(({ address, balance }) => {
      balances[address] = balance;
    });
    
    return balances;
  } catch (error) {
    logger.error('Error fetching multiple balances', { addressCount: addresses.length, error });
    // Return zeros for all addresses
    addresses.forEach(address => {
      balances[address] = '0';
    });
    return balances;
  }
}

/**
 * Format BNB balance for display
 */
export function formatBNBBalance(balance: string, decimals: number = 4): string {
  const num = parseFloat(balance);
  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';
  return num.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Get BNB price in USD
 */
export async function getBNBPrice(): Promise<number> {
  try {
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: "0x38", // BSC
      address: WBNB_ADDRESS
    });
    return response.result.usdPrice;
  } catch (error) {
    logger.error('Error fetching BNB price', { 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : error,
      apiKey: process.env.MORALIS_API_KEY ? 'Present' : 'Missing'
    });
    return 0;
  }
}

/**
 * Convert regular digit string to Unicode subscript characters
 */
function toSubscript(numberString: string): string {
  const subscriptDigits: { [key: string]: string } = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'
  };
  return numberString.split('').map(digit => subscriptDigits[digit] || '').join('');
}

/**
 * Format USD value with subscript notation for very small values
 */
export function formatUSDValueWithSubscript(value: number): string {
  if (value === 0) return '$0.00';

  // Handle large numbers
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;

  // Handle standard numbers
  if (value >= 0.01) return `$${value.toFixed(2)}`;

  // Handle very small numbers with subscript notation
  if (value > 0) {
    // Calculate the number of leading zeros after decimal point
    // e.g., 0.00007482 -> Math.log10(value) ≈ -4.12 -> leading zeros = 4
    const leadingZeros = -Math.floor(Math.log10(value) + 1);

    // Use subscript format for 3 or more leading zeros
    if (leadingZeros >= 3) {
      const subscript = toSubscript(leadingZeros.toString());
      // Extract significant digits (usually 3-4 digits)
      const significantDigits = Math.round(value * Math.pow(10, leadingZeros + 3));
      const digitsStr = significantDigits.toString().padStart(4, '0').substring(0, 4);
      return `$0.0${subscript} ${digitsStr}`;
    } else {
      // For numbers like 0.00123, show enough decimal places
      return `$${value.toFixed(8).replace(/\.?0+$/, '')}`;
    }
  }

  return '$0.00';
}

/**
 * Format USD value for display (enhanced version)
 */
export function formatUSDValue(value: number): string {
  if (value === 0) return '$0.00';

  // Handle large numbers with K/M notation
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;

  // Handle standard numbers
  if (value >= 0.01) return `$${value.toFixed(2)}`;

  // For very small numbers, show significant digits instead of '<$0.01'
  if (value > 0) {
    // Show up to 8 decimal places but remove trailing zeros
    const formatted = value.toFixed(8).replace(/\.?0+$/, '');
    return `$${formatted}`;
  }

  return '$0.00';
}