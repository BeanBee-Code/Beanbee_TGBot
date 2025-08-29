import { GoldRushClient } from "@covalenthq/client-sdk";
import { createLogger } from '../../utils/logger';

const moduleLogger = createLogger('opbnbService');

export class OpBNBService {
    private client: GoldRushClient;
    private chainName = "bnb-opbnb-mainnet";

    constructor() {
        const apiKey = process.env.GOLDRUSH_API_KEY;
        if (!apiKey) {
            throw new Error("GOLDRUSH_API_KEY is required");
        }
        this.client = new GoldRushClient(apiKey);
    }

    async getNativeBalance(walletAddress: string): Promise<{ balance: string; formatted: string; usdValue?: number }> {
        try {
            moduleLogger.info(`Fetching native BNB balance for ${walletAddress} on opBNB`);
            
            const resp = await this.client.BalanceService.getNativeTokenBalance(
                this.chainName as any,
                walletAddress
            );

            if (!resp.data || resp.error) {
                throw new Error(`Failed to fetch native balance: ${resp.error_message || 'Unknown error'}`);
            }

            // Native balance response has items array
            const nativeToken = resp.data.items?.[0];
            if (!nativeToken) {
                return {
                    balance: '0',
                    formatted: '0 BNB',
                    usdValue: 0
                };
            }

            const balance = String(nativeToken.balance || '0');
            const decimals = nativeToken.contract_decimals || 18;
            const formatted = this.formatBalance(balance, decimals);
            const usdValue = nativeToken.quote ?? undefined;

            return {
                balance,
                formatted: `${formatted} BNB`,
                usdValue
            };
        } catch (error) {
            moduleLogger.error('Error fetching native balance:', error);
            throw error;
        }
    }

    async getTokenBalances(walletAddress: string): Promise<any[]> {
        try {
            moduleLogger.info(`Fetching token balances for ${walletAddress} on opBNB`);
            
            const resp = await this.client.BalanceService.getTokenBalancesForWalletAddress(
                this.chainName as any,
                walletAddress,
                { nft: false }
            );

            if (!resp.data || resp.error) {
                throw new Error(`Failed to fetch token balances: ${resp.error_message || 'Unknown error'}`);
            }

            // Filter out native token and zero balances, then format
            const tokens = resp.data.items
                ?.filter((token: any) => 
                    token.balance && 
                    token.balance !== '0' && 
                    token.contract_address !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' &&
                    !token.native_token
                )
                ?.map((token: any) => {
                    let usdValue = token.quote;
                    
                    // Hardcoded USDT price for opBNB USDT token
                    if (token.contract_address?.toLowerCase() === '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3') {
                        const tokenBalance = parseFloat(this.formatBalance(String(token.balance), token.contract_decimals));
                        usdValue = tokenBalance * 1.0; // 1 USDT = 1 USD
                        moduleLogger.info(`Applied hardcoded USDT price: ${tokenBalance} USDT = $${usdValue}`);
                    }
                    
                    console.log(`Token ${token.contract_ticker_symbol}:`, {
                        balance: token.balance,
                        quote: token.quote,
                        usdValue: usdValue,
                        quoteType: typeof token.quote
                    });
                    
                    return {
                        contractAddress: token.contract_address,
                        name: token.contract_name,
                        symbol: token.contract_ticker_symbol,
                        decimals: token.contract_decimals,
                        balance: String(token.balance),
                        formatted: this.formatBalance(String(token.balance), token.contract_decimals),
                        usdValue: (usdValue && typeof usdValue === 'number' && !isNaN(usdValue)) ? usdValue : undefined,
                        logoUrl: token.logo_url
                    };
                }) || [];

            return tokens;
        } catch (error) {
            moduleLogger.error('Error fetching token balances:', error);
            throw error;
        }
    }

    async getTransactionHistory(walletAddress: string, limit: number = 10): Promise<any[]> {
        try {
            moduleLogger.info(`Fetching transaction history for ${walletAddress} on opBNB`);
            
            const resp = await this.client.TransactionService.getAllTransactionsForAddressByPage(
                this.chainName as any,
                walletAddress
            );

            if (!resp.data || resp.error) {
                throw new Error(`Failed to fetch transaction history: ${resp.error_message || 'Unknown error'}`);
            }

            const transactions = resp.data.items
                ?.slice(0, limit)
                ?.map((tx: any) => ({
                    hash: tx.tx_hash,
                    blockHeight: tx.block_height,
                    timestamp: tx.block_signed_at,
                    from: tx.from_address,
                    to: tx.to_address,
                    value: tx.value,
                    gasUsed: tx.gas_spent,
                    gasPrice: tx.gas_price,
                    successful: tx.successful,
                    fees: tx.fees_paid,
                    formattedValue: this.formatBalance(tx.value || '0', 18),
                    formattedFees: this.formatBalance(tx.fees_paid || '0', 18)
                })) || [];

            return transactions;
        } catch (error) {
            moduleLogger.error('Error fetching transaction history:', error);
            throw error;
        }
    }

    private formatBalance(balance: string, decimals: number): string {
        if (!balance || balance === '0') return '0';
        
        try {
            const divisor = BigInt(10 ** decimals);
            const balanceBigInt = BigInt(balance);
            const quotient = balanceBigInt / divisor;
            const remainder = balanceBigInt % divisor;
            
            if (remainder === 0n) {
                return quotient.toString();
            }
            
            // Show up to 6 decimal places
            const decimal = remainder.toString().padStart(decimals, '0');
            const trimmedDecimal = decimal.replace(/0+$/, '').slice(0, 6);
            
            if (trimmedDecimal === '') {
                return quotient.toString();
            }
            
            return `${quotient}.${trimmedDecimal}`;
        } catch (error) {
            moduleLogger.error('Error formatting balance:', error);
            return '0';
        }
    }

    formatDate(timestamp: string): string {
        return new Date(timestamp).toLocaleString();
    }

    shortenAddress(address: string): string {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
}

export const opbnbService = new OpBNBService();