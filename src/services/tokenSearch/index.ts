import { ethers } from 'ethers';
import Moralis from 'moralis';
import { createLogger } from '../../utils/logger';
import { PancakeSwapTrader } from '../pancakeswap';
import { formatUSDValue } from '../wallet/balance';
import { DexScreenerService, DexScreenerTokenInfo } from './dexScreenerService';
import { t, Language } from '@/i18n';

const logger = createLogger('tokenSearch');

export interface TokenSearchResult {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  price?: number;
  priceChange24h?: number;
  marketCap?: number;
  volume24h?: number;
  logo?: string;
  verified?: boolean;
}

export class TokenSearchService {
  private trader: PancakeSwapTrader;
  private provider: ethers.JsonRpcProvider;
  private dexScreener: DexScreenerService;
  private moralisApiKey?: string;

  constructor(moralisApiKey?: string) {
    this.trader = new PancakeSwapTrader();
    this.provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
    this.dexScreener = new DexScreenerService(); // DexScreener doesn't need API key
    this.moralisApiKey = moralisApiKey;

    // Initialize Moralis if API key is provided
    if (moralisApiKey && !Moralis.Core.isStarted) {
      Moralis.start({ apiKey: moralisApiKey }).catch(error => {
        logger.error('Failed to initialize Moralis', { error });
      });
    }
  }

  /**
   * Search for tokens using DexScreener API
   */
  async searchTokens(query: string): Promise<TokenSearchResult[]> {
    try {
      const searchTerm = query.toLowerCase().trim();
      
      // First, check if it's a valid BSC address
      if (ethers.isAddress(searchTerm)) {
        const tokenInfo = await this.getTokenByAddress(searchTerm);
        return tokenInfo ? [tokenInfo] : [];
      }

      // Search using DexScreener API
      const dexResults = await this.dexScreener.searchBscTokens(query);
      
      // Convert DexScreener results to our format
      const results: TokenSearchResult[] = [];
      
      for (const dexToken of dexResults.slice(0, 10)) {
        try {
          // Get additional token info from blockchain
          const tokenInfo = await this.getTokenByAddress(dexToken.address);
          
          if (tokenInfo) {
            // Merge DexScreener data with blockchain data
            tokenInfo.price = dexToken.priceUsd || tokenInfo.price;
            tokenInfo.priceChange24h = dexToken.priceChange24h || tokenInfo.priceChange24h;
            tokenInfo.volume24h = dexToken.volume24h;
            tokenInfo.marketCap = dexToken.marketCap;
            tokenInfo.logo = dexToken.logoURI || tokenInfo.logo;
            tokenInfo.verified = !!(dexToken.liquidity && dexToken.liquidity > 10000); // Consider verified if has good liquidity
            results.push(tokenInfo);
          } else {
            // If we can't get blockchain data, use DexScreener data directly
            results.push({
              address: dexToken.address,
              name: dexToken.name,
              symbol: dexToken.symbol,
              decimals: dexToken.decimals || 18,
              price: dexToken.priceUsd,
              priceChange24h: dexToken.priceChange24h,
              marketCap: dexToken.marketCap,
              volume24h: dexToken.volume24h,
              logo: dexToken.logoURI,
              verified: !!(dexToken.liquidity && dexToken.liquidity > 10000)
            });
          }
        } catch (error) {
          logger.error('Error processing token', { 
            token: dexToken,
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }

      // If no results found, try to get popular tokens
      if (results.length === 0) {
        const popularTokens = await this.dexScreener.getPopularBscTokens();
        const filteredPopular = popularTokens
          .filter(token => 
            token.symbol.toLowerCase().includes(searchTerm) ||
            token.name.toLowerCase().includes(searchTerm)
          )
          .slice(0, 5);
        
        for (const token of filteredPopular) {
          results.push({
            address: token.address,
            name: token.name,
            symbol: token.symbol,
            decimals: 18,
            price: token.priceUsd,
            priceChange24h: token.priceChange24h,
            marketCap: token.marketCap,
            volume24h: token.volume24h,
            logo: token.logoURI,
            verified: !!(token.liquidity && token.liquidity > 10000)
          });
        }
      }

      return results;
    } catch (error) {
      logger.error('Error searching tokens', { 
        query,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Get detailed token information by address
   */
  async getTokenByAddress(address: string): Promise<TokenSearchResult | null> {
    try {
      // Validate address
      if (!ethers.isAddress(address)) {
        return null;
      }

      // Get basic token info from contract
      const tokenInfo = await this.trader.getTokenInfo(address);
      if (!tokenInfo) {
        return null;
      }

      // Try to get additional data from DexScreener first
      let dexData = null;
      try {
        dexData = await this.dexScreener.getTokenDetailsByAddress(address);
      } catch (error) {
        logger.warn('Could not fetch data from DexScreener', { address, error });
      }

      // Try to get price and additional data from Moralis as fallback
      let priceData = null;
      let logo = undefined;
      
      try {
        if (this.moralisApiKey && !dexData) {
          const response = await Moralis.EvmApi.token.getTokenPrice({
            chain: "0x38", // BSC
            address: address
          });
          
          priceData = response.result;
          
          // Get token metadata for logo
          const metadataResponse = await Moralis.EvmApi.token.getTokenMetadata({
            chain: "0x38",
            addresses: [address]
          });
          
          if (metadataResponse.result.length > 0) {
            const metadata = metadataResponse.result[0];
            logo = (metadata as any).logo || (metadata as any).thumbnail || undefined;
          }
        }
      } catch (error) {
        logger.warn('Could not fetch price data from Moralis', { 
          address,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Prefer DexScreener data if available
      if (dexData) {
        return {
          address: tokenInfo.address,
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          price: dexData.priceUsd,
          priceChange24h: dexData.priceChange24h,
          marketCap: dexData.marketCap,
          volume24h: dexData.volume24h,
          logo: dexData.logoURI || logo,
          verified: !!(dexData.liquidity && dexData.liquidity > 10000)
        };
      }

      // Fallback to Moralis data
      return {
        address: tokenInfo.address,
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        price: priceData?.usdPrice || undefined,
        priceChange24h: priceData?.['24hrPercentChange'] ? parseFloat(priceData['24hrPercentChange']) : undefined,
        logo: logo,
        verified: false
      };
    } catch (error) {
      logger.error('Error getting token by address', { 
        address,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Format token details for display
   */
  formatTokenDetails(token: TokenSearchResult, lang: Language = 'en'): string {
    const lines = [
      `🪙 **${token.name} (${token.symbol})**`,
      '',
    ];

    if (token.address) {
      lines.push(`📍 **Address:** \`${token.address}\``);
    }
    
    lines.push(`🔢 **Decimals:** ${token.decimals}`);

    if (token.price !== undefined) {
      lines.push(`💰 **Price:** ${formatUSDValue(token.price)}`);
      
      if (token.priceChange24h !== undefined) {
        const emoji = token.priceChange24h >= 0 ? '📈' : '📉';
        const changeStr = token.priceChange24h >= 0 ? `+${token.priceChange24h.toFixed(2)}%` : `${token.priceChange24h.toFixed(2)}%`;
        lines.push(`${emoji} **24h Change:** ${changeStr}`);
      }
    }

    if (token.marketCap) {
      lines.push(`📊 **Market Cap:** ${formatUSDValue(token.marketCap)} ${t(lang, 'common.bscLabel')}`);
    }

    if (token.volume24h) {
      lines.push(`📊 **24h Volume:** ${formatUSDValue(token.volume24h)}`);
    }

    if (token.verified) {
      lines.push('✅ **Verified Token**');
    }
    
    lines.push(`\n_${t(lang, 'tokenSearch.bscOnlyDisclaimer')}_`);

    return lines.join('\n');
  }

  /**
   * Format search results for display
   */
  formatSearchResults(results: TokenSearchResult[], lang: Language = 'en', query?: string): string {
    if (results.length === 0) {
      return query ? `❌ No tokens found matching "${query}".` : '❌ No tokens found matching your search.';
    }

    const lines = query ? 
      [`🔍 **Token Search Results for "${query}"**`, `Found ${results.length} tokens:`, ''] :
      [`🔍 **Token Search Results** (${results.length} found)`, ''];
      
    lines.push(`_${t(lang, 'tokenSearch.bscOnlyDisclaimer')}_\n`);

    results.forEach((token, index) => {
      // Use formatUSDValue for consistent formatting
      const price = token.price !== undefined ? formatUSDValue(token.price) : 'N/A';
      const priceChange = token.priceChange24h !== undefined ? `${token.priceChange24h.toFixed(2)}%` : 'N/A';
      const priceChangeEmoji = token.priceChange24h !== undefined ? (token.priceChange24h >= 0 ? '📈' : '📉') : '📊';
      const marketCap = token.marketCap !== undefined ? formatUSDValue(token.marketCap) : 'N/A';
      const category = (token as any).category || 
        (token.marketCap && token.marketCap > 10000000 ? 'Large Cap' :
         token.marketCap && token.marketCap > 1000000 ? 'Mid Cap' :
         token.marketCap && token.marketCap > 100000 ? 'Small Cap' : 'Micro Cap');
      const verified = token.verified ? '✅' : '';

      lines.push(`${index + 1}. **${token.symbol}** - ${token.name} ${verified}`);
      lines.push(`   💰 Price: ${price}`);
      lines.push(`   ${priceChangeEmoji} 24h: ${priceChange}`);
      lines.push(`   📊 Market Cap: ${marketCap} ${t(lang, 'common.bscLabel')} (${category})`);
      lines.push(`   📍 Address: \`${token.address}\``);
      if (index < results.length - 1) {
        lines.push('');
      }
    });

    return lines.join('\n');
  }
}