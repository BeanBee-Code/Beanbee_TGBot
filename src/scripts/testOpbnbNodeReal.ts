#!/usr/bin/env npx ts-node

import { config } from 'dotenv';
config();

import { opbnbService } from '../services/nodereal/opbnbService';

async function testOpbnbService() {
  const TEST_WALLET = '0xc05e7c56a80b680d721df88c6a41d30ae64921d8';
  
  console.log('🚀 Testing opBNB Service with NodeReal API');
  console.log('==========================================\n');
  
  try {
    // Test 1: Native Balance
    console.log('1️⃣ Testing getNativeBalance()...');
    const nativeBalance = await opbnbService.getNativeBalance(TEST_WALLET);
    console.log('✅ Native Balance:', nativeBalance);
    console.log('');
    
    // Test 2: Token Balances
    console.log('2️⃣ Testing getTokenBalances()...');
    const tokens = await opbnbService.getTokenBalances(TEST_WALLET);
    console.log(`✅ Found ${tokens.length} tokens`);
    if (tokens.length > 0) {
      console.log('First token:', {
        symbol: tokens[0].symbol,
        formatted: tokens[0].formatted,
        usdValue: tokens[0].usdValue
      });
    }
    console.log('');
    
    // Test 3: Transaction History
    console.log('3️⃣ Testing getTransactionHistory()...');
    const transactions = await opbnbService.getTransactionHistory(TEST_WALLET, 5);
    console.log(`✅ Found ${transactions.length} transactions`);
    if (transactions.length > 0) {
      console.log('Latest transaction:', {
        hash: transactions[0].hash,
        from: opbnbService.shortenAddress(transactions[0].from),
        to: opbnbService.shortenAddress(transactions[0].to),
        value: transactions[0].formattedValue,
        timestamp: transactions[0].timestamp
      });
    }
    console.log('');
    
    // Test 4: Helper functions
    console.log('4️⃣ Testing helper functions...');
    const shortAddr = opbnbService.shortenAddress(TEST_WALLET);
    console.log(`✅ Shortened address: ${shortAddr}`);
    
    const formattedDate = opbnbService.formatDate(new Date().toISOString());
    console.log(`✅ Formatted date: ${formattedDate}`);
    
    console.log('\n✅ All tests passed! The opBNB service is working correctly with NodeReal API.');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testOpbnbService().catch(console.error);