/**
 * Script to fetch verified source code from BSCScan using Etherscan V2 API
 *
 * IMPORTANT: BSCScan has migrated to Etherscan V2 API.
 * - Use your ETHERSCAN API KEY (not BSCScan API key)
 * - The V2 API consolidates all chains under api.etherscan.io/v2/api
 * - Use chainid=56 for BSC Mainnet, chainid=97 for BSC Testnet
 *
 * Usage:
 *   npx tsx src/scripts/getBscSourceCode.ts [contract_address] [--save] [--chain=56]
 *
 * Examples:
 *   npx tsx src/scripts/getBscSourceCode.ts 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
 *   npx tsx src/scripts/getBscSourceCode.ts 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 --save
 *   npx tsx src/scripts/getBscSourceCode.ts 0xContractAddress --chain=1  # Ethereum mainnet
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for BSCScan API response
 */
interface BscScanSourceCodeResult {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  ConstructorArguments: string;
  EVMVersion: string;
  Library: string;
  LicenseType: string;
  Proxy: string;
  Implementation: string;
  SwarmSource: string;
}

interface BscScanResponse {
  status: string;
  message: string;
  result: BscScanSourceCodeResult[];
}

/**
 * Fetches verified source code using Etherscan V2 API
 *
 * The V2 API consolidates all EVM chains under a single endpoint.
 * Use chainid parameter to specify the chain (56 = BSC, 1 = Ethereum, etc.)
 *
 * @param contractAddress - The contract address to fetch source code for
 * @param chainId - The chain ID (56 for BSC Mainnet, 97 for BSC Testnet, 1 for Ethereum, etc.)
 * @returns Promise containing the source code data
 */
async function getVerifiedSourceCode(
  contractAddress: string,
  chainId: number = 56
): Promise<BscScanSourceCodeResult[] | null> {
  // Load API key from environment
  // IMPORTANT: Use ETHERSCAN_API_KEY for V2, not BSCSCAN_API_KEY
  const envPath = path.join(__dirname, '../../.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');

  // Try Etherscan key first (V2 standard), fallback to BSCScan key
  let apiKeyMatch = envContent.match(/ETHERSCAN_API_KEY=([^\n\r]+)/);
  let apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : '';
  let keySource = 'ETHERSCAN_API_KEY';

  if (!apiKey) {
    // Fallback to BSCScan key for backwards compatibility
    apiKeyMatch = envContent.match(/BSCSCAN_API_KEY=([^\n\r]+)/);
    apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : '';
    keySource = 'BSCSCAN_API_KEY';
  }

  if (!apiKey) {
    console.error('ERROR: No API key found in .env file');
    console.error('Please add either ETHERSCAN_API_KEY (recommended for V2) or BSCSCAN_API_KEY');
    throw new Error('API key is required');
  }

  const chainNames: Record<number, string> = {
    1: 'Ethereum Mainnet',
    56: 'BSC Mainnet',
    97: 'BSC Testnet',
    137: 'Polygon',
    42161: 'Arbitrum',
    10: 'Optimism',
    8453: 'Base',
  };

  console.log(`\nFetching source code for contract: ${contractAddress}`);
  console.log(`Chain: ${chainNames[chainId] || `Chain ID ${chainId}`}`);
  console.log(`Using ${keySource}: ${apiKey.substring(0, 10)}...`);

  // Etherscan V2 API endpoint
  const v2Url = 'https://api.etherscan.io/v2/api';

  try {
    console.log('\nAttempting Etherscan V2 API...');

    const response = await axios.get<BscScanResponse>(v2Url, {
      params: {
        chainid: chainId,
        module: 'contract',
        action: 'getsourcecode',
        address: contractAddress,
        apikey: apiKey,
      },
      timeout: 15000,
    });

    console.log(`API Response Status: ${response.data.status}`);
    console.log(`API Response Message: ${response.data.message}`);

    if (response.data.status === '1' && response.data.result && response.data.result.length > 0) {
      console.log('✓ Successfully fetched source code using V2 API');
      return response.data.result;
    }

    // Handle error responses
    if (response.data.message.includes('Invalid API Key')) {
      console.log('\n⚠ Invalid API Key');
      console.log('V2 API requires an Etherscan API key.');
      console.log('Please:');
      console.log('1. Get an API key from https://etherscan.io/myapikey');
      console.log('2. Add it to your .env file as: ETHERSCAN_API_KEY=your_key_here');
      console.log('\nNote: Old BSCScan-specific keys may not work with V2 API.');
      return null;
    }

    console.log(`\n⚠ API returned status 0: ${response.data.message}`);
    return null;

  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(`\n✗ API request failed: ${error.message}`);
      if (error.response) {
        console.error(`Response status: ${error.response.status}`);
        console.error(`Response data:`, error.response.data);
      }
    } else {
      console.error(`\n✗ Unexpected error: ${error}`);
    }
    throw error;
  }
}

/**
 * Pretty prints the source code information
 *
 * @param data - The source code data from BSCScan
 */
function printSourceCodeInfo(data: BscScanSourceCodeResult[]): void {
  if (!data || data.length === 0) {
    console.log('\nNo data to display');
    return;
  }

  const contract = data[0];

  console.log('\n' + '='.repeat(80));
  console.log('CONTRACT SOURCE CODE INFORMATION');
  console.log('='.repeat(80) + '\n');
  console.log(`Contract Name:      ${contract.ContractName}`);
  console.log(`Compiler Version:   ${contract.CompilerVersion}`);
  console.log(`Optimization Used:  ${contract.OptimizationUsed === '1' ? 'Yes' : 'No'}`);
  console.log(`Optimization Runs:  ${contract.Runs}`);
  console.log(`EVM Version:        ${contract.EVMVersion || 'N/A'}`);
  console.log(`License Type:       ${contract.LicenseType || 'N/A'}`);
  console.log(`Is Proxy Contract:  ${contract.Proxy === '1' ? 'Yes' : 'No'}`);

  if (contract.Proxy === '1' && contract.Implementation) {
    console.log(`Implementation:     ${contract.Implementation}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('SOURCE CODE');
  console.log('='.repeat(80) + '\n');

  // Parse source code if it's JSON (for multi-file contracts)
  try {
    const sourceCode = contract.SourceCode;
    if (sourceCode.startsWith('{{')) {
      // Remove the extra braces and parse
      const jsonSource = JSON.parse(sourceCode.slice(1, -1));
      console.log('Multi-file contract detected. Files:');
      console.log(JSON.stringify(jsonSource, null, 2));
    } else if (sourceCode.startsWith('{')) {
      const jsonSource = JSON.parse(sourceCode);
      console.log('Multi-file contract detected. Files:');
      console.log(JSON.stringify(jsonSource, null, 2));
    } else {
      // Single file source code
      console.log(sourceCode.substring(0, 1000)); // Show first 1000 chars
      if (sourceCode.length > 1000) {
        console.log(`\n... (${sourceCode.length - 1000} more characters)`);
        console.log('\n[Full source code available in the response object]');
      }
    }
  } catch (e) {
    // If parsing fails, just print the raw source code (truncated)
    const sourceCode = contract.SourceCode;
    console.log(sourceCode.substring(0, 1000));
    if (sourceCode.length > 1000) {
      console.log(`\n... (${sourceCode.length - 1000} more characters)`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('CONTRACT ABI');
  console.log('='.repeat(80) + '\n');

  // Pretty print ABI
  try {
    const abi = JSON.parse(contract.ABI);
    console.log(JSON.stringify(abi, null, 2).substring(0, 1500));
    if (JSON.stringify(abi).length > 1500) {
      console.log('\n... (ABI truncated for display)');
    }
  } catch (e) {
    console.log(contract.ABI.substring(0, 1500));
    if (contract.ABI.length > 1500) {
      console.log('\n... (ABI truncated for display)');
    }
  }

  if (contract.ConstructorArguments) {
    console.log('\n' + '='.repeat(80));
    console.log('CONSTRUCTOR ARGUMENTS');
    console.log('='.repeat(80) + '\n');
    console.log(contract.ConstructorArguments);
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

/**
 * Saves source code to a file
 *
 * @param data - The source code data from BSCScan
 * @param outputPath - Path to save the file
 */
function saveSourceCodeToFile(data: BscScanSourceCodeResult[], outputPath: string): void {
  if (!data || data.length === 0) {
    console.error('No data to save');
    return;
  }

  const contract = data[0];
  const outputData = {
    contractName: contract.ContractName,
    compilerVersion: contract.CompilerVersion,
    optimizationUsed: contract.OptimizationUsed === '1',
    runs: contract.Runs,
    evmVersion: contract.EVMVersion,
    licenseType: contract.LicenseType,
    isProxy: contract.Proxy === '1',
    implementation: contract.Implementation,
    sourceCode: contract.SourceCode,
    abi: contract.ABI,
    constructorArguments: contract.ConstructorArguments,
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\n✓ Source code saved to: ${outputPath}`);
}

// Main execution
async function main() {
  // Parse command-line arguments
  const args = process.argv.slice(2);

  // Default: PancakeSwap Token (CAKE) on BSC
  let contractAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
  let chainId = 56; // BSC Mainnet
  let saveToFile = false;

  // Parse arguments
  for (const arg of args) {
    if (arg.startsWith('0x')) {
      contractAddress = arg;
    } else if (arg === '--save') {
      saveToFile = true;
    } else if (arg.startsWith('--chain=')) {
      chainId = parseInt(arg.split('=')[1], 10);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('ETHERSCAN V2 API - CONTRACT SOURCE CODE FETCHER');
  console.log('='.repeat(80));

  try {
    const sourceCode = await getVerifiedSourceCode(contractAddress, chainId);

    if (sourceCode) {
      printSourceCodeInfo(sourceCode);

      if (saveToFile) {
        const outputPath = path.join(__dirname, `../../output/${contractAddress}_chain${chainId}_source.json`);
        const outputDir = path.dirname(outputPath);

        // Create output directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        saveSourceCodeToFile(sourceCode, outputPath);
      }

      process.exit(0);
    } else {
      console.log('\n✗ Failed to fetch source code');
      console.log('\nPossible reasons:');
      console.log('1. Contract is not verified on the blockchain explorer');
      console.log('2. Invalid contract address');
      console.log('3. Missing or invalid Etherscan API key (add ETHERSCAN_API_KEY to .env)');

      const explorerUrls: Record<number, string> = {
        1: `https://etherscan.io/address/${contractAddress}#code`,
        56: `https://bscscan.com/address/${contractAddress}#code`,
        97: `https://testnet.bscscan.com/address/${contractAddress}#code`,
        137: `https://polygonscan.com/address/${contractAddress}#code`,
        42161: `https://arbiscan.io/address/${contractAddress}#code`,
        10: `https://optimistic.etherscan.io/address/${contractAddress}#code`,
        8453: `https://basescan.org/address/${contractAddress}#code`,
      };

      const explorerUrl = explorerUrls[chainId];
      if (explorerUrl) {
        console.log(`\nView contract directly at: ${explorerUrl}`);
      }

      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Script execution failed');
    process.exit(1);
  }
}

// Run the script if executed directly
if (require.main === module) {
  main();
}

// Export for use as a module
export { getVerifiedSourceCode, printSourceCodeInfo, saveSourceCodeToFile };
