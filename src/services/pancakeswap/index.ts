import { ethers, Contract, parseUnits, formatUnits } from 'ethers';
import { Context } from 'telegraf';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pancakeswap');

// PancakeSwap V2 Router ABI (minimal)
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

// ERC20 ABI (minimal)
const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

// BSC Constants
const BSC_RPC = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/';
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    balance?: string;
    price?: number;
}

export interface TradeQuote {
    amountIn: string;
    amountOut: string;
    priceImpact: number;
    minimumReceived: string;
    path: string[];
}

export class PancakeSwapTrader {
    private provider: ethers.JsonRpcProvider;
    private router: Contract;

    constructor() {
        this.provider = new ethers.JsonRpcProvider(BSC_RPC);
        this.router = new Contract(PANCAKESWAP_ROUTER, ROUTER_ABI, this.provider);
    }

    // Get token information
    async getTokenInfo(tokenAddress: string): Promise<TokenInfo | null> {
        try {
            const contract = new Contract(tokenAddress, ERC20_ABI, this.provider);

            const [name, symbol, decimals] = await Promise.all([
                contract.name(),
                contract.symbol(),
                contract.decimals()
            ]);

            return {
                address: tokenAddress,
                name,
                symbol,
                decimals: Number(decimals)
            };
        } catch (error) {
            logger.error('Error getting token info', error);
            return null;
        }
    }

    // Get token balance for a wallet
    async getTokenBalance(tokenAddress: string, walletAddress: string): Promise<string> {
        try {
            if (tokenAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase()) {
                const balance = await this.provider.getBalance(walletAddress);
                return formatUnits(balance, 18);
            } else {
                const contract = new Contract(tokenAddress, ERC20_ABI, this.provider);
                const balance = await contract.balanceOf(walletAddress);
                const decimals = await contract.decimals();
                return formatUnits(balance, decimals);
            }
        } catch (error) {
            logger.error('Error getting token balance', error);
            return '0';
        }
    }

    // Get quote for trading
    async getTradeQuote(
        tokenIn: string,
        tokenOut: string,
        amountIn: string,
        decimalsIn: number
    ): Promise<TradeQuote | null> {
        try {
            const path = tokenIn.toLowerCase() === WBNB_ADDRESS.toLowerCase() ||
                tokenOut.toLowerCase() === WBNB_ADDRESS.toLowerCase()
                ? [tokenIn, tokenOut]
                : [tokenIn, WBNB_ADDRESS, tokenOut];

            const amountInWei = parseUnits(amountIn, decimalsIn);
            const amounts = await this.router.getAmountsOut(amountInWei, path);

            const amountOut = amounts[amounts.length - 1];
            const minimumReceived = (amountOut * BigInt(95)) / BigInt(100); // 5% slippage

            return {
                amountIn,
                amountOut: formatUnits(amountOut, 18), // Assuming output is in BNB/WBNB
                priceImpact: 0, // Would need more complex calculation
                minimumReceived: formatUnits(minimumReceived, 18),
                path
            };
        } catch (error) {
            logger.error('Error getting trade quote', error);
            return null;
        }
    }

    // Validate token address
    isValidTokenAddress(address: string): boolean {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }
}

// Format number for display
export function formatNumber(num: number | string, decimals: number = 6): string {
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (n === 0) return '0';
    if (n < 0.000001) return '< 0.000001';
    if (n < 1) return n.toFixed(decimals);
    if (n < 1000) return n.toFixed(4);
    if (n < 1000000) return (n / 1000).toFixed(2) + 'K';
    return (n / 1000000).toFixed(2) + 'M';
}