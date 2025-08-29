import { TokenSearchService } from '../../services/tokenSearch';

async function testDexScreenerSearch() {
  const service = new TokenSearchService();
  
  console.log('Testing DexScreener token search...\n');
  
  const queries = ['usd', 'bnb', 'cake', 'baby', 'doge', 'shiba'];
  
  for (const query of queries) {
    console.log(`\n=== Searching for "${query}" ===`);
    try {
      const results = await service.searchTokens(query);
      console.log(`Found ${results.length} results:`);
      
      results.slice(0, 5).forEach((token, index) => {
        console.log(`${index + 1}. ${token.symbol} - ${token.name}`);
        console.log(`   Address: ${token.address}`);
        console.log(`   Price: $${token.price || 'N/A'}`);
        console.log(`   24h Change: ${token.priceChange24h ? token.priceChange24h.toFixed(2) + '%' : 'N/A'}`);
        console.log(`   Volume 24h: $${token.volume24h?.toLocaleString() || 'N/A'}`);
        console.log(`   Verified: ${token.verified ? 'Yes' : 'No'}`);
      });
    } catch (error) {
      console.error(`Error searching for ${query}:`, error);
    }
  }
  
  // Test searching by address
  console.log('\n=== Testing search by address ===');
  const testAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'; // CAKE token
  try {
    const results = await service.searchTokens(testAddress);
    console.log(`Found ${results.length} result(s) for address ${testAddress}`);
    if (results.length > 0) {
      console.log(`Token: ${results[0].symbol} - ${results[0].name}`);
      console.log(`Price: $${results[0].price || 'N/A'}`);
    }
  } catch (error) {
    console.error('Error searching by address:', error);
  }
}

testDexScreenerSearch().catch(console.error);