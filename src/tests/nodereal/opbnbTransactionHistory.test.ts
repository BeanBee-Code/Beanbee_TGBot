import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const NODEREAL_API_KEY = process.env.NODEREAL_API_KEY;
const OPBNB_MAINNET_URL = `https://opbnb-mainnet.nodereal.io/v1/${NODEREAL_API_KEY}`;
const TEST_ADDRESS = '0xc05e7c56a80b680d721df88c6a41d30ae64921d8';

interface TransactionHistoryResponse {
  jsonrpc: string;
  id: number;
  result: {
    status: string;
    message: string;
    result: Array<{
      blockNumber: string;
      timeStamp: string;
      hash: string;
      nonce: string;
      blockHash: string;
      transactionIndex: string;
      from: string;
      to: string;
      value: string;
      gas: string;
      gasPrice: string;
      isError: string;
      txreceipt_status: string;
      input: string;
      contractAddress: string;
      cumulativeGasUsed: string;
      gasUsed: string;
      confirmations: string;
      methodId: string;
      functionName: string;
      tokenName?: string;
      tokenSymbol?: string;
      tokenDecimal?: string;
    }>;
  };
}

async function getTransactionHistory(address: string, limit: number = 10) {
  try {
    console.log(`Fetching transaction history for ${address}...`);
    console.log(`Using API URL: ${OPBNB_MAINNET_URL}`);
    
    const requestData = {
      jsonrpc: "2.0",
      method: "nr_getTransactionByAddress",
      params: [{
        category: ["external", "20", "721", "1155"], // Include all transaction types
        addressType: "from", // Get transactions from this address
        address: address.toLowerCase(),
        order: "desc", // Most recent first
        maxCount: `0x${limit.toString(16)}` // Convert to hex
      }],
      id: 1
    };

    console.log('Request data:', JSON.stringify(requestData, null, 2));

    const response = await axios.post(
      OPBNB_MAINNET_URL,
      requestData,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));
    
    if (response.data.result && response.data.result.transfers) {
      const transactions = response.data.result.transfers;
      console.log(`\nFound ${transactions.length} transactions for ${address}`);
      
      if (Array.isArray(transactions)) {
        console.log('\n=== Top 10 Transactions ===\n');
        transactions.slice(0, 10).forEach((tx: any, index: number) => {
          const date = new Date(tx.blockTimeStamp * 1000).toLocaleString();
          const valueInBNB = tx.value ? (BigInt(tx.value) / BigInt(10 ** 18)).toString() : '0';
          console.log(`${index + 1}. Transaction ${tx.hash}`);
          console.log(`   Date: ${date}`);
          console.log(`   From: ${tx.from}`);
          console.log(`   To: ${tx.to}`);
          console.log(`   Value: ${valueInBNB} BNB`);
          console.log(`   Block: ${parseInt(tx.blockNum, 16)}`);
          console.log(`   Gas Used: ${tx.gasUsed}`);
          console.log(`   Status: ${tx.receiptsStatus === 1 ? 'Success' : 'Failed'}`);
          if (tx.category) {
            console.log(`   Type: ${tx.category}`);
          }
          console.log('');
        });
        return transactions;
      } else {
        console.log('Transfers is not an array:', response.data.result.transfers);
        return [];
      }
    } else {
      console.log('No result in response:', response.data);
      return [];
    }
  } catch (error) {
    console.error('Error fetching transaction history:', error);
    if (axios.isAxiosError(error)) {
      console.error('Response data:', error.response?.data);
    }
    throw error;
  }
}

// Also try getting transactions where the address is the recipient
async function getTransactionHistoryAsRecipient(address: string, limit: number = 10) {
  try {
    console.log(`\nFetching transactions where ${address} is recipient...`);
    
    const requestData = {
      jsonrpc: "2.0",
      method: "nr_getTransactionByAddress",
      params: [{
        category: ["external", "20", "721", "1155"],
        addressType: "to", // Get transactions to this address
        address: address.toLowerCase(),
        order: "desc",
        maxCount: `0x${limit.toString(16)}`
      }],
      id: 1
    };

    const response = await axios.post(
      OPBNB_MAINNET_URL,
      requestData,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.result && response.data.result.transfers) {
      const transactions = response.data.result.transfers;
      console.log(`Found ${transactions.length} transactions where address is recipient`);
      return transactions;
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching recipient transactions:', error);
    return [];
  }
}

// Run the test
async function main() {
  if (!NODEREAL_API_KEY) {
    console.error('Error: NODEREAL_API_KEY is not set in environment variables');
    process.exit(1);
  }

  console.log('Testing opBNB transaction history API with NodeReal\n');
  console.log('=' .repeat(50));
  
  try {
    // Get transactions from the address
    const sentTransactions = await getTransactionHistory(TEST_ADDRESS, 10);
    
    // Get transactions to the address
    const receivedTransactions = await getTransactionHistoryAsRecipient(TEST_ADDRESS, 10);
    
    console.log('\n' + '=' .repeat(50));
    console.log('Test completed successfully!');
    console.log(`Total sent transactions: ${Array.isArray(sentTransactions) ? sentTransactions.length : 0}`);
    console.log(`Total received transactions: ${Array.isArray(receivedTransactions) ? receivedTransactions.length : 0}`);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { getTransactionHistory, getTransactionHistoryAsRecipient };