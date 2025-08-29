import { ethers } from 'ethers';
import { User, UserModel } from '@/database/models/User';
import { HoneyTransaction, HoneyTransactionModel, HoneyTransactionType } from '@/database/models/HoneyTransaction';
import { createLogger } from '@/utils/logger';
import { decryptPrivateKey } from '@/services/wallet/tradingWallet';
import Moralis from 'moralis';
import { ReferralService } from '../referralService';

const log = createLogger('HoneyRecharge');

/**
 * Honey recharge package configurations
 */
export interface HoneyPackage {
  honeyAmount: number;
  bnbAmount: string;
  marginPercentage: number;
  usdValue: number;
  userGetsText: string;
}

export class HoneyRechargeService {
  // Main address for receiving BNB payments (after referral split)
  private static readonly MAIN_DEPOSIT_ADDRESS = process.env.HONEY_MAIN_DEPOSIT_ADDRESS || '0xC8d27Dc5Ba7a9479E89c04D54a563495deb10E89';
  
  // Referral wallet address for automatic referral distribution
  private static readonly REFERRAL_DEPOSIT_ADDRESS = process.env.HONEY_REFERRAL_DEPOSIT_ADDRESS || '0xa8FB745067c4894edA0179190D0e8476251B3f92';

  // BNB token address (this is actually the native BNB, not WBNB)
  private static readonly BNB_TOKEN_ADDRESS = '0xB8c77482e45F1F44dE1745F52C74426C631bDD52';

  /**
   * Available honey packages with different bonus rates
   */
  public static readonly HONEY_PACKAGES: HoneyPackage[] = [
    {
      honeyAmount: 100,
      bnbAmount: '0.0013',
      marginPercentage: 1000,
      usdValue: 1,
      userGetsText: 'Base price'
    },
    {
      honeyAmount: 1000,
      bnbAmount: '0.012',
      marginPercentage: 900,
      usdValue: 10,
      userGetsText: '+25% more Honey'
    },
    {
      honeyAmount: 5000,
      bnbAmount: '0.05',
      marginPercentage: 750,
      usdValue: 50,
      userGetsText: '+46% more Honey'
    },
    {
      honeyAmount: 15000,
      bnbAmount: '0.1',
      marginPercentage: 500,
      usdValue: 100,
      userGetsText: '+115% more Honey'
    }
  ];

  /**
   * Get current BNB price in USD for display purposes
   */
  public static async getBNBPrice(): Promise<number> {
    try {
      const response = await Moralis.EvmApi.token.getTokenPrice({
        chain: '0x38', // BSC
        address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' // WBNB address for price
      });
      return response.result.usdPrice;
    } catch (error) {
      log.error('Failed to fetch BNB price:', error);
      return 600; // Fallback price
    }
  }

  /**
   * Get user's trading wallet BNB balance
   */
  public static async getUserBNBBalance(telegramId: number): Promise<string> {
    try {
      const user = await UserModel.findOne({ telegramId });
      if (!user?.tradingWalletAddress) {
        throw new Error('Trading wallet not found');
      }

      const response = await Moralis.EvmApi.balance.getNativeBalance({
        chain: '0x38', // BSC
        address: user.tradingWalletAddress
      });

      return ethers.formatEther(response.result.balance.toString());
    } catch (error) {
      log.error('Failed to fetch user BNB balance:', error);
      return '0';
    }
  }

  /**
   * Validate if user has sufficient BNB for honey purchase
   */
  public static async validateBNBBalance(telegramId: number, requiredBNB: string): Promise<boolean> {
    try {
      const currentBalance = await this.getUserBNBBalance(telegramId);
      const currentBN = ethers.parseEther(currentBalance);
      const requiredBN = ethers.parseEther(requiredBNB);

      // Add 10% buffer for gas fees
      const requiredWithGas = requiredBN + (requiredBN * BigInt(10)) / BigInt(100);

      return currentBN >= requiredWithGas;
    } catch (error) {
      log.error('Failed to validate BNB balance:', error);
      return false;
    }
  }

  /**
   * Execute honey purchase transaction
   */
  public static async purchaseHoney(telegramId: number, packageIndex: number): Promise<{
    success: boolean;
    transactionHash?: string;
    honeyAmount?: number;
    error?: string;
  }> {
    try {
      log.info(`Processing honey purchase for user ${telegramId}, package ${packageIndex}`);

      // Validate package index
      if (packageIndex < 0 || packageIndex >= this.HONEY_PACKAGES.length) {
        return { success: false, error: 'Invalid package selected' };
      }

      const selectedPackage = this.HONEY_PACKAGES[packageIndex];

      // Get user and validate
      const user = await UserModel.findOne({ telegramId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (!user.tradingWalletAddress || !user.encryptedPrivateKey) {
        return { success: false, error: 'Trading wallet not set up' };
      }

      // Validate BNB balance
      const hasBalance = await this.validateBNBBalance(telegramId, selectedPackage.bnbAmount);
      if (!hasBalance) {
        return { success: false, error: 'Insufficient BNB balance (including gas fees)' };
      }

      // Calculate referral amounts before sending any transactions
      const referralAmounts = await ReferralService.calculateReferralAmounts(
        user, 
        parseFloat(selectedPackage.bnbAmount)
      );
      
      // Calculate total referral amount and main wallet amount
      const totalReferralAmount = referralAmounts.reduce((sum, current) => sum + current.amount, 0);
      const mainWalletAmount = parseFloat(selectedPackage.bnbAmount) - totalReferralAmount;
      
      log.info(`Payment split calculated`, {
        totalBNB: selectedPackage.bnbAmount,
        mainWalletAmount: mainWalletAmount.toFixed(8),
        referralAmount: totalReferralAmount.toFixed(8),
        referralCount: referralAmounts.length
      });

      // Decrypt private key and create wallet
      const privateKey = decryptPrivateKey(
        user.encryptedPrivateKey,
        user.encryptionIv!
      );

      const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
      const wallet = new ethers.Wallet(privateKey, provider);

      // Execute BNB transfers - main wallet and referral wallet
      const transactions = [];
      
      // Send to main wallet if amount > 0
      if (mainWalletAmount > 0) {
        const mainTx = await wallet.sendTransaction({
          to: this.MAIN_DEPOSIT_ADDRESS,
          value: ethers.parseEther(mainWalletAmount.toFixed(18)),
          gasLimit: 80000,
        });
        transactions.push({ tx: mainTx, type: 'main' });
        log.info(`Main wallet transfer initiated: ${mainTx.hash}`);
      }
      
      // Send to referral wallet if amount > 0
      if (totalReferralAmount > 0) {
        const referralTx = await wallet.sendTransaction({
          to: this.REFERRAL_DEPOSIT_ADDRESS,
          value: ethers.parseEther(totalReferralAmount.toFixed(18)),
          gasLimit: 80000,
        });
        transactions.push({ tx: referralTx, type: 'referral' });
        log.info(`Referral wallet transfer initiated: ${referralTx.hash}`);
      }

      // Wait for all transactions to be confirmed
      const receipts = await Promise.all(
        transactions.map(async ({ tx, type }) => {
          const receipt = await tx.wait();
          log.info(`${type} transfer confirmed: ${tx.hash}`);
          return { receipt, type };
        })
      );
      
      // Check if all transactions succeeded
      const allSuccessful = receipts.every(({ receipt }) => receipt && receipt.status === 1);
      if (!allSuccessful) {
        return { success: false, error: 'One or more transactions failed' };
      }

      log.info(`All BNB transfers confirmed`);

      // Get the main transaction hash for returning and storing
      const mainTxHash = transactions.find(t => t.type === 'main')?.tx.hash || transactions[0]?.tx.hash;

      // Credit honey to user account
      const honeyAmount = selectedPackage.honeyAmount;
      const newBalance = (user.dailyHoney || 0) + honeyAmount;
      const newTotalEarned = (user.totalHoneyEarned || 0) + honeyAmount;
      const newPurchasedHoney = (user.purchasedHoney || 0) + honeyAmount;
      
      await UserModel.updateOne({ _id: user._id }, {
        dailyHoney: newBalance,
        totalHoneyEarned: newTotalEarned,
        purchasedHoney: newPurchasedHoney
      });

      // Record honey transaction
      const honeyTransaction = await HoneyTransactionModel.create({
        user: user._id,
        telegramId: user.telegramId,
        type: HoneyTransactionType.BNB_PURCHASE,
        amount: honeyAmount,
        balanceAfter: newBalance,
        description: `Purchased ${honeyAmount} honey with ${selectedPackage.bnbAmount} BNB`,
        metadata: {
          bnbAmount: selectedPackage.bnbAmount,
          transactionHash: mainTxHash,
          marginPercentage: selectedPackage.marginPercentage,
          mainDepositAddress: this.MAIN_DEPOSIT_ADDRESS,
          referralDepositAddress: this.REFERRAL_DEPOSIT_ADDRESS,
          mainWalletAmount: mainWalletAmount.toFixed(8),
          referralWalletAmount: totalReferralAmount.toFixed(8)
        }
      });

      // Record referral earnings after successful purchase and payment split
      await ReferralService.recordReferralEarnings(user, referralAmounts, honeyTransaction);

      log.info(`Honey purchase completed for user ${telegramId}: ${honeyAmount} honey`);
      
      return {
        success: true,
        transactionHash: mainTxHash,
        honeyAmount: honeyAmount
      };

    } catch (error) {
      log.error('Honey purchase failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Get honey purchase statistics for user
   */
  public static async getUserPurchaseStats(telegramId: number): Promise<{
    totalPurchased: number;
    totalSpent: string;
    purchaseCount: number;
  }> {
    try {
      const transactions = await HoneyTransactionModel.find({
        telegramId,
        type: HoneyTransactionType.BNB_PURCHASE,
        amount: { $gt: 0 } // Only purchases (positive amounts)
      });

      const totalPurchased = transactions.reduce((sum, tx) => sum + tx.amount, 0);
      const totalSpent = transactions.reduce((sum, tx) => {
        const bnbAmount = tx.metadata?.bnbAmount || '0';
        return sum + parseFloat(bnbAmount);
      }, 0);

      return {
        totalPurchased,
        totalSpent: totalSpent.toFixed(4),
        purchaseCount: transactions.length
      };
    } catch (error) {
      log.error('Failed to get purchase stats:', error);
      return {
        totalPurchased: 0,
        totalSpent: '0',
        purchaseCount: 0
      };
    }
  }

  /**
   * Format package display
   */
  public static async formatPackageDisplay(pkg: HoneyPackage): Promise<string> {
    return `🍯 ${pkg.honeyAmount.toLocaleString()} Honey\n` +
      `💰 ${pkg.bnbAmount} BNB\n` +
      `✨ ${pkg.userGetsText}`;
  }
}