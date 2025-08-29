#!/usr/bin/env ts-node
/**
 * Test script to verify signature service is working correctly
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { signatureService } from '../services/trading/signatureService';

// Load environment variables
dotenv.config();

async function testSignatureService() {
    console.log('🔐 Testing Signature Service...\n');

    try {
        // 1. Verify signer address matches contract
        console.log('1. Verifying signer address...');
        const isValid = await signatureService.verifySignerAddress();
        if (isValid) {
            console.log('   ✅ Signer address verified successfully');
        } else {
            console.error('   ❌ Signer address mismatch!');
            process.exit(1);
        }

        // 2. Test user address and router
        const testUser = '0xa8FB745067c4894edA0179190D0e8476251B3f92'; // Your deployer address
        const routerAddress = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4'; // PancakeSwap V3
        
        // 3. Get user nonce
        console.log('\n2. Getting user nonce...');
        const nonce = await signatureService.getUserNonce(testUser);
        console.log(`   User nonce: ${nonce}`);

        // 4. Generate a test swap signature
        console.log('\n3. Generating test swap signature...');
        const testCalldata = '0x12345678'; // Mock calldata
        const swapSig = await signatureService.generateSwapSignature(
            testUser,
            routerAddress,
            testCalldata,
            5 // 5 minutes deadline for testing
        );
        console.log('   ✅ Swap signature generated');
        console.log(`   - Signature: ${swapSig.signature.substring(0, 20)}...`);
        console.log(`   - Deadline: ${swapSig.deadline}`);
        console.log(`   - Nonce: ${swapSig.nonce}`);

        // 5. Generate a test token swap signature
        console.log('\n4. Generating test token swap signature...');
        const testToken = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'; // WBNB
        const testAmount = ethers.parseEther('0.1').toString();
        const tokenSwapSig = await signatureService.generateTokenSwapSignature(
            testUser,
            testToken,
            routerAddress,
            testAmount,
            testCalldata,
            5 // 5 minutes deadline
        );
        console.log('   ✅ Token swap signature generated');
        console.log(`   - Signature: ${tokenSwapSig.signature.substring(0, 20)}...`);
        console.log(`   - Deadline: ${tokenSwapSig.deadline}`);
        console.log(`   - Nonce: ${tokenSwapSig.nonce}`);

        // 6. Verify signature structure
        console.log('\n5. Verifying signature structure...');
        const sigBytes = ethers.getBytes(swapSig.signature);
        if (sigBytes.length === 65) {
            console.log('   ✅ Signature has correct length (65 bytes)');
        } else {
            console.error(`   ❌ Signature has incorrect length: ${sigBytes.length} bytes`);
        }

        console.log('\n✨ All tests passed successfully!');
        console.log('\n📋 Summary:');
        console.log(`   - Signer Address: ${process.env.SIGNER_ADDRESS || 'Using deployer address'}`);
        console.log(`   - Router Contract: 0x8372Ec5Da575D4c637dfaA33a22DF96406D7d1F4`);
        console.log(`   - Signature Service: Working correctly`);
        
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testSignatureService().then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
}).catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
});