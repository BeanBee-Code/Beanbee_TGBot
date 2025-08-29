import { ethers, FixedNumber } from 'ethers';
import { User, UserModel } from '../database/models/User';
import { HoneyTransaction, HoneyTransactionModel, HoneyTransactionType } from '../database/models/HoneyTransaction';
import { ReferralEarningModel } from '../database/models/ReferralEarning';
import { ReferralPayoutModel } from '../database/models/ReferralPayout';
import { getBNBPrice } from './wallet/tokenPriceCache';
import { createLogger } from '@/utils/logger';
import { Types } from 'mongoose';
import { DocumentType } from '@typegoose/typegoose';
import mongoose from 'mongoose';

const logger = createLogger('referralService');

// Configuration constants
const REFERRAL_SENDER_PRIVATE_KEY = process.env.REFERRAL_SENDER_PRIVATE_KEY;
const MIN_CLAIM_BNB = '0.01';
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/';
const BNB_TO_HONEY_RATE = 150000; // 1 BNB = 150,000 Honey

export class ReferralService {
  /**
   * Calculate referral amounts for each tier before the purchase
   * Returns array of referrer info with their earning amounts
   */
  static async calculateReferralAmounts(
    buyer: DocumentType<User>, 
    bnbSpent: number
  ): Promise<{ referrer: DocumentType<User>; amount: number; tier: number }[]> {
    if (!buyer.referrer) {
      return [];
    }

    const amounts: { referrer: DocumentType<User>; amount: number; tier: number }[] = [];
    let currentReferrerId: Types.ObjectId | undefined = buyer.referrer;

    // Process up to 3 tiers of referrals
    for (let tier = 1; tier <= 3; tier++) {
      if (!currentReferrerId) break;
      
      const referrer: DocumentType<User> | null = await UserModel.findById(currentReferrerId);
      if (!referrer) break;

      // Get referral percentage for this tier
      const percents = referrer.referralPercents;
      let percentage = 0;
      if (tier === 1) percentage = percents.firstHand;
      if (tier === 2) percentage = percents.secondHand;
      if (tier === 3) percentage = percents.thirdHand;

      if (percentage > 0) {
        const earningAmount = bnbSpent * (percentage / 100);
        amounts.push({ referrer, amount: earningAmount, tier });
      }

      // Move to next tier referrer
      currentReferrerId = referrer.referrer;
    }
    
    return amounts;
  }

  /**
   * Record referral earnings after the split payment is confirmed
   * This replaces the old distributeReferralEarnings function
   */
  static async recordReferralEarnings(
    buyer: DocumentType<User>,
    referralAmounts: { referrer: DocumentType<User>; amount: number; tier: number }[],
    sourceTransaction: DocumentType<HoneyTransaction>
  ): Promise<void> {
    try {
      const bnbPrice = await getBNBPrice();
      
      for (const data of referralAmounts) {
        const { referrer, amount, tier } = data;
        
        // Use FixedNumber for precise calculations
        const earningAmountFixed = FixedNumber.fromString(amount.toString());
        
        // Record the earning details
        await ReferralEarningModel.create({
          earningUser: referrer._id,
          fromUser: buyer._id,
          sourceTransaction: sourceTransaction._id,
          tier,
          bnbAmount: earningAmountFixed.toString(),
          usdValueAtTime: amount * bnbPrice
        });

        // Update referrer's unclaimed balance
        const referrerDoc = await UserModel.findById(referrer._id);
        if (referrerDoc) {
          const currentUnclaimedFixed = FixedNumber.fromString(referrerDoc.unclaimedReferralBNB);
          const currentTotalFixed = FixedNumber.fromString(referrerDoc.totalReferralBNBEarned);
          
          referrerDoc.unclaimedReferralBNB = currentUnclaimedFixed.addUnsafe(earningAmountFixed).toString();
          referrerDoc.totalReferralBNBEarned = currentTotalFixed.addUnsafe(earningAmountFixed).toString();
          
          await referrerDoc.save();
        }

        logger.info(`Recorded tier ${tier} referral earning`, {
          referrerId: referrer.telegramId,
          buyerId: buyer.telegramId,
          bnbAmount: earningAmountFixed.toString(),
        });
      }
    } catch (error) {
      logger.error('Error recording referral earnings', {
        error,
        buyerId: buyer.telegramId
      });
    }
  }

  /**
   * Distribute referral earnings after a honey purchase
   * Supports up to 3 tiers of referral rewards
   */
  static async distributeReferralEarnings(
    buyer: DocumentType<User>, 
    bnbSpent: number, 
    sourceTransaction: DocumentType<HoneyTransaction>
  ): Promise<void> {
    if (!buyer.referrer) {
      logger.info(`User ${buyer.telegramId} has no referrer. No earnings to distribute.`);
      return;
    }

    try {
      const bnbPrice = await getBNBPrice();
      const usdValue = bnbSpent * bnbPrice;
      let currentReferrerId: Types.ObjectId | undefined = buyer.referrer;

      // Process up to 3 tiers of referrals
      for (let tier = 1; tier <= 3; tier++) {
        if (!currentReferrerId) break;

        const referrer: DocumentType<User> | null = await UserModel.findById(currentReferrerId);
        if (!referrer) break;

        // Get referral percentage for this tier
        const percents = referrer.referralPercents;
        let percentage = 0;
        if (tier === 1) percentage = percents.firstHand;
        if (tier === 2) percentage = percents.secondHand;
        if (tier === 3) percentage = percents.thirdHand;

        if (percentage > 0) {
          // Use FixedNumber for precise calculations
          const bnbSpentFixed = FixedNumber.fromString(bnbSpent.toString());
          const percentageFixed = FixedNumber.fromString((percentage / 100).toString());
          const earningAmountFixed = bnbSpentFixed.mulUnsafe(percentageFixed);
          const earningAmountString = earningAmountFixed.toString();

          // Record the earning details
          await ReferralEarningModel.create({
            earningUser: referrer._id,
            fromUser: buyer._id,
            sourceTransaction: sourceTransaction._id,
            tier,
            bnbAmount: earningAmountString, // Store as string
            usdValueAtTime: usdValue * (percentage / 100)
          });

          // Update referrer's unclaimed balance using FixedNumber
          const referrerDoc = await UserModel.findById(referrer._id);
          if (referrerDoc) {
            const currentUnclaimedFixed = FixedNumber.fromString(referrerDoc.unclaimedReferralBNB);
            const currentTotalFixed = FixedNumber.fromString(referrerDoc.totalReferralBNBEarned);
            
            referrerDoc.unclaimedReferralBNB = currentUnclaimedFixed.addUnsafe(earningAmountFixed).toString();
            referrerDoc.totalReferralBNBEarned = currentTotalFixed.addUnsafe(earningAmountFixed).toString();
            
            await referrerDoc.save();
          }

          logger.info(`Distributed tier ${tier} referral earning`, {
            referrerId: referrer.telegramId,
            buyerId: buyer.telegramId,
            bnbAmount: earningAmountString,
          });
        }

        // Move to next tier referrer
        currentReferrerId = referrer.referrer;
      }
    } catch (error) {
      logger.error('Error distributing referral earnings', {
        error,
        buyerId: buyer.telegramId,
        bnbSpent,
      });
    }
  }

  /**
   * Process a user's request to withdraw their referral earnings to their wallet
   * Now supports partial withdrawals
   */
  static async withdrawReferralBNB(user: DocumentType<User>, amountToWithdrawStr: string): Promise<{ 
    success: boolean; 
    message: string; 
    txHash?: string 
  }> {
    if (!REFERRAL_SENDER_PRIVATE_KEY) {
        logger.error('CRITICAL: REFERRAL_SENDER_PRIVATE_KEY is not set!');
        return { success: false, message: 'Service is temporarily unavailable.' };
    }

    const unclaimedFixed = FixedNumber.fromString(user.unclaimedReferralBNB);
    const amountToWithdrawFixed = FixedNumber.fromString(amountToWithdrawStr);
    const minClaimFixed = FixedNumber.fromString(MIN_CLAIM_BNB);

    // Validate amount
    if (amountToWithdrawFixed.isZero() || amountToWithdrawFixed.isNegative()) {
        return { success: false, message: 'Invalid amount.' };
    }
    if (amountToWithdrawFixed.gt(unclaimedFixed)) {
        return { success: false, message: `Insufficient balance. You can only withdraw up to ${unclaimedFixed.toString()} BNB.` };
    }
    if (amountToWithdrawFixed.lt(minClaimFixed)) {
        return { success: false, message: `Minimum withdrawal amount is ${MIN_CLAIM_BNB} BNB.` };
    }
    if (!user.walletAddress) {
        return { success: false, message: 'No main wallet connected. Please connect your wallet first.' };
    }
    
    try {
      const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
      const wallet = new ethers.Wallet(REFERRAL_SENDER_PRIVATE_KEY, provider);

      const balance = await provider.getBalance(wallet.address);
      const valueInWei = ethers.parseUnits(amountToWithdrawStr, 18);
      
      if (balance < valueInWei) {
        logger.error('Referral sender wallet has insufficient funds!', {
          required: amountToWithdrawStr,
          balance: ethers.formatEther(balance)
        });
        return { success: false, message: 'Service wallet is currently low on funds. Please try again later.' };
      }

      const tx = await wallet.sendTransaction({
        to: user.walletAddress,
        value: valueInWei,
      });

      logger.info('Referral payout transaction sent', {
        userId: user.telegramId,
        amount: amountToWithdrawStr,
        txHash: tx.hash,
      });
      
      const receipt = await tx.wait();
      
      if (receipt && receipt.status === 1) {
        const userToUpdate = await UserModel.findById(user._id);
        if (userToUpdate) {
            const currentUnclaimed = FixedNumber.fromString(userToUpdate.unclaimedReferralBNB);
            userToUpdate.unclaimedReferralBNB = currentUnclaimed.subUnsafe(amountToWithdrawFixed).toString();
            await userToUpdate.save();
        }

        await ReferralPayoutModel.create({
          user: user._id,
          bnbAmount: amountToWithdrawStr,
          recipientWalletAddress: user.walletAddress,
          transactionHash: tx.hash,
          status: 'completed'
        });

        // For partial withdrawals, we don't mark ReferralEarning docs as claimed
        // This is a simplification - in production you might want more sophisticated tracking

        return { success: true, message: 'Withdrawal successful!', txHash: tx.hash };
      } else {
        throw new Error('Transaction failed on-chain');
      }
    } catch (error) {
      logger.error('Error withdrawing referral earnings', { error, userId: user.telegramId, amount: amountToWithdrawStr });
      return { success: false, message: `An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  /**
   * Convert user's referral BNB to Honey
   * Uses a fixed conversion rate of 1 BNB = 150,000 Honey
   */
  static async convertReferralBNBToHoney(user: DocumentType<User>, amountToConvertStr: string): Promise<{
    success: boolean;
    message: string;
    honeyAdded?: number;
  }> {
    const unclaimedFixed = FixedNumber.fromString(user.unclaimedReferralBNB);
    const amountToConvertFixed = FixedNumber.fromString(amountToConvertStr);

    if (amountToConvertFixed.isZero() || amountToConvertFixed.isNegative()) {
        return { success: false, message: 'Invalid amount.' };
    }
    if (amountToConvertFixed.gt(unclaimedFixed)) {
        return { success: false, message: `Insufficient balance. You can only convert up to ${unclaimedFixed.toString()} BNB.` };
    }

    try {
        const honeyToAdd = Math.floor(amountToConvertFixed.toUnsafeFloat() * BNB_TO_HONEY_RATE);

        // Use a database transaction for atomicity
        const session = await mongoose.startSession();
        session.startTransaction();
        
        let finalBalance = 0;
        try {
            const userToUpdate = await UserModel.findById(user._id).session(session);
            if (!userToUpdate) throw new Error('User not found during transaction');

            // Update balances
            const newUnclaimedBNB = FixedNumber.fromString(userToUpdate.unclaimedReferralBNB).subUnsafe(amountToConvertFixed).toString();
            userToUpdate.unclaimedReferralBNB = newUnclaimedBNB;
            
            const currentHoney = userToUpdate.dailyHoney || 0;
            finalBalance = currentHoney + honeyToAdd;
            userToUpdate.dailyHoney = finalBalance;

            await userToUpdate.save({ session });

            // Create Honey transaction record
            await HoneyTransactionModel.create([{
                user: user._id,
                telegramId: user.telegramId,
                type: HoneyTransactionType.REFERRAL_CONVERSION,
                amount: honeyToAdd,
                balanceAfter: finalBalance,
                description: `Converted ${amountToConvertStr} BNB to ${honeyToAdd} Honey`,
                metadata: {
                    bnbAmount: amountToConvertStr,
                    rate: BNB_TO_HONEY_RATE
                }
            }], { session });

            await session.commitTransaction();

            return { success: true, message: 'Conversion successful!', honeyAdded: honeyToAdd };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    } catch (error) {
        logger.error('Error converting referral BNB to Honey', { error, userId: user.telegramId, amount: amountToConvertStr });
        return { success: false, message: `An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  /**
   * Get detailed referral statistics for a user
   */
  static async getReferralStatistics(user: DocumentType<User>): Promise<{
    totalEarnings: number;
    unclaimedEarnings: number;
    claimedEarnings: number;
    referralCounts: { tier1: number; tier2: number; tier3: number };
  }> {
    const earnings = await ReferralEarningModel.find({ earningUser: user._id });
    
    const totalFixed = FixedNumber.fromString(user.totalReferralBNBEarned || '0');
    const unclaimedFixed = FixedNumber.fromString(user.unclaimedReferralBNB || '0');
    const claimedFixed = totalFixed.subUnsafe(unclaimedFixed);
    
    const totalEarnings = totalFixed.toUnsafeFloat();
    const unclaimedEarnings = unclaimedFixed.toUnsafeFloat();
    const claimedEarnings = claimedFixed.toUnsafeFloat();

    const referralCounts = {
      tier1: earnings.filter(e => e.tier === 1).length,
      tier2: earnings.filter(e => e.tier === 2).length,
      tier3: earnings.filter(e => e.tier === 3).length,
    };

    return {
      totalEarnings,
      unclaimedEarnings,
      claimedEarnings,
      referralCounts,
    };
  }
}