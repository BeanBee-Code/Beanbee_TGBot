import { createPublicClient, createWalletClient, http, PrivateKeyAccount } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SmartRouter, SMART_ROUTER_ADDRESSES, SwapRouter } from '@pancakeswap/smart-router';
import { Currency, CurrencyAmount, Percent, Token, TradeType, Native } from '@pancakeswap/sdk';
import { ChainId } from '@pancakeswap/chains';
import { bscTokens } from '@pancakeswap/tokens';
import { ethers } from 'ethers';

import { UserService } from '../user';
import { decryptPrivateKey } from '../wallet/tradingWallet';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pancakeswap.executor');

const CHAIN_ID = ChainId.BSC;
const RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/';

// Gas optimization configuration
const GAS_BUFFER_PERCENTAGE = parseInt(process.env.GAS_BUFFER_PERCENTAGE || '20'); // Default 20% buffer
const GAS_PRICE_MULTIPLIER = parseFloat(process.env.GAS_PRICE_MULTIPLIER || '1.1'); // Default 10% gas price increase
const MIN_GAS_PRICE_GWEI = parseInt(process.env.MIN_GAS_PRICE_GWEI || '3'); // Minimum 3 Gwei

// Viem clients
const publicClient = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL),
  batch: { multicall: { batchSize: 1024 * 200 } },
});

// Use public subgraph URLs
const V3_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v3-bsc';
const V2_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/pancakeswap/pairs';

// Quote provider
const quoteProvider = SmartRouter.createQuoteProvider({ onChainProvider: () => publicClient });

// ABI in correct JSON format
const ERC20_ABI = [
  {"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"remaining","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},
  {"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"success","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"},
  {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"payable":false,"stateMutability":"view","type":"function"},
  {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},
  {"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},
] as const;

export interface V3SwapParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  slippage?: number;
}

// Legacy interface for backward compatibility
export interface SwapParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  slippage?: number;
}


export class PancakeSwapExecutor {

  /**
   * Get best trade route using Smart Router SDK
   */
  public async getBestTrade(params: V3SwapParams): Promise<any> {
    try {
      const { tokenInAddress, tokenOutAddress, amountIn } = params;

      // 1. Define input and output tokens
      const tokenIn = await this.getToken(tokenInAddress);
      const tokenOut = await this.getToken(tokenOutAddress);
      if (!tokenIn || !tokenOut) throw new Error('Invalid token address provided');

      logger.info(`Getting best trade for: ${amountIn} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

      const [v2Pools, v3Pools] = await Promise.all([
        SmartRouter.getV2CandidatePools({
          onChainProvider: () => publicClient,
          currencyA: tokenIn,
          currencyB: tokenOut,
        }),
        SmartRouter.getV3CandidatePools({
          onChainProvider: () => publicClient,
          currencyA: tokenIn,
          currencyB: tokenOut,
        }),
      ]);
      const pools = [...v2Pools, ...v3Pools];
      logger.info(`Found ${pools.length} candidate pools.`);

      if (pools.length === 0) {
        throw new Error('No liquidity pools found for this pair. The token may not be tradable.');
      }

      // 3. Define input amount
      const amount = CurrencyAmount.fromRawAmount(
        tokenIn, 
        BigInt(ethers.parseUnits(amountIn, tokenIn.decimals).toString())
      );

      // 4. Calculate best trade route
      const trade = await SmartRouter.getBestTrade(amount, tokenOut, TradeType.EXACT_INPUT, {
        gasPriceWei: () => publicClient.getGasPrice(),
        maxHops: 3,
        maxSplits: 2,
        poolProvider: SmartRouter.createStaticPoolProvider(pools),
        quoteProvider,
        quoterOptimization: true,
      });
      
      if (!trade) {
        throw new Error('Could not find a valid trade route.');
      }

      logger.info(`Best trade found: ${trade.inputAmount.toExact()} ${tokenIn.symbol} for ${trade.outputAmount.toExact()} ${tokenOut.symbol}`);
      return trade;

    } catch (error) {
      logger.error('Failed to get best trade', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Execute V3 swap using Smart Router SDK
   */
  public async executeV3Swap(userId: number, params: V3SwapParams): Promise<{ 
    success: boolean; 
    txHash?: string; 
    error?: string;
    tokensReceived?: string;
  }> {
    try {
      logger.info('Executing V3 Swap with Smart Router SDK', { userId, params });
      
      const walletData = await UserService.getTradingWalletData(userId);
      if (!walletData) {
        return { success: false, error: 'Trading wallet not found' };
      }

      const privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, walletData.iv);
      const account = privateKeyToAccount(`0x${privateKey.startsWith('0x') ? privateKey.substring(2) : privateKey}` as `0x${string}`);
      
      const walletClient = createWalletClient({
          account,
          chain: bsc,
          transport: http(RPC_URL),
      });

      // 1. Get best trade
      const trade = await this.getBestTrade(params);

      // Extract the expected output amount for the success message
      const expectedOutputAmount = trade.outputAmount.toExact();

      // 2. Check token approval
      if (trade.inputAmount.currency.isToken) {
          await this.ensureTokenApprovalSDK(walletClient, account, trade.inputAmount);
      }
      
      const routerAddress = SMART_ROUTER_ADDRESSES[CHAIN_ID] as `0x${string}`;
      const slippageTolerance = new Percent(BigInt(Math.floor((params.slippage || 1) * 100)), BigInt(10000));

      const { value, calldata } = SwapRouter.swapCallParameters(trade, {
        recipient: account.address,
        slippageTolerance,
      });

      const tx = {
        account: account,
        to: routerAddress,
        data: calldata as `0x${string}`,
        value: BigInt(value),
      };

      // Apply smart gas strategy for better success rates
      const gasEstimate = await publicClient.estimateGas(tx);
      const baseGasPrice = await publicClient.getGasPrice();
      
      // Add gas buffer to handle volatile token transactions
      const gasWithBuffer = (gasEstimate * BigInt(100 + GAS_BUFFER_PERCENTAGE)) / BigInt(100);
      
      // Increase gas price for competitive execution
      const enhancedGasPrice = BigInt(Math.floor(Number(baseGasPrice) * GAS_PRICE_MULTIPLIER));
      const minGasPrice = BigInt(MIN_GAS_PRICE_GWEI * 1e9); // Convert Gwei to Wei
      const finalGasPrice = enhancedGasPrice > minGasPrice ? enhancedGasPrice : minGasPrice;
      
      logger.info('Sending V3 transaction via Smart Router with gas optimization', {
        to: routerAddress,
        originalGas: gasEstimate.toString(),
        gasWithBuffer: gasWithBuffer.toString(),
        bufferPercentage: GAS_BUFFER_PERCENTAGE,
        baseGasPrice: baseGasPrice.toString(),
        finalGasPrice: finalGasPrice.toString(),
        gasPriceMultiplier: GAS_PRICE_MULTIPLIER
      });

      const hash = await walletClient.sendTransaction({ 
        ...tx, 
        gas: gasWithBuffer, 
        gasPrice: finalGasPrice 
      });
      
      logger.info('V3 transaction sent, waiting for confirmation...', { hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      if (receipt.status === 'success') {
          return { success: true, txHash: hash, tokensReceived: expectedOutputAmount };
      } else {
          return { success: false, txHash: hash, error: 'Transaction failed on-chain (reverted)' };
      }

    } catch (error: any) {
      logger.error('V3 Swap execution error', { error: error.shortMessage || error.message || String(error) });
      return { success: false, error: error.shortMessage || error.message || String(error) };
    }
  }

  // Legacy V2 swap method now uses the V3 SDK for full compatibility
  public async executeSwap(userId: number, params: SwapParams): Promise<{ success: boolean; txHash?: string; error?: string; tokensReceived?: string; }> {
    const v3Params: V3SwapParams = {
        tokenInAddress: params.tokenInAddress === 'BNB' ? 'native' : params.tokenInAddress,
        tokenOutAddress: params.tokenOutAddress === 'BNB' ? 'native' : params.tokenOutAddress,
        amountIn: params.amountIn,
        slippage: params.slippage,
    };
    return this.executeV3Swap(userId, v3Params);
  }

  /**
   * Get token information - supports both known and unknown tokens
   */
  private async getToken(address: string): Promise<Currency | undefined> {
    if (address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || 
        address.toLowerCase() === 'native' || 
        address.toLowerCase() === 'bnb') {
        return Native.onChain(CHAIN_ID);
    }
    
    const checksummedAddress = ethers.getAddress(address) as `0x${string}`;
    
    const knownToken = Object.values(bscTokens).find(
      t => t.address.toLowerCase() === checksummedAddress.toLowerCase()
    );
    if (knownToken) return knownToken;
    
    try {
      logger.warn(`Token ${address} not in known list. Fetching info from chain.`);
      const decimals = await publicClient.readContract({
        address: checksummedAddress,
        abi: ERC20_ABI,
        functionName: 'decimals'
      }) as number;
      
      let symbol = 'UNKNOWN';
      try {
        symbol = await publicClient.readContract({
          address: checksummedAddress,
          abi: ERC20_ABI,
          functionName: 'symbol'
        }) as string;
      } catch (e) { /* ignore */ }
      
      return new Token(CHAIN_ID, checksummedAddress, decimals, symbol, symbol);
    } catch (e) {
      logger.error(`Failed to fetch token info for ${address}`, e);
      return undefined;
    }
  }

  /**
   * Ensure sufficient token approval for Smart Router
   */
  private async ensureTokenApprovalSDK(
    walletClient: any, 
    account: PrivateKeyAccount, 
    currencyAmount: CurrencyAmount<Token>
  ) {
    const routerAddress = SMART_ROUTER_ADDRESSES[CHAIN_ID] as `0x${string}`;
    const token = currencyAmount.currency;

    const allowance = await publicClient.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, routerAddress],
    });

    if (allowance < currencyAmount.quotient) {
      logger.info(`Approving ${token.symbol} for Smart Router...`);
      const hash = await walletClient.writeContract({
        address: token.address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [routerAddress, ethers.MaxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      logger.info(`${token.symbol} approved successfully.`);
    } else {
      logger.info(`${token.symbol} already has sufficient allowance.`);
    }
  }

  /**
   * Gas estimation (simplified for Smart Router)
   */
  async estimateSwapGas(userId: number, params: SwapParams): Promise<{
    gasLimit: bigint;
    gasPrice: bigint;
    totalCostBNB: string;
  } | null> {
    try {
      // Convert to V3 params
      const v3Params: V3SwapParams = {
        tokenInAddress: params.tokenInAddress,
        tokenOutAddress: params.tokenOutAddress,
        amountIn: params.amountIn,
        slippage: params.slippage,
      };

      const walletData = await UserService.getTradingWalletData(userId);
      if (!walletData) return null;

      const privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, walletData.iv);
      const account = privateKeyToAccount(`0x${privateKey.startsWith('0x') ? privateKey.substring(2) : privateKey}` as `0x${string}`);

      // Get trade route
      const trade = await this.getBestTrade(v3Params);
      
      const routerAddress = SMART_ROUTER_ADDRESSES[CHAIN_ID] as `0x${string}`;
      const slippageTolerance = new Percent(BigInt(Math.floor((params.slippage || 1) * 100)), BigInt(10000));

      const { value, calldata } = SwapRouter.swapCallParameters(trade, {
        recipient: account.address,
        slippageTolerance,
      });

      const tx = {
        account: account.address,
        to: routerAddress,
        data: calldata as `0x${string}`,
        value: BigInt(value),
      };

      const baseGasLimit = await publicClient.estimateGas(tx);
      const baseGasPrice = await publicClient.getGasPrice();
      
      // Apply same gas optimization as in actual execution
      const gasLimit = (baseGasLimit * BigInt(100 + GAS_BUFFER_PERCENTAGE)) / BigInt(100);
      const enhancedGasPrice = BigInt(Math.floor(Number(baseGasPrice) * GAS_PRICE_MULTIPLIER));
      const minGasPrice = BigInt(MIN_GAS_PRICE_GWEI * 1e9);
      const gasPrice = enhancedGasPrice > minGasPrice ? enhancedGasPrice : minGasPrice;
      
      const totalCost = gasLimit * gasPrice;

      return {
        gasLimit,
        gasPrice,
        totalCostBNB: ethers.formatEther(totalCost.toString())
      };

    } catch (error) {
      logger.error('Gas estimation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        params
      });
      return null;
    }
  }

  /**
   * Get a quote for a swap using Smart Router (V2 and V3)
   */
  public async getSwapQuote(params: SwapParams): Promise<{
    amountOut: string;
    priceImpact: string;
    route: string;
  } | null> {
    try {
      const v3Params: V3SwapParams = {
        tokenInAddress: params.tokenInAddress === 'BNB' ? 'native' : params.tokenInAddress,
        tokenOutAddress: params.tokenOutAddress === 'BNB' ? 'native' : params.tokenOutAddress,
        amountIn: params.amountIn,
        slippage: params.slippage || 5,
      };

      const trade = await this.getBestTrade(v3Params);
      
      if (!trade) {
        return null;
      }

      // Format output amount without scientific notation
      const outputAmount = trade.outputAmount.toExact();
      
      // Calculate price impact
      const priceImpact = trade.priceImpact ? trade.priceImpact.toSignificant(2) : '0';
      
      // Build route description
      const route = trade.routes
        .map((r: any) => r.path.map((t: any) => t.symbol).join(' -> '))
        .join(', ');

      return {
        amountOut: outputAmount,
        priceImpact: priceImpact,
        route: route || 'Direct swap',
      };
    } catch (error) {
      logger.error('Failed to get swap quote', { 
        error: error instanceof Error ? error.message : String(error),
        params 
      });
      return null;
    }
  }
}