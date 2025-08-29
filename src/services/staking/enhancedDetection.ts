import { ethers } from 'ethers';
import { getCachedTokenPrice } from '../wallet/tokenPriceCache';
import { analyzeApprovalsWithTransactions } from './transactionAnalyzer';
import { createLogger } from '@/utils/logger';

const logger = createLogger('staking.enhancedDetection');

/**
 * Enhanced DeFi Detection using REST API
 * This implementation uses direct REST API calls to get wallet approvals
 * when SDK methods are not available or don't provide the needed data
 */

export interface DeFiApprovalActivity {
    protocol: string;
    protocolLogo?: string;
    tokenSymbol: string;
    tokenAddress: string;
    spenderAddress: string;
    spenderLabel: string | null;
    transactionHash: string;
    timestamp: string;
    isStaked: boolean;
    currentBalance: string | null;
    currentBalanceFormatted: string | null;
    usdAtRisk: string | null;
    operationType: string;
}

export interface EnhancedStakingPosition {
    protocol: string;
    protocolLogo?: string;
    tokenSymbol: string;
    tokenAddress: string;
    stakedAmount: string;
    stakedAmountFormatted: string;
    usdValue: number;
    apy?: number;
    unlockTime?: Date;
    lockStartTime?: Date;
    isLPToken?: boolean;
    contractAddress?: string;
    transactionHash?: string;
    approvalTimestamp?: string;
}

/**
 * Identify operation type based on spender label and entity
 */
function identifyOperationType(approval: any): string {
    const label = approval.spender?.address_label?.toLowerCase() || "";
    const entity = approval.spender?.entity?.toLowerCase() || "";
    
    if (label.includes('staking') || label.includes('vote') || label.includes('escrow') || label.includes('vecake')) {
        return "Staking";
    } else if (label.includes('pool') || label.includes('pair') || label.includes('liquidity')) {
        return "Liquidity Provision";
    } else if (label.includes('farm') || label.includes('yield') || label.includes('masterchef')) {
        return "Yield Farming";
    } else if (label.includes('lending') || label.includes('borrow') || entity.includes('venus')) {
        return "Lending";
    }
    
    // Judge by balance status
    if (approval.token?.current_balance === null) {
        return "Staked/Locked";
    } else {
        return "Authorized";
    }
}

/**
 * Detect DeFi activities using REST API
 */
export async function detectDeFiActivitiesViaAPI(walletAddress: string): Promise<DeFiApprovalActivity[]> {
    logger.info("🔍 Detecting DeFi activities via REST API...", { walletAddress });
    
    const apiKey = process.env.MORALIS_API_KEY;
    if (!apiKey) {
        throw new Error("MORALIS_API_KEY not found in environment variables");
    }
    
    const url = `https://deep-index.moralis.io/api/v2.2/wallets/${walletAddress}/approvals?chain=bsc`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'X-API-Key': apiKey
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`REST API error: ${response.status} - ${errorText}`, { 
                status: response.status, 
                errorText,
                walletAddress 
            });
            throw new Error(`Failed to fetch wallet approvals: ${response.status}`);
        }
        
        const data = await response.json();
        logger.info(`✅ Found ${data.result?.length || 0} approval records`, { 
            approvalCount: data.result?.length || 0,
            walletAddress 
        });
        
        const defiActivities: DeFiApprovalActivity[] = [];
        
        if (data.result && Array.isArray(data.result)) {
            for (const approval of data.result) {
                // Log approval details for debugging
                logger.info('📋 Approval Details', {
                    token: `${approval.token?.symbol} (${approval.token?.address})`,
                    tokenSymbol: approval.token?.symbol,
                    tokenAddress: approval.token?.address,
                    spender: approval.spender?.address_label || approval.spender?.address,
                    spenderAddress: approval.spender?.address,
                    entity: approval.spender?.entity || 'Unknown',
                    currentBalance: approval.token?.current_balance || 'null (staked/locked)',
                    usdAtRisk: approval.token?.usd_at_risk || 'N/A'
                });
                
                // Special handling for veCAKE
                let protocol = approval.spender?.entity || "Unknown Protocol";
                const spenderAddress = approval.spender?.address || "";
                
                // Check if this is veCAKE contract
                if (spenderAddress.toLowerCase() === '0x5692db8177a81a6c6afc8084c2976c9933ec1bab') {
                    protocol = 'PancakeSwap veCAKE';
                }
                
                const activity: DeFiApprovalActivity = {
                    protocol: protocol,
                    tokenSymbol: approval.token?.symbol || "Unknown Token",
                    tokenAddress: approval.token?.address || "",
                    spenderAddress: spenderAddress,
                    spenderLabel: approval.spender?.address_label || null,
                    transactionHash: approval.transaction_hash || "",
                    timestamp: approval.block_timestamp || "",
                    isStaked: approval.token?.current_balance === null,
                    currentBalance: approval.token?.current_balance || null,
                    currentBalanceFormatted: approval.token?.current_balance_formatted || null,
                    usdAtRisk: approval.token?.usd_at_risk || null,
                    operationType: identifyOperationType(approval)
                };
                
                // Add protocol-specific logos
                if (activity.protocol.toLowerCase().includes('pancakeswap')) {
                    activity.protocolLogo = '🥞';
                } else if (activity.protocol.toLowerCase().includes('venus')) {
                    activity.protocolLogo = '🌟';
                } else if (activity.protocol.toLowerCase().includes('alpaca')) {
                    activity.protocolLogo = '🦙';
                }
                
                defiActivities.push(activity);
            }
        }
        
        return defiActivities;
    } catch (error) {
        logger.error("Error fetching DeFi activities", { 
            error: error instanceof Error ? error.message : String(error),
            walletAddress 
        });
        throw error;
    }
}

/**
 * Convert DeFi approvals to staking positions
 */
export async function convertToStakingPositions(activities: DeFiApprovalActivity[]): Promise<EnhancedStakingPosition[]> {
    const stakingPositions: EnhancedStakingPosition[] = [];
    
    // Filter for staked positions (where current_balance is null)
    const stakedActivities = activities.filter(activity => 
        activity.isStaked && 
        (activity.operationType === "Staking" || 
         activity.operationType === "Staked/Locked" ||
         activity.operationType === "Yield Farming" ||
         activity.operationType === "Liquidity Provision")
    );
    
    for (const activity of stakedActivities) {
        try {
            // Get token price
            const tokenPrice = await getCachedTokenPrice(activity.tokenAddress);
            
            // For staked tokens, we need to get the staked amount from transaction details
            // Since current_balance is null, the tokens are locked in the protocol
            // We'll use the usd_at_risk as a proxy for value if available
            let usdValue = 0;
            let stakedAmount = "0";
            let stakedAmountFormatted = "0";
            
            if (activity.usdAtRisk && parseFloat(activity.usdAtRisk) > 0) {
                usdValue = parseFloat(activity.usdAtRisk);
                // If we have price, calculate amount
                if (tokenPrice && tokenPrice > 0) {
                    stakedAmountFormatted = (usdValue / tokenPrice).toFixed(6);
                    stakedAmount = ethers.parseUnits(stakedAmountFormatted, 18).toString();
                }
            }
            
            const position: EnhancedStakingPosition = {
                protocol: activity.protocol,
                protocolLogo: activity.protocolLogo,
                tokenSymbol: activity.tokenSymbol,
                tokenAddress: activity.tokenAddress,
                stakedAmount: stakedAmount,
                stakedAmountFormatted: stakedAmountFormatted,
                usdValue: usdValue,
                isLPToken: activity.tokenSymbol.includes('LP') || activity.tokenSymbol.includes('-'),
                contractAddress: activity.spenderAddress,
                transactionHash: activity.transactionHash,
                approvalTimestamp: activity.timestamp
            };
            
            // Protocol-specific details are handled by the approval data
            // The protocol name and logo come from the spender entity
            // This makes it work for any staking protocol, not just veCAKE
            
            stakingPositions.push(position);
        } catch (error) {
            logger.error(`Error processing staking position for ${activity.tokenSymbol}`, { 
                error: error instanceof Error ? error.message : String(error),
                tokenSymbol: activity.tokenSymbol,
                tokenAddress: activity.tokenAddress,
                protocol: activity.protocol 
            });
        }
    }
    
    return stakingPositions;
}

/**
 * Main function to detect all DeFi staking positions
 */
export async function detectEnhancedStakingPositions(walletAddress: string): Promise<EnhancedStakingPosition[]> {
    try {
        // Step 1: Get all DeFi approvals via REST API
        const defiActivities = await detectDeFiActivitiesViaAPI(walletAddress);
        
        // Step 2: Convert approvals to staking positions
        const stakingPositions = await convertToStakingPositions(defiActivities);
        
        // Step 3: Analyze transaction details for liquidity positions
        logger.info("🔄 Analyzing transaction details for liquidity positions...", { 
            walletAddress,
            activitiesCount: defiActivities.length 
        });
        const approvalData = defiActivities.map(activity => ({
            transactionHash: activity.transactionHash,
            tokenSymbol: activity.tokenSymbol,
            tokenAddress: activity.tokenAddress,
            spenderEntity: activity.protocol,
            spenderAddress: activity.spenderAddress,
            spenderLabel: activity.spenderLabel
        }));
        
        const txBasedPositions = await analyzeApprovalsWithTransactions(walletAddress, approvalData);
        
        // Merge transaction-based positions with existing ones
        for (const txPos of txBasedPositions) {
            // Check if we already have this position
            const existingIndex = stakingPositions.findIndex(
                pos => pos.transactionHash === txPos.transactionHash
            );
            
            if (existingIndex >= 0) {
                // Replace existing position if transaction analysis provided better data
                if (parseFloat(txPos.stakedAmountFormatted) > 0 && 
                    parseFloat(stakingPositions[existingIndex].stakedAmountFormatted) === 0) {
                    logger.info('📝 Replacing position with better data from transaction analysis', {
                        transactionHash: txPos.transactionHash,
                        tokenSymbol: txPos.tokenSymbol,
                        oldAmount: stakingPositions[existingIndex].stakedAmountFormatted,
                        newAmount: txPos.stakedAmountFormatted
                    });
                    stakingPositions[existingIndex] = txPos;
                }
            } else {
                // Add new position
                stakingPositions.push(txPos);
            }
        }
        
        // No need for additional veCAKE check - already handled in approval analysis
        
        return stakingPositions;
    } catch (error) {
        logger.error('Error in enhanced staking detection', { 
            error: error instanceof Error ? error.message : String(error),
            walletAddress 
        });
        return [];
    }
}

