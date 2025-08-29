import Moralis from 'moralis';

// Format token balance
export function formatTokenBalance(balance: string, decimals: number): string {
	const balanceNum = parseFloat(balance) / Math.pow(10, decimals);
	if (balanceNum === 0) return '0';
	if (balanceNum < 0.000001) return '< 0.000001';
	if (balanceNum < 1) return balanceNum.toFixed(6);
	if (balanceNum < 1000) return balanceNum.toFixed(4);
	if (balanceNum < 1000000) return (balanceNum / 1000).toFixed(2) + 'K';
	return (balanceNum / 1000000).toFixed(2) + 'M';
}

// Get all tokens and prices
export async function getWalletTokensWithPrices(address: string) {
	const response = await Moralis.EvmApi.wallets.getWalletTokenBalancesPrice({
		chain: "0x38",
		address
	});
	return response.toJSON();
}

// Note: getTokenPrice function has been moved to tokenPriceCache.ts for optimized caching

// Note: getBNBPrice function has been moved to tokenPriceCache.ts for optimized caching