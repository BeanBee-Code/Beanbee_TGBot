import { ethers } from 'ethers';
import Moralis from 'moralis';
import { getCachedTokenPrice } from '../wallet/tokenPriceCache';
import { EnhancedStakingPosition } from './enhancedDetection';
import { createLogger } from '@/utils/logger';

const logger = createLogger('staking.transactionAnalyzer');

/**
 * Transaction-based DeFi Detection
 * Analyzes transaction details from approvals to find liquidity operations
 */

export interface DeFiOperation {
    type: 'LiquidityAdd' | 'Staking' | 'TokenSwap' | 'NFTMint' | 'Unknown';
    protocol: string;
    transactionHash: string;
    timestamp: string;
    tokens: Array<{
        address: string;
        symbol: string;
        amount: string;
        amountFormatted: string;
        direction: 'in' | 'out';
    }>;
    nfts?: Array<{
        contract: string;
        tokenIds: string[];
        isLPNFT: boolean;
    }>;
    poolInfo?: {
        token0: string;
        token1: string;
        fee?: number;
    };
    details: {
        summary: string;
        gasUsed: string;
        gasPrice: string;
        txFee: string;
    };
    veCAKEInfo?: {
        amount: string;
        unlockTime: Date;
    };
}

// Known token addresses on BSC
const TOKEN_INFO: { [address: string]: { symbol: string; decimals: number } } = {
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { symbol: 'ETH', decimals: 18 },
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': { symbol: 'CAKE', decimals: 18 },
};

// Event signatures
const EVENT_SIGNATURES = {
    ERC20_TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    ERC20_APPROVAL: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    NFT_TRANSFER_BATCH: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
    PANCAKE_V3_MINT: "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
    PANCAKE_INCREASE_LIQUIDITY: "0x4db17dd5e4732fb6da34a148104a592783ca119a1e7bb8829eba6cbadef0b511",
    VECAKE_DEPOSIT: "0x7162984403f6c73c8639375d45a9187dfd04602231bd8e587c415718b5f7e5f9", // veCAKE Deposit event
};

// PancakeSwap V3 contracts
const PANCAKESWAP_V3_CONTRACTS = [
    '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', // V3 Position Manager
    '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9', // V3 SwapRouter
    '0x3d311d6283dd8ab90bb0031835c8e606349e2850', // Another V3 contract (from your transaction)
];

// veCAKE contract
const PANCAKESWAP_VECAKE = '0x5692db8177a81a6c6afc8084c2976c9933ec1bab';
const CAKE_TOKEN = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';

/**
 * Get transaction details using Moralis SDK
 */
export async function getTransactionDetails(transactionHash: string): Promise<any> {
    try {
        // Ensure Moralis is initialized
        if (!Moralis.Core.isStarted) {
            await Moralis.start({
                apiKey: process.env.MORALIS_API_KEY!
            });
        }
        
        const response = await Moralis.EvmApi.transaction.getTransaction({
            chain: '0x38', // BSC chain
            transactionHash: transactionHash
        });
        
        if (!response) {
            throw new Error(`No response received for transaction ${transactionHash}`);
        }
        
        return response.toJSON();
    } catch (error) {
        logger.error('Failed to get transaction details', { transactionHash, error });
        throw error;
    }
}

/**
 * Parse ERC20 transfer event
 */
function parseERC20Transfer(log: any, walletAddress: string): DeFiOperation['tokens'][0] | null {
    try {
        if (!log.topic1 || !log.topic2 || !log.data) return null;
        
        const from = "0x" + log.topic1.slice(26).toLowerCase();
        const to = "0x" + log.topic2.slice(26).toLowerCase();
        const amount = log.data;
        
        const tokenInfo = TOKEN_INFO[log.address.toLowerCase()];
        const decimals = tokenInfo?.decimals || 18;
        const symbol = tokenInfo?.symbol || 'Unknown';
        
        let amountFormatted = '0';
        try {
            amountFormatted = ethers.formatUnits(amount, decimals);
        } catch (e) {
            logger.debug('Failed to format amount', { error: e, amount, decimals });
        }
        
        // Determine direction based on wallet address
        const walletLower = walletAddress.toLowerCase();
        let direction: 'in' | 'out' = 'out';
        
        if (to === walletLower) {
            direction = 'in';
        } else if (from === walletLower) {
            direction = 'out';
        } else if (from === '0x0000000000000000000000000000000000000000') {
            // Minting - usually means receiving LP tokens
            direction = 'in';
        }
        
        return {
            address: log.address,
            symbol,
            amount,
            amountFormatted,
            direction
        };
    } catch (error) {
        logger.debug('Failed to parse ERC20 transfer', { error, logAddress: log?.address });
        return null;
    }
}

/**
 * Parse NFT event (usually LP NFT)
 */
function parseNFTEvent(log: any): { contract: string; tokenIds: string[]; isLPNFT: boolean } | null {
    try {
        const isLPNFT = PANCAKESWAP_V3_CONTRACTS.some(
            contract => contract.toLowerCase() === log.address.toLowerCase()
        );
        
        return {
            contract: log.address,
            tokenIds: ['1'], // Simplified - would need to parse from data
            isLPNFT
        };
    } catch (error) {
        logger.debug('Failed to parse NFT event', { error, logAddress: log?.address });
        return null;
    }
}

/**
 * Parse veCAKE deposit event to extract amount and unlock time
 */
function parseVeCAKEDeposit(log: any): { amount: string; unlockTime: Date } | null {
    try {
        // veCAKE Deposit event structure:
        // event Deposit(address indexed provider, uint256 value, uint256 indexed locktime, int128 type, uint256 ts)
        // topic0: event signature
        // topic1: provider address (indexed)
        // topic2: locktime (indexed)
        // data: contains [value, type, ts] - each 32 bytes
        
        if (!log.topic2 || !log.data) {
            logger.debug('Missing topic2 or data in veCAKE deposit log', { log });
            return null;
        }
        
        // Parse unlock time from topic2 (it's indexed so it's in topics)
        const unlockTimestamp = parseInt(log.topic2, 16);
        const unlockTime = new Date(unlockTimestamp * 1000);
        
        // Parse amount from data
        // The data contains: value (32 bytes), type (32 bytes), ts (32 bytes)
        const dataWithoutPrefix = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
        
        // Each value in data is 64 characters (32 bytes in hex)
        if (dataWithoutPrefix.length >= 64) {
            // First 64 chars (32 bytes) is the value/amount
            const amountHex = '0x' + dataWithoutPrefix.slice(0, 64);
            const amount = ethers.getBigInt(amountHex).toString();
            
            logger.info('Parsed veCAKE deposit', { amount, unlockTime: unlockTime.toISOString() });
            
            return {
                amount,
                unlockTime
            };
        } else {
            logger.debug('Data too short for veCAKE deposit', { dataLength: dataWithoutPrefix.length, expectedLength: 64 });
        }
        
        return null;
    } catch (error) {
        logger.debug('Failed to parse veCAKE deposit', { error });
        return null;
    }
}

/**
 * Analyze transaction logs to identify DeFi operations
 */
export function analyzeTransactionLogs(txData: any, walletAddress: string): DeFiOperation {
    const logs = txData.logs || [];
    const tokens: DeFiOperation['tokens'] = [];
    const nfts: DeFiOperation['nfts'] = [];
    let operationType: DeFiOperation['type'] = 'Unknown';
    let protocol = 'Unknown';
    let veCAKEInfo: { amount: string; unlockTime: Date } | undefined;
    
    // Check if it's a PancakeSwap V3 transaction
    if (txData.to_address && PANCAKESWAP_V3_CONTRACTS.includes(txData.to_address.toLowerCase())) {
        protocol = 'PancakeSwap V3';
    }
    
    // Check if it's a veCAKE transaction
    if (txData.to_address && txData.to_address.toLowerCase() === PANCAKESWAP_VECAKE.toLowerCase()) {
        protocol = 'PancakeSwap veCAKE';
        logger.info('🥞 Detected veCAKE transaction', { contractAddress: txData.to_address });
    }
    
    // Also check if any log is from veCAKE contract
    const hasVeCAKELog = logs.some((log: any) => 
        log.address && log.address.toLowerCase() === PANCAKESWAP_VECAKE.toLowerCase()
    );
    if (hasVeCAKELog && protocol === 'Unknown') {
        protocol = 'PancakeSwap veCAKE';
        logger.info('🥞 Detected veCAKE from log addresses', { protocol });
    }
    
    // Check for native BNB transfer
    if (txData.value && txData.value !== '0') {
        try {
            const bnbAmount = ethers.formatEther(txData.value);
            if (parseFloat(bnbAmount) > 0) {
                tokens.push({
                    address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB address
                    symbol: 'BNB',
                    amount: txData.value,
                    amountFormatted: bnbAmount,
                    direction: 'out' // Native BNB sent to contract
                });
            }
        } catch (e) {
            logger.debug('Failed to parse BNB value', { error: e, value: txData.value });
        }
    }
    
    // Check for specific event signatures that indicate liquidity operations
    const hasLiquidityEvents = logs.some((log: any) => 
        log.topic0 === '0x7b6bc49b385af8644341f07a67cd976bf9daf2bdd5d71668e651a3a792e318e1' || // NFT mint
        log.topic0 === '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' || // ERC1155 TransferBatch
        log.topic0 === '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec'    // Another liquidity event
    );
    
    // Analyze each log
    for (const log of logs) {
        const eventSig = log.topic0;
        
        switch (eventSig) {
            case EVENT_SIGNATURES.ERC20_TRANSFER:
                const tokenTransfer = parseERC20Transfer(log, walletAddress);
                if (tokenTransfer) {
                    tokens.push(tokenTransfer);
                }
                break;
                
            case EVENT_SIGNATURES.NFT_TRANSFER_BATCH:
            case EVENT_SIGNATURES.PANCAKE_V3_MINT:
            case '0x7b6bc49b385af8644341f07a67cd976bf9daf2bdd5d71668e651a3a792e318e1': // Additional NFT mint signature
            case '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb': // ERC1155 TransferBatch
                const nftInfo = parseNFTEvent(log);
                if (nftInfo) {
                    nfts.push(nftInfo);
                    operationType = 'LiquidityAdd';
                    if (protocol === 'Unknown') {
                        protocol = 'PancakeSwap V3';
                    }
                }
                break;
                
            case EVENT_SIGNATURES.PANCAKE_INCREASE_LIQUIDITY:
            case '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec': // Another liquidity signature
                operationType = 'LiquidityAdd';
                if (protocol === 'Unknown') {
                    protocol = 'PancakeSwap V3';
                }
                break;
                
            case EVENT_SIGNATURES.VECAKE_DEPOSIT:
            case '0x7162984403f6c73c8639375d45a9187dfd04602231bd8e587c415718b5f7e5f9': // Generic staking deposit
                logger.info('Found veCAKE deposit event', { 
                    transactionHash: txData.hash,
                    eventLog: log 
                });
                
                // Parse staking deposit
                const depositInfo = parseVeCAKEDeposit(log);
                if (depositInfo) {
                    veCAKEInfo = depositInfo;
                    operationType = 'Staking';
                    protocol = 'PancakeSwap veCAKE'; // Set protocol for veCAKE
                    logger.info('Parsed veCAKE info', { 
                        amountWei: depositInfo.amount, 
                        unlockTime: depositInfo.unlockTime.toISOString() 
                    });
                } else {
                    logger.debug('Failed to parse veCAKE deposit info from event', { log });
                }
                break;
        }
    }
    
    // If we have liquidity events and tokens, it's definitely a liquidity add
    if (hasLiquidityEvents && tokens.length > 0) {
        operationType = 'LiquidityAdd';
        if (protocol === 'Unknown') {
            protocol = 'PancakeSwap V3';
        }
    }
    
    // Determine operation type based on patterns
    if (operationType === 'Unknown') {
        const outTokens = tokens.filter(t => t.direction === 'out');
        const inTokens = tokens.filter(t => t.direction === 'in');
        
        if (outTokens.length >= 2 && (nfts.length > 0 || protocol.includes('PancakeSwap'))) {
            // Multiple tokens out + NFT or PancakeSwap = Liquidity Add
            operationType = 'LiquidityAdd';
        } else if (outTokens.length === 1 && inTokens.length === 0) {
            // Single token out, nothing in = Staking
            operationType = 'Staking';
        } else if (outTokens.length >= 1 && inTokens.length >= 1) {
            // Tokens in and out = Swap
            operationType = 'TokenSwap';
        }
    }
    
    // Generate summary
    let summary = '';
    if (operationType === 'LiquidityAdd') {
        const outTokensList = tokens
            .filter(t => t.direction === 'out')
            .map(t => `${t.amountFormatted} ${t.symbol}`)
            .join(' + ');
        summary = `Added liquidity: ${outTokensList}`;
        if (nfts.length > 0) {
            summary += ` → Received LP NFT`;
        }
    } else if (operationType === 'Staking') {
        if (veCAKEInfo) {
            // For veCAKE, use the amount from the event
            const cakeAmount = ethers.formatUnits(veCAKEInfo.amount, 18);
            summary = `Staked ${cakeAmount} CAKE in veCAKE`;
        } else {
            const stakedToken = tokens.find(t => t.direction === 'out');
            if (stakedToken) {
                summary = `Staked ${stakedToken.amountFormatted} ${stakedToken.symbol}`;
            }
        }
    } else if (operationType === 'TokenSwap') {
        const inToken = tokens.find(t => t.direction === 'in');
        const outToken = tokens.find(t => t.direction === 'out');
        if (inToken && outToken) {
            summary = `Swapped ${outToken.amountFormatted} ${outToken.symbol} → ${inToken.amountFormatted} ${inToken.symbol}`;
        }
    }
    
    return {
        type: operationType,
        protocol,
        transactionHash: txData.hash,
        timestamp: txData.block_timestamp,
        tokens,
        nfts: nfts.length > 0 ? nfts : undefined,
        details: {
            summary: summary || `${protocol} ${operationType}`,
            gasUsed: txData.receipt_gas_used || '0',
            gasPrice: txData.gas_price || '0',
            txFee: txData.transaction_fee || '0'
        },
        veCAKEInfo
    };
}

/**
 * Convert DeFi operations to staking positions
 */
export async function convertOperationsToPositions(operations: DeFiOperation[]): Promise<EnhancedStakingPosition[]> {
    const positions: EnhancedStakingPosition[] = [];
    
    for (const op of operations) {
        if (op.type === 'LiquidityAdd') {
            // Calculate total USD value
            let totalUsdValue = 0;
            const tokenDetails: string[] = [];
            
            for (const token of op.tokens.filter(t => t.direction === 'out')) {
                const price = await getCachedTokenPrice(token.address);
                const usdValue = parseFloat(token.amountFormatted) * (price || 0);
                totalUsdValue += usdValue;
                tokenDetails.push(`${token.symbol}`);
            }
            
            // Create LP position
            const lpSymbol = tokenDetails.join('-') + ' LP';
            
            positions.push({
                protocol: op.protocol,
                protocolLogo: op.protocol.includes('PancakeSwap') ? '🥞' : '💎',
                tokenSymbol: lpSymbol,
                tokenAddress: op.nfts?.[0]?.contract || '',
                stakedAmount: '1', // LP NFT
                stakedAmountFormatted: '1 LP NFT',
                usdValue: totalUsdValue,
                isLPToken: true,
                contractAddress: op.nfts?.[0]?.contract || '',
                transactionHash: op.transactionHash,
                approvalTimestamp: op.timestamp
            });
        } else if (op.type === 'Staking') {
            // Handle staking with specific amount and unlock time from events
            if (op.veCAKEInfo) {
                // Find the staked token from the transaction
                const stakedToken = op.tokens.find(t => t.direction === 'out') || op.tokens[0];
                
                if (stakedToken || op.protocol.includes('veCAKE')) {
                    // For veCAKE, the amount comes from the event data
                    const amount = ethers.formatUnits(op.veCAKEInfo.amount, 18);
                    
                    // Use CAKE token address for veCAKE positions
                    const tokenAddress = stakedToken?.address || CAKE_TOKEN;
                    const tokenSymbol = stakedToken?.symbol || 'CAKE';
                    
                    const price = await getCachedTokenPrice(tokenAddress);
                    const usdValue = parseFloat(amount) * (price || 0);
                    
                    logger.info('Creating veCAKE position', { 
                        amount: `${amount} CAKE`, 
                        usdValue: `$${usdValue}`, 
                        unlockTime: op.veCAKEInfo.unlockTime.toISOString() 
                    });
                    
                    // Determine protocol name and logo
                    let protocol = op.protocol;
                    let protocolLogo = '⭐';
                    
                    // Always use PancakeSwap veCAKE for veCAKE positions
                    if (protocol === 'Unknown' || !protocol || protocol === 'Unknown Protocol') {
                        protocol = 'PancakeSwap veCAKE';
                        protocolLogo = '🥞';
                    } else if (protocol.includes('PancakeSwap')) {
                        protocolLogo = '🥞';
                        // Ensure veCAKE positions have the correct protocol name
                        if (op.veCAKEInfo) {
                            protocol = 'PancakeSwap veCAKE';
                        }
                    } else if (protocol.includes('Venus')) {
                        protocolLogo = '💎';
                    } else if (protocol.includes('Alpaca')) {
                        protocolLogo = '🦙';
                    }
                    
                    positions.push({
                        protocol,
                        protocolLogo,
                        tokenSymbol,
                        tokenAddress,
                        stakedAmount: op.veCAKEInfo.amount,
                        stakedAmountFormatted: amount,
                        usdValue: usdValue,
                        unlockTime: op.veCAKEInfo.unlockTime,
                        isLPToken: false,
                        contractAddress: PANCAKESWAP_VECAKE,
                        transactionHash: op.transactionHash,
                        approvalTimestamp: op.timestamp
                    });
                }
            } else {
                // Regular staking without lock info
                const stakedToken = op.tokens.find(t => t.direction === 'out');
                if (stakedToken) {
                    const price = await getCachedTokenPrice(stakedToken.address);
                    const usdValue = parseFloat(stakedToken.amountFormatted) * (price || 0);
                    
                    // Determine protocol logo
                    let protocolLogo = '⭐';
                    if (op.protocol.includes('PancakeSwap')) protocolLogo = '🥞';
                    else if (op.protocol.includes('Venus')) protocolLogo = '💎';
                    else if (op.protocol.includes('Alpaca')) protocolLogo = '🦙';
                    
                    positions.push({
                        protocol: op.protocol,
                        protocolLogo,
                        tokenSymbol: stakedToken.symbol,
                        tokenAddress: stakedToken.address,
                        stakedAmount: stakedToken.amount,
                        stakedAmountFormatted: stakedToken.amountFormatted,
                        usdValue: usdValue,
                        isLPToken: false,
                        transactionHash: op.transactionHash,
                        approvalTimestamp: op.timestamp
                    });
                }
            }
        }
    }
    
    return positions;
}

/**
 * Analyze approvals with transaction details
 */
export async function analyzeApprovalsWithTransactions(
    walletAddress: string,
    approvals: any[]
): Promise<EnhancedStakingPosition[]> {
    logger.info('🔍 Analyzing transaction details for approvals', { 
        walletAddress, 
        approvalCount: approvals.length 
    });
    
    const operations: DeFiOperation[] = [];
    
    // Limit to recent approvals to avoid rate limits
    const recentApprovals = approvals.slice(0, 10);
    
    for (const approval of recentApprovals) {
        try {
            logger.debug('📋 Analyzing transaction', { 
                transactionHash: approval.transactionHash,
                spenderEntity: approval.spenderEntity 
            });
            
            const txData = await getTransactionDetails(approval.transactionHash);
            let operation = analyzeTransactionLogs(txData, walletAddress);
            
            // Use approval data to enhance operation info
            if (operation.protocol === 'Unknown' && approval.spenderEntity) {
                operation.protocol = approval.spenderEntity;
            }
            
            // If we couldn't determine the token from logs, use approval data
            if (operation.tokens.length === 0 && approval.tokenSymbol) {
                operation.tokens.push({
                    address: approval.tokenAddress || '',
                    symbol: approval.tokenSymbol,
                    amount: '0', // Will be determined from transaction
                    amountFormatted: '0',
                    direction: 'out'
                });
            }
            
            logger.debug('Transaction analysis result', { 
                type: operation.type,
                protocol: operation.protocol,
                summary: operation.details.summary,
                tokenCount: operation.tokens.length 
            });
            
            operations.push(operation);
            
            // Add delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
            
        } catch (error) {
            logger.error('Failed to analyze transaction', { 
                transactionHash: approval.transactionHash, 
                error 
            });
        }
    }
    
    // Convert operations to positions
    const positions = await convertOperationsToPositions(operations);
    
    logger.info('✅ Transaction analysis complete', { 
        positionsFound: positions.length,
        operationsAnalyzed: operations.length 
    });
    
    return positions;
}