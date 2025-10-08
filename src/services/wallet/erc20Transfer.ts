import { ethers } from 'ethers';
import { createLogger } from '@/utils/logger';
import { TokenInfo } from '@/config/commonTokens';

const logger = createLogger('wallet.erc20');

/**
 * Standard ERC20 ABI for token operations
 */
export const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function'
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    type: 'function'
  }
] as const;

/**
 * Get ERC20 token balance for an address
 */
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string,
  provider: ethers.JsonRpcProvider
): Promise<string> {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);
    const decimals = await contract.decimals();
    return ethers.formatUnits(balance, decimals);
  } catch (error) {
    logger.error('Error getting token balance', { tokenAddress, walletAddress, error });
    throw error;
  }
}

/**
 * Get token metadata (symbol, name, decimals)
 */
export async function getTokenMetadata(
  tokenAddress: string,
  provider: ethers.JsonRpcProvider
): Promise<{ symbol: string; name: string; decimals: number }> {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    const [symbol, name, decimals] = await Promise.all([
      contract.symbol(),
      contract.name(),
      contract.decimals()
    ]);

    return {
      symbol: symbol as string,
      name: name as string,
      decimals: Number(decimals)
    };
  } catch (error) {
    logger.error('Error getting token metadata', { tokenAddress, error });
    throw error;
  }
}

/**
 * Encode ERC20 transfer data for transaction
 */
export function encodeTransferData(to: string, amount: string, decimals: number): string {
  const iface = new ethers.Interface(ERC20_ABI);
  const amountInWei = ethers.parseUnits(amount, decimals);
  return iface.encodeFunctionData('transfer', [to, amountInWei]);
}

/**
 * Format token balance for display
 */
export function formatTokenBalance(balance: string, maxDecimals: number = 6): string {
  const num = parseFloat(balance);

  if (num === 0) return '0';
  if (num < 0.000001) return '< 0.000001';

  // For small numbers, show more decimals
  if (num < 1) {
    return num.toFixed(maxDecimals);
  }

  // For larger numbers, show fewer decimals
  if (num > 1000) {
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Validate token address format
 */
export function isValidTokenAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Get token balances for multiple wallets
 */
export async function getMultipleTokenBalances(
  tokenAddress: string,
  walletAddresses: string[],
  provider: ethers.JsonRpcProvider
): Promise<Record<string, string>> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = await contract.decimals();

  const balances: Record<string, string> = {};

  await Promise.all(
    walletAddresses.map(async (address) => {
      try {
        const balance = await contract.balanceOf(address);
        balances[address] = ethers.formatUnits(balance, decimals);
      } catch (error) {
        logger.warn('Error fetching balance for address', { address, tokenAddress, error });
        balances[address] = '0';
      }
    })
  );

  return balances;
}

/**
 * Execute ERC20 transfer from trading wallet
 */
export async function executeERC20Transfer(
  tokenAddress: string,
  to: string,
  amount: string,
  decimals: number,
  wallet: ethers.Wallet
): Promise<ethers.TransactionResponse> {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const amountInWei = ethers.parseUnits(amount, decimals);

    logger.info('Executing ERC20 transfer', { tokenAddress, to, amount, decimals });

    const tx = await contract.transfer(to, amountInWei);
    return tx;
  } catch (error) {
    logger.error('Error executing ERC20 transfer', { tokenAddress, to, amount, error });
    throw error;
  }
}
