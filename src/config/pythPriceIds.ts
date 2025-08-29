/**
 * Pyth Network Price Feed IDs for BSC tokens
 * 
 * Price feed IDs can be found at:
 * https://pyth.network/developers/price-feed-ids
 * 
 * Note: These are the mainnet price IDs. Pyth provides the same price feeds
 * across all supported chains.
 */

export interface PythPriceMapping {
  address: string;  // Token contract address on BSC (lowercase)
  priceId: string;  // Pyth price feed ID (with 0x prefix)
  symbol: string;   // Token symbol for reference
}

// Common BSC token addresses to Pyth price feed IDs mapping
// These IDs are fetched from https://hermes.pyth.network/v2/price_feeds
// Note: Only include tokens that actually exist on BSC with these addresses
// Price IDs are from Pyth Network's Hermes API v2
export const BSC_PYTH_PRICE_MAPPINGS: PythPriceMapping[] = [
  {
    address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    priceId: '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
    symbol: 'WBNB'  // Maps to Crypto.BNB/USD
  },
  {
    address: '0x55d398326f99059ff775485246999027b3197955',
    priceId: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    symbol: 'USDT'  // Crypto.USDT/USD
  },
  {
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    priceId: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    symbol: 'USDC'  // Crypto.USDC/USD
  },
  // BUSD is deprecated and has no active Pyth feed
  // { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', symbol: 'BUSD' },
  {
    address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
    priceId: '0x2356af9529a1064d41e32d617e2ce1dca5733afa901daba9e2b68dee5d53ecf9',
    symbol: 'CAKE'  // Maps to Crypto.CAKE/USD
  },
  {
    address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    priceId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    symbol: 'ETH'  // Crypto.ETH/USD
  },
  {
    address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    priceId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    symbol: 'BTCB'  // Crypto.BTC/USD
  },
  {
    address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe',
    priceId: '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
    symbol: 'XRP'  // Crypto.XRP/USD
  },
  {
    address: '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47',
    priceId: '0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d',
    symbol: 'ADA'  // Crypto.ADA/USD
  },
  {
    address: '0xba2ae424d960c26247dd6c32edc70b295c744c43',
    priceId: '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
    symbol: 'DOGE'  // Crypto.DOGE/USD
  },
  {
    address: '0x0d8ce2a99bb6e3b7db580ed848240e4a0f9ae153',
    priceId: '0x150ac9b959aee0051e4091f0ef5216d941f590e1c5e7f91cf7635b5c11628c0e',
    symbol: 'FIL'  // Crypto.FIL/USD
  },
  {
    address: '0xb86abcb37c3a4b64f74f59301aff131a1becc787',
    priceId: '0x609722f3b6dc10fee07907fe86781d55eb9121cd0705b480954c00695d78f0cb',
    symbol: 'ZIL'  // Crypto.ZIL/USD
  },
  {
    address: '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd',
    priceId: '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
    symbol: 'LINK'  // Crypto.LINK/USD
  },
  {
    address: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94',
    priceId: '0x6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54',
    symbol: 'LTC'  // Crypto.LTC/USD
  },
  {
    address: '0xcc42724c6683b7e57334c4e856f4c9965ed682bd',
    priceId: '0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472',
    symbol: 'MATIC'  // Crypto.POL/USD (MATIC rebranded to POL)
  },
  {
    address: '0x8ff795a6f4d97e7887c79bea79aba5cc76444adf',
    priceId: '0x3dd2b63686a450ec7290df3a1e0b583c0481f651351edfa7636f39aed55cf8a3',
    symbol: 'BCH'  // Crypto.BCH/USD
  },
  {
    address: '0x16939ef78684453bfdfb47825f8a5f714f12623a',
    priceId: '0x0affd4b8ad136a21d79bc82450a325ee12ff55a235abc242666e423b8bcffd03',
    symbol: 'XTZ'  // Crypto.XTZ/USD
  },
  {
    address: '0xbf5140a22578168fd562dccf235e5d43a02ce9b1',
    priceId: '0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501',
    symbol: 'UNI'  // Crypto.UNI/USD
  },
  {
    address: '0xfb6115445bff7b52feb98650c87f44907e58f802',
    priceId: '0x2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445',
    symbol: 'AAVE'  // Crypto.AAVE/USD
  },
  // VAI doesn't have its own Pyth feed
  // { address: '0x4bd17003473389a42daf6a0a729f6fdb328bbbd7', symbol: 'VAI' }
];

// Create a map for quick lookups
export const ADDRESS_TO_PRICE_ID_MAP: Record<string, string> = BSC_PYTH_PRICE_MAPPINGS.reduce(
  (acc, mapping) => {
    acc[mapping.address] = mapping.priceId;
    return acc;
  },
  {} as Record<string, string>
);

// Helper function to get price ID by token address
export function getPythPriceId(tokenAddress: string): string | undefined {
  return ADDRESS_TO_PRICE_ID_MAP[tokenAddress.toLowerCase()];
}

// Helper function to check if we have a Pyth price feed for a token
export function hasPythPriceFeed(tokenAddress: string): boolean {
  return ADDRESS_TO_PRICE_ID_MAP.hasOwnProperty(tokenAddress.toLowerCase());
}