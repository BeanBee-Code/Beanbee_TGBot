import Moralis from 'moralis';
import { ethers } from 'ethers';
import { getCachedTokenPrice } from '../wallet/tokenPriceCache';
import { detectEnhancedStakingPositions, DeFiApprovalActivity, EnhancedStakingPosition } from './enhancedDetection';
import { createLogger } from '@/utils/logger';

const logger = createLogger('staking');

export interface StakingPosition {
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
  poolId?: number;
  contractAddress?: string;
}

export interface StakingTokenInfo {
  address: string;
  symbol: string;
  name: string;
  isStakingToken: boolean;
  protocol?: string;
  underlyingToken?: string;
}

const STAKING_TOKENS: StakingTokenInfo[] = [
  // PancakeSwap LP Tokens
  { address: '0x0ed7e52944161450477ee417de9cd3a859b14fd0', symbol: 'Cake-LP', name: 'PancakeSwap LPs', isStakingToken: true, protocol: 'PancakeSwap' },
  { address: '0x58f876857a02d6762e0101bb5c46a8c1ed44dc16', symbol: 'WBNB-BUSD', name: 'PancakeSwap WBNB-BUSD LP', isStakingToken: true, protocol: 'PancakeSwap' },
  { address: '0x7efaef62fddcca950418312c6c91aef321375a00', symbol: 'USDT-BUSD', name: 'PancakeSwap USDT-BUSD LP', isStakingToken: true, protocol: 'PancakeSwap' },
  { address: '0x804678fa97d91b974ec2af3c843270886528a9e6', symbol: 'CAKE-WBNB', name: 'PancakeSwap CAKE-WBNB LP', isStakingToken: true, protocol: 'PancakeSwap' },
  
  // Venus vTokens
  { address: '0xa07c5b74c9b40447a954e1466938b865b6bbea36', symbol: 'vBNB', name: 'Venus BNB', isStakingToken: true, protocol: 'Venus', underlyingToken: 'BNB' },
  { address: '0xf508fcd89b8bd15579dc79a6827cb4686a3592c8', symbol: 'vETH', name: 'Venus ETH', isStakingToken: true, protocol: 'Venus', underlyingToken: 'ETH' },
  { address: '0xeca88125a5adbe82614ffc12d0db554e2e2867c8', symbol: 'vUSDC', name: 'Venus USDC', isStakingToken: true, protocol: 'Venus', underlyingToken: 'USDC' },
  { address: '0xfd5840cd36d94d7229439859c0112a4185bc0255', symbol: 'vUSDT', name: 'Venus USDT', isStakingToken: true, protocol: 'Venus', underlyingToken: 'USDT' },
  { address: '0x95c78222b3d6e262426483d42cfa53685a67ab9d', symbol: 'vBUSD', name: 'Venus BUSD', isStakingToken: true, protocol: 'Venus', underlyingToken: 'BUSD' },
  { address: '0x86ac3974e2bd0d60825230fa6f355ff11409df5c', symbol: 'vCAKE', name: 'Venus CAKE', isStakingToken: true, protocol: 'Venus', underlyingToken: 'CAKE' },
  
  // Alpaca Finance ibTokens
  { address: '0xd7d069493685a581d27824fc46eda46b7efc0063', symbol: 'ibBNB', name: 'Alpaca BNB', isStakingToken: true, protocol: 'Alpaca Finance', underlyingToken: 'BNB' },
  { address: '0x7c9e73d4c71dae564d41f78d56439bb4ba87592f', symbol: 'ibBUSD', name: 'Alpaca BUSD', isStakingToken: true, protocol: 'Alpaca Finance', underlyingToken: 'BUSD' },
  { address: '0x5D8F5a0d20Ad9b5Ef9AaFC3B4FF5c018247a3122', symbol: 'ibUSDT', name: 'Alpaca USDT', isStakingToken: true, protocol: 'Alpaca Finance', underlyingToken: 'USDT' },
  
  // BIFI Staking
  { address: '0x6fb0855c404e09c47c3fbca25f08d4e41f9f062f', symbol: 'mooCAKE', name: 'Beefy CAKE Vault', isStakingToken: true, protocol: 'Beefy Finance', underlyingToken: 'CAKE' },
  
  // Other common staking tokens
  { address: '0x1b96b92314c44b159149f7e0303511fb2fc4774f', symbol: 'BNB-BUSD LP', name: 'Legacy PancakeSwap V1 LP', isStakingToken: true, protocol: 'PancakeSwap V1' },
];

const PANCAKESWAP_MASTERCHEF_V2 = '0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652';
const PANCAKESWAP_MASTERCHEF_V3 = '0x556B9306565093C855AEA9AE92A594704c2Cd59e';
const PANCAKESWAP_VECAKE = '0x5692DB8177a81A6c6afc8084C2976C9933EC1bAB';
const CAKE_TOKEN = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

export async function detectStakingPositions(walletAddress: string): Promise<StakingPosition[]> {
  try {
    const stakingPositions: StakingPosition[] = [];
    
    // First, try the enhanced detection method using REST API
    logger.info('Using enhanced DeFi detection via REST API...');
    const enhancedPositions = await detectEnhancedStakingPositions(walletAddress);
    
    // Convert enhanced positions to standard StakingPosition format
    for (const enhPos of enhancedPositions) {
      const position: StakingPosition = {
        protocol: enhPos.protocol,
        protocolLogo: enhPos.protocolLogo,
        tokenSymbol: enhPos.tokenSymbol,
        tokenAddress: enhPos.tokenAddress,
        stakedAmount: enhPos.stakedAmount,
        stakedAmountFormatted: enhPos.stakedAmountFormatted,
        usdValue: enhPos.usdValue,
        apy: enhPos.apy,
        unlockTime: enhPos.unlockTime,
        lockStartTime: enhPos.lockStartTime,
        isLPToken: enhPos.isLPToken,
        contractAddress: enhPos.contractAddress,
      };
      stakingPositions.push(position);
    }
    
    // Then check wallet tokens for known staking tokens
    const response = await Moralis.EvmApi.token.getWalletTokenBalances({
      chain: '0x38',
      address: walletAddress,
    });
    
    const tokensResponse = response.toJSON() as any[];
    
    // Check each token against known staking tokens
    for (const token of tokensResponse) {
      const stakingTokenInfo = STAKING_TOKENS.find(
        st => st.address.toLowerCase() === token.token_address.toLowerCase()
      );
      
      if (stakingTokenInfo && parseFloat(token.balance) > 0) {
        // Check if we already have this position from enhanced detection
        const existingPosition = stakingPositions.find(
          pos => pos.tokenAddress.toLowerCase() === token.token_address.toLowerCase()
        );
        
        if (!existingPosition) {
          const balance = ethers.formatUnits(token.balance, token.decimals);
          
          // Calculate USD value
          let usdValue = 0;
          if (token.usd_value) {
            usdValue = token.usd_value;
          } else if (token.usd_price && balance) {
            usdValue = parseFloat(balance) * token.usd_price;
          }
          
          const position: StakingPosition = {
            protocol: stakingTokenInfo.protocol || 'Unknown',
            tokenSymbol: token.symbol,
            tokenAddress: token.token_address,
            stakedAmount: token.balance,
            stakedAmountFormatted: balance,
            usdValue: usdValue,
            isLPToken: token.symbol.includes('LP') || token.symbol.includes('-'),
          };
          
          // Add protocol-specific data
          if (stakingTokenInfo.protocol === 'Venus') {
            position.apy = await getVenusAPY(token.token_address);
          } else if (stakingTokenInfo.protocol === 'PancakeSwap') {
            position.apy = await getPancakeSwapAPY(token.token_address);
          }
          
          stakingPositions.push(position);
        }
      }
    }
    
    // Also check for direct staking in MasterChef contracts
    const directStakes = await checkDirectStaking(walletAddress);
    
    // Merge direct stakes, avoiding duplicates
    for (const directStake of directStakes) {
      const exists = stakingPositions.some(
        pos => pos.protocol.toLowerCase().includes('vecake') && 
               directStake.protocol.toLowerCase().includes('vecake')
      );
      
      if (!exists) {
        stakingPositions.push(directStake);
      }
    }
    
    return stakingPositions;
  } catch (error) {
    logger.error('Error detecting staking positions:', { error });
    return [];
  }
}

async function getVenusAPY(vTokenAddress: string): Promise<number | undefined> {
  // This would require Venus API or contract calls
  // For now, return placeholder
  return undefined;
}

async function getPancakeSwapAPY(lpTokenAddress: string): Promise<number | undefined> {
  // This would require PancakeSwap API or contract calls
  // For now, return placeholder
  return undefined;
}

async function checkDirectStaking(walletAddress: string): Promise<StakingPosition[]> {
  const directStakes: StakingPosition[] = [];
  
  try {
    // Skip if we're already using enhanced detection
    // The enhanced detection already handles veCAKE positions
    return directStakes;
    
    logger.debug('Checking veCAKE for wallet', { walletAddress });
    
    // Check veCAKE position using Moralis Web3 API
    // Try multiple functions to get user's locked CAKE
    const veCAKEABI = [
      {
        "inputs": [{"internalType": "address", "name": "_user", "type": "address"}],
        "name": "getUserInfo",
        "outputs": [
          {"internalType": "int128", "name": "amount", "type": "int128"},
          {"internalType": "uint256", "name": "end", "type": "uint256"},
          {"internalType": "address", "name": "cakePoolProxy", "type": "address"},
          {"internalType": "uint128", "name": "cakeAmount", "type": "uint128"},
          {"internalType": "uint48", "name": "lockEndTime", "type": "uint48"},
          {"internalType": "uint48", "name": "migrationTime", "type": "uint48"},
          {"internalType": "uint16", "name": "cakePoolType", "type": "uint16"},
          {"internalType": "uint16", "name": "withdrawFlag", "type": "uint16"}
        ],
        "stateMutability": "view",
        "type": "function"
      },
      {
        "inputs": [{"internalType": "address", "name": "", "type": "address"}],
        "name": "locks",
        "outputs": [
          {"internalType": "int128", "name": "amount", "type": "int128"},
          {"internalType": "uint256", "name": "end", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
      },
      {
        "inputs": [{"internalType": "address", "name": "addr", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
      }
    ];
    
    logger.debug('Calling veCAKE contract', { contractAddress: PANCAKESWAP_VECAKE });
    
    // Try getUserInfo first
    try {
      const response = await Moralis.EvmApi.utils.runContractFunction({
        chain: '0x38',
        address: PANCAKESWAP_VECAKE,
        functionName: 'getUserInfo',
        abi: veCAKEABI,
        params: {
          _user: walletAddress  // Changed from _account to _user
        }
      });
      
      const userInfo = response.toJSON() as any;
      logger.debug('veCAKE getUserInfo response', { userInfo });
      
      // Check if user has locked CAKE - the amount is in the 'amount' field, not 'cakeAmount'
      if (userInfo && userInfo.amount && userInfo.amount !== '0') {
        const cakeAmount = ethers.formatUnits(userInfo.amount, 18);
        const lockEndTime = new Date(parseInt(userInfo.end) * 1000);
        
        logger.info('Found locked CAKE via getUserInfo', { cakeAmount, lockEndTime });
        
        // Get CAKE price
        const cakePrice = await getCachedTokenPrice(CAKE_TOKEN);
        const usdValue = parseFloat(cakeAmount) * (cakePrice || 0);
        
        logger.debug('CAKE price calculation', { cakePrice, usdValue });
        
        directStakes.push({
          protocol: 'PancakeSwap veCAKE',
          protocolLogo: '🥞',
          tokenSymbol: 'CAKE',
          tokenAddress: CAKE_TOKEN,
          stakedAmount: userInfo.amount,
          stakedAmountFormatted: cakeAmount,
          usdValue: usdValue,
          unlockTime: lockEndTime,
          isLPToken: false,
          contractAddress: PANCAKESWAP_VECAKE,
        });
      } else {
        logger.debug('No veCAKE position found for this wallet', { walletAddress });
      }
    } catch (error) {
      logger.debug('getUserInfo failed, trying locks function...');
      
      // Try locks function as fallback
      try {
        const locksResponse = await Moralis.EvmApi.utils.runContractFunction({
          chain: '0x38',
          address: PANCAKESWAP_VECAKE,
          functionName: 'locks',
          abi: veCAKEABI,
          params: {
            '': walletAddress
          }
        });
        
        const locksInfo = locksResponse.toJSON() as any;
        logger.debug('veCAKE locks response', { locksInfo });
        
        if (locksInfo && locksInfo.amount && locksInfo.amount !== '0') {
          const cakeAmount = ethers.formatUnits(locksInfo.amount, 18);
          const lockEndTime = new Date(parseInt(locksInfo.end) * 1000);
          
          logger.info('Found locked CAKE via locks', { cakeAmount, lockEndTime });
          
          // Get CAKE price
          const cakePrice = await getCachedTokenPrice(CAKE_TOKEN);
          const usdValue = parseFloat(cakeAmount) * (cakePrice || 0);
          
          directStakes.push({
            protocol: 'PancakeSwap veCAKE',
            protocolLogo: '🥞',
            tokenSymbol: 'CAKE',
            tokenAddress: CAKE_TOKEN,
            stakedAmount: locksInfo.amount,
            stakedAmountFormatted: cakeAmount,
            usdValue: usdValue,
            unlockTime: lockEndTime,
            isLPToken: false,
          });
        }
      } catch (locksError) {
        logger.debug('locks function also failed', { error: locksError });
      }
    }
    
    // Could add more direct staking checks here (MasterChef pools, etc.)
    
  } catch (error) {
    logger.error('Error checking direct staking', { error, errorDetails: error });
  }
  
  return directStakes;
}

export function isStakingToken(tokenAddress: string): boolean {
  return STAKING_TOKENS.some(
    st => st.address.toLowerCase() === tokenAddress.toLowerCase()
  );
}

export function getStakingTokenInfo(tokenAddress: string): StakingTokenInfo | undefined {
  return STAKING_TOKENS.find(
    st => st.address.toLowerCase() === tokenAddress.toLowerCase()
  );
}

// Re-export enhanced detection functions
export { detectEnhancedStakingPositions, DeFiApprovalActivity, EnhancedStakingPosition } from './enhancedDetection';