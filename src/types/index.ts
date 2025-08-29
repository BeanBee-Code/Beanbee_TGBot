import SignClient from "@walletconnect/sign-client";

export interface UserSession {
	client?: SignClient;
	address?: string;
	provider?: 'walletconnect'; // Only WalletConnect supported now
	waitingForWalletInput?: boolean;
	waitingForWalletAddress?: boolean;
	waitingForTokenAddress?: boolean;
	waitingForName?: boolean;
	waitingForNameChange?: boolean;
	waitingForReferralCode?: boolean;
	skipNamePrompt?: boolean;
	onboardingLanguage?: 'en' | 'zh';
	pendingUri?: string;
	selectedWallet?: 'main' | 'trading' | 'both'; // For portfolio/yield queries
	customWalletAddress?: string; // For specific wallet address queries
	waitingForTokenSearchInput?: boolean; // For token search feature
	
	// Referral reward management state
	referralManagement?: {
		isWaitingForWithdrawAmount?: boolean;
		isWaitingForConvertAmount?: boolean;
	};

	trading?: {
		tokenAddress?: string;
		tokenInfo?: any;
		action?: 'buy' | 'sell';
		amount?: string;
		waitingForTokenInput?: boolean;
		waitingForAmountInput?: boolean;
		userBalance?: string;
	};
	rugAlerts?: {
		waitingForTokenInput?: boolean;
		lastAnalyzedToken?: string;
		lastAnalysis?: any; // Store the full analysis for switching between summary/details
	};
	transfer?: {
		waitingForAmountInput?: boolean;
		direction?: 'to_trading' | 'from_trading';
		backCallback?: string; // Store where user came from (e.g., 'honey_recharge', 'main_menu')
	};
	pendingTransfer?: {
		amount: string;
		direction: 'to_trading' | 'from_trading';
	};
	autoTradeSetup?: {
		waitingForInput?: 'entry_marketcap' | 'entry_price' | 'entry_amount' | 'take_profit' | 'stop_loss';
		tokenAddress?: string;
		targetMarketCap?: number; // Deprecated: kept for backwards compatibility
		targetPrice?: number; // New: target price for entry rules
	};
	opbnb?: {
		waitingForNativeBalanceAddress?: boolean;
		waitingForTokenBalancesAddress?: boolean;
		waitingForTransactionHistoryAddress?: boolean;
		currentAddress?: string; // Store the last queried address for opBNB
	};
	waitingForOpbnbAddress?: boolean; // For main opBNB scanner input
	waitingForOpbnbTokenAddress?: boolean; // For opBNB token analysis input
	waitingForOpbnbWhaleToken?: boolean; // For opBNB whale tracker token input
	waitingForOpbnbHealthToken?: boolean; // For opBNB health check token input
	opbnbAction?: 'scan' | 'native' | 'tokens' | 'history' | 'holdings' | 'transactions'; // Track what action to perform
	opbnbLastScanned?: string; // Store the last scanned address for detailed views
}

declare global {
	var userSessions: Map<number, UserSession>;
}