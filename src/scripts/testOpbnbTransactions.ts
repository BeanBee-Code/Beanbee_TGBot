import dotenv from 'dotenv';

dotenv.config();

async function testTransactionHistory() {
    // Check if API key is available
    if (!process.env.NODEREAL_API_KEY) {
        console.error('Error: NODEREAL_API_KEY is not set in .env file');
        console.log('\nPlease add NODEREAL_API_KEY to your .env file to test this functionality.');
        console.log('You can get an API key from: https://nodereal.io');
        process.exit(1);
    }
    
    // Import service after checking API key
    const { opbnbService } = await import('../services/nodereal/opbnbService');
    const testAddress = '0xc05e7c56a80b680d721df88c6a41d30ae64921d8';
    
    console.log('Testing improved opBNB transaction history');
    console.log('=' .repeat(60));
    console.log(`Test Address: ${testAddress}`);
    console.log('');
    
    try {
        console.log('Fetching transaction history...');
        const startTime = Date.now();
        
        const transactions = await opbnbService.getTransactionHistory(testAddress, 10);
        
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
        
        console.log(`\nFetch completed in ${duration.toFixed(2)} seconds`);
        console.log(`Found ${transactions.length} transactions\n`);
        
        if (transactions.length > 0) {
            console.log('Transaction Details:');
            console.log('-' .repeat(60));
            
            transactions.forEach((tx, index) => {
                console.log(`\n${index + 1}. Transaction ${tx.hash}`);
                console.log(`   Date: ${new Date(tx.timestamp).toLocaleString()}`);
                console.log(`   From: ${tx.from}`);
                console.log(`   To: ${tx.to}`);
                console.log(`   Value: ${tx.formattedValue}`);
                console.log(`   Gas Fees: ${tx.formattedFees}`);
                console.log(`   Block: ${tx.blockHeight}`);
                console.log(`   Status: ${tx.successful ? '✅ Success' : '❌ Failed'}`);
                console.log(`   Category: ${tx.category || 'N/A'}`);
                
                if (tx.tokenInfo) {
                    console.log(`   Token: ${tx.tokenInfo.symbol} (${tx.tokenInfo.name})`);
                }
            });
            
            console.log('\n' + '=' .repeat(60));
            console.log('Test completed successfully!');
            console.log(`Performance: ${duration < 2 ? '🚀 Excellent' : duration < 5 ? '✅ Good' : '⚠️ Slow'} (${duration.toFixed(2)}s)`);
        } else {
            console.log('No transactions found for this address');
        }
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testTransactionHistory();