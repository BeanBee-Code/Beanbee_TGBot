/**
 * Test script for ChainGPT Smart Contract Auditor
 *
 * Usage:
 *   npx tsx src/scripts/testChainGPTAudit.ts [contract_address]
 *
 * Example:
 *   npx tsx src/scripts/testChainGPTAudit.ts 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
 */

import { chainGPTAuditor } from '../services/chainGPT/smartContractAuditor';

async function main() {
  const contractAddress = process.argv[2] || '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
  const chainId = 56; // BSC

  console.log('\n='.repeat(80));
  console.log('CHAINGPT SMART CONTRACT AUDITOR TEST');
  console.log('='.repeat(80));
  console.log(`\nContract: ${contractAddress}`);
  console.log(`Chain ID: ${chainId} (BSC Mainnet)`);

  // Check if available
  if (!chainGPTAuditor.isAvailable()) {
    console.error('\n❌ ChainGPT API key not configured!');
    console.error('Please set CHAINGPT_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('\n✅ ChainGPT API key found');
  console.log('\n⏳ Starting audit (this may take 30-60 seconds)...\n');

  try {
    const startTime = Date.now();

    // Perform audit
    const result = await chainGPTAuditor.auditContractByAddress(contractAddress, chainId);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(80));
    console.log('AUDIT RESULT');
    console.log('='.repeat(80));
    console.log(`\nDuration: ${duration} seconds`);
    console.log(`Success: ${result.success}`);

    if (result.success) {
      console.log('\n' + '-'.repeat(80));
      console.log('SUMMARY');
      console.log('-'.repeat(80));
      console.log(result.summary || 'No summary available');

      console.log('\n' + '-'.repeat(80));
      console.log('FULL AUDIT REPORT');
      console.log('-'.repeat(80));
      console.log(result.auditReport);

      if (result.vulnerabilities) {
        console.log('\n' + '-'.repeat(80));
        console.log('VULNERABILITIES');
        console.log('-'.repeat(80));
        console.log(`Critical: ${result.vulnerabilities.critical.length}`);
        console.log(`High: ${result.vulnerabilities.high.length}`);
        console.log(`Medium: ${result.vulnerabilities.medium.length}`);
        console.log(`Low: ${result.vulnerabilities.low.length}`);
        console.log(`Informational: ${result.vulnerabilities.informational.length}`);
      }
    } else {
      console.log('\n❌ Audit failed!');
      console.log(`Error: ${result.error}`);
      process.exit(1);
    }

    console.log('\n' + '='.repeat(80) + '\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Unexpected error:');
    console.error(error);
    process.exit(1);
  }
}

main();
