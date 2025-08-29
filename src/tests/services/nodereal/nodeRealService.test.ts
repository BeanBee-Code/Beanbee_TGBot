import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { ethers } from 'ethers';
import { config } from 'dotenv';

config();

describe('NodeReal opBNB API Integration', () => {
  const API_KEY = process.env.NODEREAL_API_KEY || process.env.NODEREAL_TEST_API_KEY || 'test-api-key';
  const BASE_URL = `https://opbnb-mainnet.nodereal.io/v1/${API_KEY}`;
  const TEST_WALLET = process.env.TEST_WALLET_ADDRESS || '0xc05e7c56a80b680d721df88c6a41d30ae64921d8';
  
  let provider: ethers.JsonRpcProvider;

  beforeAll(() => {
    provider = new ethers.JsonRpcProvider(BASE_URL);
  });

  describe('Native BNB Balance', () => {
    it('should fetch BNB balance using eth_getBalance', async () => {
      try {
        const response = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'eth_getBalance',
          params: [TEST_WALLET, 'latest'],
          id: 1
        });

        console.log('Native BNB Balance Response:', JSON.stringify(response.data, null, 2));
        
        expect(response.data).toHaveProperty('result');
        
        // Convert hex to decimal
        const balanceHex = response.data.result;
        const balanceWei = BigInt(balanceHex);
        const balanceBNB = ethers.formatEther(balanceWei);
        
        console.log(`Wallet ${TEST_WALLET} BNB Balance: ${balanceBNB} BNB`);
        
        expect(typeof balanceHex).toBe('string');
        expect(balanceHex.startsWith('0x')).toBe(true);
      } catch (error) {
        console.error('Error fetching BNB balance:', error);
        throw error;
      }
    });

    it('should fetch BNB balance using ethers.js provider', async () => {
      try {
        const balance = await provider.getBalance(TEST_WALLET);
        const balanceBNB = ethers.formatEther(balance);
        
        console.log(`Wallet ${TEST_WALLET} BNB Balance (via ethers): ${balanceBNB} BNB`);
        
        expect(balance).toBeDefined();
        expect(balance >= 0n).toBe(true);
      } catch (error) {
        console.error('Error fetching BNB balance with ethers:', error);
        throw error;
      }
    });
  });

  describe('Token Holdings', () => {
    it('should fetch token holdings using nr_getTokenHoldings', async () => {
      try {
        const response = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'nr_getTokenHoldings',
          params: [
            TEST_WALLET,  // address
            '0x1',        // page number (hex)
            '0x14'        // page size (hex) - 20 tokens per page
          ],
          id: 1
        });

        console.log('Token Holdings Response:', JSON.stringify(response.data, null, 2));
        
        expect(response.data).toHaveProperty('result');
        
        if (response.data.result) {
          const { tokenHoldings, totalCount } = response.data.result;
          
          console.log(`Total Token Count: ${totalCount}`);
          
          if (tokenHoldings && tokenHoldings.length > 0) {
            console.log('\n=== Token Holdings ===');
            tokenHoldings.forEach((token: any) => {
              console.log(`Token: ${token.tokenContractAddress}`);
              console.log(`  Symbol: ${token.tokenSymbol || 'N/A'}`);
              console.log(`  Name: ${token.tokenName || 'N/A'}`);
              console.log(`  Balance: ${token.balance}`);
              console.log(`  Decimals: ${token.tokenDecimal || 'N/A'}`);
              console.log('---');
            });
          } else {
            console.log('No token holdings found for this wallet');
          }
        }
      } catch (error) {
        console.error('Error fetching token holdings:', error);
        throw error;
      }
    });

    it('should fetch multiple pages of token holdings if needed', async () => {
      try {
        const pageSize = 10;
        const firstPage = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'nr_getTokenHoldings',
          params: [
            TEST_WALLET,
            '0x1',  // page 1
            `0x${pageSize.toString(16)}`  // page size in hex
          ],
          id: 1
        });

        if (firstPage.data.result) {
          const totalCount = parseInt(firstPage.data.result.totalCount || '0');
          console.log(`Total tokens found: ${totalCount}`);

          if (totalCount > pageSize) {
            const totalPages = Math.ceil(totalCount / pageSize);
            console.log(`Fetching ${totalPages} pages of token data...`);

            const allTokens = [...(firstPage.data.result.tokenHoldings || [])];

            for (let page = 2; page <= totalPages; page++) {
              const response = await axios.post(BASE_URL, {
                jsonrpc: '2.0',
                method: 'nr_getTokenHoldings',
                params: [
                  TEST_WALLET,
                  `0x${page.toString(16)}`,
                  `0x${pageSize.toString(16)}`
                ],
                id: page
              });

              if (response.data.result?.tokenHoldings) {
                allTokens.push(...response.data.result.tokenHoldings);
              }
            }

            console.log(`Total tokens retrieved: ${allTokens.length}`);
            expect(allTokens.length).toBeLessThanOrEqual(totalCount);
          }
        }
      } catch (error) {
        console.error('Error fetching paginated token holdings:', error);
        throw error;
      }
    });
  });

  describe('Block Information', () => {
    it('should fetch latest block number', async () => {
      try {
        const response = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1
        });

        console.log('Latest Block Response:', response.data);
        
        const blockNumber = parseInt(response.data.result, 16);
        console.log(`Latest block number: ${blockNumber}`);
        
        expect(blockNumber).toBeGreaterThan(0);
      } catch (error) {
        console.error('Error fetching block number:', error);
        throw error;
      }
    });
  });

  describe('Transaction Count', () => {
    it('should fetch transaction count for wallet', async () => {
      try {
        const response = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'eth_getTransactionCount',
          params: [TEST_WALLET, 'latest'],
          id: 1
        });

        console.log('Transaction Count Response:', response.data);
        
        const txCount = parseInt(response.data.result, 16);
        console.log(`Transaction count for ${TEST_WALLET}: ${txCount}`);
        
        expect(txCount).toBeGreaterThanOrEqual(0);
      } catch (error) {
        console.error('Error fetching transaction count:', error);
        throw error;
      }
    });
  });

  describe('Chain ID Verification', () => {
    it('should verify opBNB chain ID', async () => {
      try {
        const response = await axios.post(BASE_URL, {
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1
        });

        const chainId = parseInt(response.data.result, 16);
        console.log(`Chain ID: ${chainId}`);
        
        // opBNB mainnet chain ID is 204
        expect(chainId).toBe(204);
      } catch (error) {
        console.error('Error fetching chain ID:', error);
        throw error;
      }
    });
  });
});