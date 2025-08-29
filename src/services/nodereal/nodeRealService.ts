import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import logger from '@/utils/logger';

const log = logger.child({ module: 'nodeRealService' });

export interface TokenHolding {
  tokenContractAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  balance: string;
  tokenDecimal?: string;
  tokenType?: string;
}

export interface TokenHoldingsResponse {
  tokenHoldings: TokenHolding[];
  totalCount: string;
}

export interface WalletBalance {
  nativeBNB: string;
  tokens: TokenHolding[];
}

export class NodeRealService {
  private apiKey: string;
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private provider: ethers.JsonRpcProvider;

  constructor(apiKey: string, network: 'mainnet' | 'testnet' = 'mainnet') {
    this.apiKey = apiKey;
    this.baseUrl = network === 'mainnet' 
      ? `https://opbnb-mainnet.nodereal.io/v1/${apiKey}`
      : `https://opbnb-testnet.nodereal.io/v1/${apiKey}`;
    
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.provider = new ethers.JsonRpcProvider(this.baseUrl);
  }

  /**
   * Fetch native BNB balance for a wallet address
   */
  async getBNBBalance(address: string): Promise<string> {
    try {
      log.info(`Fetching BNB balance for ${address}`);
      
      const balance = await this.provider.getBalance(address);
      const balanceBNB = ethers.formatEther(balance);
      
      log.info(`BNB balance for ${address}: ${balanceBNB} BNB`);
      return balanceBNB;
    } catch (error) {
      log.error('Error fetching BNB balance:', error);
      throw error;
    }
  }

  /**
   * Fetch all token holdings for a wallet address
   */
  async getTokenHoldings(address: string): Promise<TokenHolding[]> {
    try {
      log.info(`Fetching token holdings for ${address}`);
      
      const allTokens: TokenHolding[] = [];
      const pageSize = 20;
      let currentPage = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.axiosInstance.post('', {
          jsonrpc: '2.0',
          method: 'nr_getTokenHoldings',
          params: [
            address,
            `0x${currentPage.toString(16)}`,
            `0x${pageSize.toString(16)}`
          ],
          id: currentPage
        });

        if (response.data.result) {
          // The API returns details array, not tokenHoldings
          const { details, totalCount } = response.data.result;
          
          if (details && details.length > 0) {
            // Transform the response format to our interface
            const transformedTokens = details.map((token: any) => ({
              tokenContractAddress: token.tokenAddress,
              tokenSymbol: token.tokenSymbol,
              tokenName: token.tokenName,
              balance: token.tokenBalance,
              tokenDecimal: token.tokenDecimals,
            }));
            allTokens.push(...transformedTokens);
          }

          const total = parseInt(totalCount || '0', 16); // totalCount is in hex
          hasMore = allTokens.length < total && details?.length === pageSize;
          currentPage++;
        } else {
          hasMore = false;
        }
      }

      log.info(`Found ${allTokens.length} tokens for ${address}`);
      return allTokens;
    } catch (error) {
      log.error('Error fetching token holdings:', error);
      throw error;
    }
  }

  /**
   * Get complete wallet balance (native BNB + all tokens)
   */
  async getWalletBalance(address: string): Promise<WalletBalance> {
    try {
      log.info(`Fetching complete wallet balance for ${address}`);
      
      const [nativeBNB, tokens] = await Promise.all([
        this.getBNBBalance(address),
        this.getTokenHoldings(address)
      ]);

      return {
        nativeBNB,
        tokens
      };
    } catch (error) {
      log.error('Error fetching wallet balance:', error);
      throw error;
    }
  }

  /**
   * Format token balance with proper decimals
   */
  formatTokenBalance(balance: string, decimals: string | number = 18): string {
    try {
      const decimalCount = typeof decimals === 'string' ? parseInt(decimals) : decimals;
      return ethers.formatUnits(balance, decimalCount);
    } catch (error) {
      log.error('Error formatting token balance:', error);
      return balance;
    }
  }

  /**
   * Get transaction count for an address
   */
  async getTransactionCount(address: string): Promise<number> {
    try {
      const count = await this.provider.getTransactionCount(address);
      log.info(`Transaction count for ${address}: ${count}`);
      return count;
    } catch (error) {
      log.error('Error fetching transaction count:', error);
      throw error;
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      log.info(`Current block number: ${blockNumber}`);
      return blockNumber;
    } catch (error) {
      log.error('Error fetching block number:', error);
      throw error;
    }
  }

  /**
   * Verify chain ID (should be 204 for opBNB mainnet)
   */
  async getChainId(): Promise<number> {
    try {
      const network = await this.provider.getNetwork();
      const chainId = Number(network.chainId);
      log.info(`Chain ID: ${chainId}`);
      return chainId;
    } catch (error) {
      log.error('Error fetching chain ID:', error);
      throw error;
    }
  }

  /**
   * Execute custom RPC method
   */
  async executeRPC(method: string, params: any[] = []): Promise<any> {
    try {
      const response = await this.axiosInstance.post('', {
        jsonrpc: '2.0',
        method,
        params,
        id: 1
      });

      return response.data.result;
    } catch (error) {
      log.error(`Error executing RPC method ${method}:`, error);
      throw error;
    }
  }
}

// Export singleton instance with environment variable
export const nodeRealService = process.env.NODEREAL_API_KEY 
  ? new NodeRealService(process.env.NODEREAL_API_KEY)
  : null;