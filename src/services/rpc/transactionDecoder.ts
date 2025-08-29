import { ethers } from 'ethers';
import { createLogger } from '@/utils/logger';
import { getTokenSymbol } from '../wallet/tokenInfoCache';

const logger = createLogger('transaction.decoder');

// Transaction analysis result interface
export interface DecodedTransaction {
  type: TransactionType;
  functionName?: string;
  contractName?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  amountOut?: string;
  amountMin?: string;
  recipient?: string;
  deadline?: number;
  lpToken?: string;
  vault?: string;
  params?: any;
  risk?: RiskLevel;
  tags?: string[];
}

export enum TransactionType {
  NATIVE_TRANSFER = 'NATIVE_TRANSFER',
  DEX_SWAP = 'DEX_SWAP',
  ADD_LIQUIDITY = 'ADD_LIQUIDITY',
  REMOVE_LIQUIDITY = 'REMOVE_LIQUIDITY',
  STAKE = 'STAKE',
  UNSTAKE = 'UNSTAKE',
  VAULT_DEPOSIT = 'VAULT_DEPOSIT',
  VAULT_WITHDRAW = 'VAULT_WITHDRAW',
  TOKEN_TRANSFER = 'TOKEN_TRANSFER',
  NFT_MINT = 'NFT_MINT',
  CONTRACT_CALL = 'CONTRACT_CALL',
  UNKNOWN = 'UNKNOWN'
}

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  VERY_HIGH = 'VERY_HIGH'
}

// BSC contract addresses
const CONTRACTS = {
  // PancakeSwap
  PANCAKE_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  PANCAKE_FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350C73',
  
  // Biswap
  BISWAP_ROUTER: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
  
  // Venus
  VENUS_COMPTROLLER: '0xfD36E2c2a6789Db23113685031d7F16329158384',
  
  // Common tokens
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
};

// Token symbol mapping
const TOKEN_SYMBOLS: Record<string, string> = {
  [CONTRACTS.WBNB]: 'WBNB',
  [CONTRACTS.USDT]: 'USDT',
  [CONTRACTS.USDC]: 'USDC', 
  [CONTRACTS.BUSD]: 'BUSD',
  [CONTRACTS.CAKE]: 'CAKE'
};

export class TransactionDecoder {
  private interfaces = new Map<string, ethers.Interface>();
  private contractNames = new Map<string, string>();
  private provider: ethers.Provider;

  constructor() {
    // Initialize provider for token lookups
    const rpcUrl = process.env.BSC_RPC_URL || process.env.QUICKNODE_BSC_WSS_URL?.replace('wss://', 'https://') || 'https://bsc-dataseed1.binance.org/';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.initializeABIs();
  }

  private initializeABIs() {
    // PancakeSwap Router ABI
    const pancakeRouterABI = [
      // Swap functions
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
      'function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline) external payable',
      'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
      'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
      
      // Liquidity functions
      'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable',
      'function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external',
      'function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external',
      'function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external'
    ];

    // ERC20 Token ABI
    const erc20ABI = [
      'function transfer(address to, uint256 amount) external returns (bool)',
      'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function symbol() external view returns (string)',
      'function decimals() external view returns (uint8)'
    ];

    // Venus Comptroller ABI
    const venusABI = [
      'function enterMarkets(address[] calldata vTokens) external returns (uint[] memory)',
      'function exitMarket(address vToken) external returns (uint)',
      'function claimVenus(address holder) external'
    ];

    // Register ABI interfaces
    this.interfaces.set(CONTRACTS.PANCAKE_ROUTER, new ethers.Interface(pancakeRouterABI));
    this.interfaces.set(CONTRACTS.BISWAP_ROUTER, new ethers.Interface(pancakeRouterABI));
    this.interfaces.set(CONTRACTS.VENUS_COMPTROLLER, new ethers.Interface(venusABI));
    
    // Register contract names
    this.contractNames.set(CONTRACTS.PANCAKE_ROUTER, 'PancakeSwap Router');
    this.contractNames.set(CONTRACTS.BISWAP_ROUTER, 'Biswap Router');
    this.contractNames.set(CONTRACTS.VENUS_COMPTROLLER, 'Venus Protocol');
    
    // Register ERC20 ABI for known tokens
    Object.keys(TOKEN_SYMBOLS).forEach(address => {
      this.interfaces.set(address, new ethers.Interface(erc20ABI));
    });

    logger.info('🔧 Transaction decoder initialized with ABIs for major BSC contracts');
  }

  async decodeTransaction(tx: ethers.TransactionResponse): Promise<DecodedTransaction> {
    try {
      // Native BNB transfer
      if (!tx.data || tx.data === '0x') {
        return {
          type: TransactionType.NATIVE_TRANSFER,
          amountIn: ethers.formatEther(tx.value || 0),
          tokenIn: 'BNB',
          recipient: tx.to || undefined,
          risk: RiskLevel.LOW,
          tags: ['native-transfer']
        };
      }

      // Get contract interface
      const contractInterface = this.interfaces.get(tx.to || '');
      if (!contractInterface) {
        return await this.handleUnknownContract(tx);
      }

      // Decode transaction data
      const decoded = contractInterface.parseTransaction({
        data: tx.data,
        value: tx.value
      });

      if (!decoded) {
        return { type: TransactionType.UNKNOWN };
      }

      // Analyze based on contract type and function name
      return await this.analyzeDecodedTransaction(tx, decoded);

    } catch (error) {
      logger.debug('Failed to decode transaction:', {
        hash: tx.hash,
        to: tx.to,
        error: error instanceof Error ? error.message : error
      });

      return {
        type: TransactionType.UNKNOWN,
        risk: RiskLevel.MEDIUM,
        tags: ['decode-failed']
      };
    }
  }

  private async analyzeDecodedTransaction(tx: ethers.TransactionResponse, decoded: any): Promise<DecodedTransaction> {
    const contractName = this.contractNames.get(tx.to || '') || 'Unknown Contract';
    const functionName = decoded.name;

    // DEX transaction analysis
    if (this.isDEXRouter(tx.to || undefined)) {
      return await this.analyzeDEXTransaction(tx, decoded, contractName);
    }

    // ERC20 token transaction
    if (this.isERC20Function(functionName)) {
      return await this.analyzeERC20Transaction(tx, decoded);
    }

    // DeFi protocol transaction
    if (this.isDeFiProtocol(tx.to || undefined)) {
      return await this.analyzeDeFiTransaction(tx, decoded, contractName);
    }

    // Generic contract call
    return {
      type: TransactionType.CONTRACT_CALL,
      functionName,
      contractName,
      params: this.formatParams(decoded.args),
      risk: this.assessRisk(tx, decoded),
      tags: ['contract-call']
    };
  }

  private async analyzeDEXTransaction(tx: ethers.TransactionResponse, decoded: any, contractName: string): Promise<DecodedTransaction> {
    const functionName = decoded.name;
    const args = decoded.args;

    switch (functionName) {
      case 'swapExactETHForTokens':
        return {
          type: TransactionType.DEX_SWAP,
          functionName,
          contractName,
          tokenIn: 'BNB',
          tokenOut: await getTokenSymbol(args.path[args.path.length - 1], this.provider),
          amountIn: ethers.formatEther(tx.value || 0),
          amountMin: this.formatTokenAmount(args.amountOutMin),
          recipient: args.to,
          deadline: Number(args.deadline),
          risk: this.assessSwapRisk(args.path, tx.value),
          tags: ['dex', 'swap', 'buy']
        };

      case 'swapExactTokensForETH':
        return {
          type: TransactionType.DEX_SWAP,
          functionName,
          contractName,
          tokenIn: await getTokenSymbol(args.path[0], this.provider),
          tokenOut: 'BNB',
          amountIn: this.formatTokenAmount(args.amountIn),
          amountMin: ethers.formatEther(args.amountOutMin),
          recipient: args.to,
          deadline: Number(args.deadline),
          risk: this.assessSwapRisk(args.path, args.amountIn),
          tags: ['dex', 'swap', 'sell']
        };

      case 'addLiquidityETH':
        return {
          type: TransactionType.ADD_LIQUIDITY,
          functionName,
          contractName,
          tokenIn: 'BNB',
          tokenOut: await getTokenSymbol(args.token, this.provider),
          amountIn: ethers.formatEther(tx.value || 0),
          recipient: args.to,
          deadline: Number(args.deadline),
          risk: RiskLevel.MEDIUM,
          tags: ['dex', 'liquidity', 'add-lp']
        };

      case 'removeLiquidityETH':
        return {
          type: TransactionType.REMOVE_LIQUIDITY,
          functionName,
          contractName,
          tokenIn: await getTokenSymbol(args.token, this.provider),
          tokenOut: 'BNB',
          amountIn: this.formatTokenAmount(args.liquidity),
          recipient: args.to,
          deadline: Number(args.deadline),
          risk: RiskLevel.LOW,
          tags: ['dex', 'liquidity', 'remove-lp']
        };

      default:
        return {
          type: TransactionType.CONTRACT_CALL,
          functionName,
          contractName,
          params: this.formatParams(args),
          risk: RiskLevel.MEDIUM,
          tags: ['dex', 'unknown-function']
        };
    }
  }

  private async analyzeERC20Transaction(tx: ethers.TransactionResponse, decoded: any): Promise<DecodedTransaction> {
    const functionName = decoded.name;
    const args = decoded.args;
    const tokenSymbol = await getTokenSymbol(tx.to || '', this.provider);

    switch (functionName) {
      case 'transfer':
        return {
          type: TransactionType.TOKEN_TRANSFER,
          functionName,
          tokenIn: tokenSymbol,
          amountIn: this.formatTokenAmount(args.amount),
          recipient: args.to,
          risk: RiskLevel.LOW,
          tags: ['erc20', 'transfer']
        };

      case 'approve':
        return {
          type: TransactionType.CONTRACT_CALL,
          functionName,
          tokenIn: tokenSymbol,
          amountIn: this.formatTokenAmount(args.amount),
          recipient: args.spender,
          risk: this.assessApprovalRisk(args.amount),
          tags: ['erc20', 'approval']
        };

      default:
        return {
          type: TransactionType.CONTRACT_CALL,
          functionName,
          params: this.formatParams(args),
          risk: RiskLevel.MEDIUM,
          tags: ['erc20']
        };
    }
  }

  private async analyzeDeFiTransaction(tx: ethers.TransactionResponse, decoded: any, contractName: string): Promise<DecodedTransaction> {
    const functionName = decoded.name;
    const args = decoded.args;

    // Determine DeFi operation type based on function name
    if (functionName.includes('deposit') || functionName.includes('stake')) {
      return {
        type: TransactionType.VAULT_DEPOSIT,
        functionName,
        contractName,
        amountIn: this.formatTokenAmount(args.amount || args[0]),
        risk: RiskLevel.MEDIUM,
        tags: ['defi', 'deposit', 'yield']
      };
    }

    if (functionName.includes('withdraw') || functionName.includes('unstake')) {
      return {
        type: TransactionType.VAULT_WITHDRAW,
        functionName,
        contractName,
        amountIn: this.formatTokenAmount(args.amount || args[0]),
        risk: RiskLevel.LOW,
        tags: ['defi', 'withdraw']
      };
    }

    return {
      type: TransactionType.CONTRACT_CALL,
      functionName,
      contractName,
      params: this.formatParams(args),
      risk: RiskLevel.MEDIUM,
      tags: ['defi']
    };
  }

  private async handleUnknownContract(tx: ethers.TransactionResponse): Promise<DecodedTransaction> {
    // Try to identify common function signatures even for unknown contracts
    const functionSelector = tx.data.slice(0, 10);
    const knownSelectors: Record<string, string> = {
      '0xa9059cbb': 'transfer', // ERC20 transfer
      '0x095ea7b3': 'approve',  // ERC20 approve
      '0x23b872dd': 'transferFrom', // ERC20 transferFrom
    };

    const functionName = knownSelectors[functionSelector];

    // If we recognize a standard ERC20 function, handle it gracefully
    if (functionName === 'transfer') {
      try {
        // Use a generic ERC20 interface to parse the data
        const erc20Interface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
        const decodedArgs = erc20Interface.parseTransaction({ data: tx.data });
        
        if (decodedArgs) {
          const tokenSymbol = await getTokenSymbol(tx.to || '', this.provider);
          return {
            type: TransactionType.TOKEN_TRANSFER,
            functionName: 'transfer',
            contractName: 'ERC20 Token', // More descriptive than "Unknown"
            tokenOut: tokenSymbol, // The token being transferred
            amountOut: this.formatTokenAmount(decodedArgs.args.amount),
            recipient: decodedArgs.args.to,
            risk: RiskLevel.LOW,
            tags: ['erc20', 'transfer']
          };
        }
      } catch(e) {
        logger.debug('Failed to parse a potential transfer on an unknown contract', { hash: tx.hash, error: e });
      }
    }

    // Handle approve function for unknown ERC20 tokens
    if (functionName === 'approve') {
      try {
        const erc20Interface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
        const decodedArgs = erc20Interface.parseTransaction({ data: tx.data });
        
        if (decodedArgs) {
          const tokenSymbol = await getTokenSymbol(tx.to || '', this.provider);
          return {
            type: TransactionType.CONTRACT_CALL,
            functionName: 'approve',
            contractName: 'ERC20 Token',
            tokenIn: tokenSymbol,
            amountIn: this.formatTokenAmount(decodedArgs.args.amount),
            recipient: decodedArgs.args.spender,
            risk: this.assessApprovalRisk(decodedArgs.args.amount),
            tags: ['erc20', 'approval']
          };
        }
      } catch(e) {
        logger.debug('Failed to parse a potential approve on an unknown contract', { hash: tx.hash, error: e });
      }
    }

    // Handle transferFrom function for unknown ERC20 tokens
    if (functionName === 'transferFrom') {
      try {
        const erc20Interface = new ethers.Interface(['function transferFrom(address from, address to, uint256 amount)']);
        const decodedArgs = erc20Interface.parseTransaction({ data: tx.data });
        
        if (decodedArgs) {
          const tokenSymbol = await getTokenSymbol(tx.to || '', this.provider);
          return {
            type: TransactionType.TOKEN_TRANSFER,
            functionName: 'transferFrom',
            contractName: 'ERC20 Token',
            tokenOut: tokenSymbol,
            amountOut: this.formatTokenAmount(decodedArgs.args.amount),
            recipient: decodedArgs.args.to,
            risk: RiskLevel.LOW,
            tags: ['erc20', 'transfer-from']
          };
        }
      } catch(e) {
        logger.debug('Failed to parse a potential transferFrom on an unknown contract', { hash: tx.hash, error: e });
      }
    }
    
    // Fallback for truly unknown functions or parsing errors
    return {
      type: TransactionType.UNKNOWN,
      functionName: functionName || 'unknown',
      contractName: 'Unknown Contract',
      risk: RiskLevel.HIGH,
      tags: ['unknown-contract', tx.to ? 'contract-interaction' : 'no-recipient']
    };
  }

  // Helper methods
  private isDEXRouter(address?: string): boolean {
    return address === CONTRACTS.PANCAKE_ROUTER || address === CONTRACTS.BISWAP_ROUTER;
  }

  private isERC20Function(functionName: string): boolean {
    return ['transfer', 'transferFrom', 'approve'].includes(functionName);
  }

  private isDeFiProtocol(address?: string): boolean {
    return address === CONTRACTS.VENUS_COMPTROLLER;
  }

  // Legacy method - now using dynamic token lookup via getTokenSymbol from tokenInfoCache
  // Keeping for backward compatibility but not used anymore
  private getLegacyTokenSymbol(address: string): string {
    return TOKEN_SYMBOLS[address.toLowerCase()] || `TOKEN_${address.slice(0, 6)}`;
  }

  private formatTokenAmount(amount: bigint | string): string {
    try {
      return ethers.formatEther(amount);
    } catch {
      return amount.toString();
    }
  }

  private formatParams(args: any): any {
    try {
      return JSON.parse(JSON.stringify(args, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      ));
    } catch {
      return args;
    }
  }

  private assessRisk(tx: ethers.TransactionResponse, decoded: any): RiskLevel {
    // Assess risk based on multiple factors
    let riskScore = 0;

    // Unknown contract +2
    if (!this.contractNames.has(tx.to || '')) {
      riskScore += 2;
    }

    // Large transaction +1
    if (tx.value && tx.value > ethers.parseEther('10')) {
      riskScore += 1;
    }

    // Return risk level
    if (riskScore >= 3) return RiskLevel.VERY_HIGH;
    if (riskScore >= 2) return RiskLevel.HIGH;
    if (riskScore >= 1) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  private assessSwapRisk(path: string[], amount: any): RiskLevel {
    // Check if all tokens are mainstream
    const isMainstream = path.every(token => TOKEN_SYMBOLS[token]);
    
    if (!isMainstream) return RiskLevel.HIGH;
    
    // Check transaction amount
    try {
      const value = typeof amount === 'bigint' ? amount : ethers.parseEther(amount.toString());
      if (value > ethers.parseEther('100')) return RiskLevel.MEDIUM;
    } catch {}
    
    return RiskLevel.LOW;
  }

  private assessApprovalRisk(amount: any): RiskLevel {
    try {
      // Check for unlimited approval
      const maxUint256 = ethers.MaxUint256;
      if (amount >= maxUint256) return RiskLevel.HIGH;
      
      return RiskLevel.MEDIUM;
    } catch {
      return RiskLevel.MEDIUM;
    }
  }

  // Add new contract ABI
  addContractABI(address: string, abi: string[], name?: string) {
    this.interfaces.set(address, new ethers.Interface(abi));
    if (name) {
      this.contractNames.set(address, name);
    }
    logger.info(`Added ABI for contract: ${name || address}`);
  }

  // Get supported contracts list
  getSupportedContracts(): Array<{address: string, name: string}> {
    return Array.from(this.contractNames.entries()).map(([address, name]) => ({
      address,
      name
    }));
  }
}