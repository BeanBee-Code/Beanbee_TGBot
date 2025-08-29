#!/usr/bin/env npx ts-node

import { NodeRealService } from '../services/nodereal/nodeRealService';
import { config } from 'dotenv';

config();

async function testNodeRealAPI() {
  const API_KEY = process.env.NODEREAL_API_KEY || process.env.NODEREAL_TEST_API_KEY || '';
  const TEST_WALLET = process.env.TEST_WALLET_ADDRESS || '0xc05e7c56a80b680d721df88c6a41d30ae64921d8';
  
  console.log('🚀 Testing NodeReal opBNB API Integration');
  console.log('=========================================\n');
  
  if (!API_KEY) {
    console.error('❌ Error: NODEREAL_API_KEY or NODEREAL_TEST_API_KEY environment variable is required');
    console.log('Please set it in your .env file');
    process.exit(1);
  }
  
  const nodeReal = new NodeRealService(API_KEY, 'mainnet');
  
  try {
    // 1. Check Chain ID
    console.log('1️⃣ Verifying Chain ID...');
    const chainId = await nodeReal.getChainId();
    console.log(`   ✅ Chain ID: ${chainId} (Expected: 204 for opBNB mainnet)\n`);
    
    // 2. Get Current Block
    console.log('2️⃣ Fetching Current Block...');
    const blockNumber = await nodeReal.getBlockNumber();
    console.log(`   ✅ Current Block: ${blockNumber.toLocaleString()}\n`);
    
    // 3. Get BNB Balance
    console.log('3️⃣ Fetching BNB Balance...');
    const bnbBalance = await nodeReal.getBNBBalance(TEST_WALLET);
    console.log(`   ✅ BNB Balance: ${bnbBalance} BNB\n`);
    
    // 4. Get Transaction Count
    console.log('4️⃣ Fetching Transaction Count...');
    const txCount = await nodeReal.getTransactionCount(TEST_WALLET);
    console.log(`   ✅ Transaction Count: ${txCount}\n`);
    
    // 5. Get Token Holdings
    console.log('5️⃣ Fetching Token Holdings...');
    const tokens = await nodeReal.getTokenHoldings(TEST_WALLET);
    console.log(`   ✅ Found ${tokens.length} tokens\n`);
    
    if (tokens.length > 0) {
      console.log('   📊 Token Details:');
      console.log('   ' + '='.repeat(50));
      
      tokens.slice(0, 10).forEach((token, index) => {
        console.log(`\n   Token #${index + 1}:`);
        console.log(`   Address: ${token.tokenContractAddress}`);
        console.log(`   Symbol: ${token.tokenSymbol || 'Unknown'}`);
        console.log(`   Name: ${token.tokenName || 'Unknown'}`);
        console.log(`   Raw Balance: ${token.balance}`);
        
        if (token.tokenDecimal) {
          const formattedBalance = nodeReal.formatTokenBalance(token.balance, token.tokenDecimal);
          console.log(`   Formatted Balance: ${formattedBalance}`);
        }
      });
      
      if (tokens.length > 10) {
        console.log(`\n   ... and ${tokens.length - 10} more tokens`);
      }
    }
    
    // 6. Get Complete Wallet Summary
    console.log('\n6️⃣ Complete Wallet Summary:');
    console.log('   ' + '='.repeat(50));
    const walletBalance = await nodeReal.getWalletBalance(TEST_WALLET);
    console.log(`   Wallet Address: ${TEST_WALLET}`);
    console.log(`   BNB Balance: ${walletBalance.nativeBNB} BNB`);
    console.log(`   Total Tokens: ${walletBalance.tokens.length}`);
    
    // Display top tokens by symbol
    const namedTokens = walletBalance.tokens.filter(t => t.tokenSymbol);
    if (namedTokens.length > 0) {
      console.log('\n   Top Tokens:');
      namedTokens.slice(0, 5).forEach(token => {
        const formatted = token.tokenDecimal 
          ? nodeReal.formatTokenBalance(token.balance, token.tokenDecimal)
          : token.balance;
        console.log(`   - ${token.tokenSymbol}: ${formatted}`);
      });
    }
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Error during testing:', error);
    process.exit(1);
  }
}

// Run the test
testNodeRealAPI().catch(console.error);