import { connectDatabase } from '../database/connection';
import { UserModel } from '../database/models/User';
import { ReferralEarningModel } from '../database/models/ReferralEarning';
import { ReferralPayoutModel } from '../database/models/ReferralPayout';
import mongoose from 'mongoose';
import { createLogger } from '../utils/logger';

const logger = createLogger('migrateAmountsToString');

async function migrateAmountsToString() {
  logger.info('🚀 Starting migration of amount fields to string...');
  await connectDatabase();

  try {
    // Migrate User model
    const users = await UserModel.find({ 
      $or: [
        { unclaimedReferralBNB: { $type: 'number' } },
        { totalReferralBNBEarned: { $type: 'number' } }
      ]
    });
    
    logger.info(`Found ${users.length} users to migrate...`);
    
    for (const user of users) {
      const unclaimedBNB = typeof (user as any).unclaimedReferralBNB === 'number' 
        ? (user as any).unclaimedReferralBNB.toString() 
        : (user as any).unclaimedReferralBNB;
      
      const totalBNBEarned = typeof (user as any).totalReferralBNBEarned === 'number' 
        ? (user as any).totalReferralBNBEarned.toString() 
        : (user as any).totalReferralBNBEarned;

      await UserModel.updateOne(
        { _id: user._id },
        {
          $set: {
            unclaimedReferralBNB: unclaimedBNB,
            totalReferralBNBEarned: totalBNBEarned,
          },
        }
      );
      
      logger.info(`Migrated user ${user.telegramId}: unclaimed=${unclaimedBNB}, total=${totalBNBEarned}`);
    }
    logger.info(`✅ Migrated ${users.length} users.`);

    // Migrate ReferralEarning model
    const earnings = await ReferralEarningModel.find({ bnbAmount: { $type: 'number' } });
    logger.info(`Found ${earnings.length} referral earnings to migrate...`);
    
    for (const earning of earnings) {
      const bnbAmount = typeof (earning as any).bnbAmount === 'number' 
        ? (earning as any).bnbAmount.toString() 
        : (earning as any).bnbAmount;

      await ReferralEarningModel.updateOne(
        { _id: earning._id },
        {
          $set: {
            bnbAmount: bnbAmount,
          },
        }
      );
      
      logger.debug(`Migrated earning ${earning._id}: bnbAmount=${bnbAmount}`);
    }
    logger.info(`✅ Migrated ${earnings.length} referral earnings.`);

    // Migrate ReferralPayout model
    const payouts = await ReferralPayoutModel.find({ bnbAmount: { $type: 'number' } });
    logger.info(`Found ${payouts.length} referral payouts to migrate...`);
    
    for (const payout of payouts) {
      const bnbAmount = typeof (payout as any).bnbAmount === 'number' 
        ? (payout as any).bnbAmount.toString() 
        : (payout as any).bnbAmount;

      await ReferralPayoutModel.updateOne(
        { _id: payout._id },
        {
          $set: {
            bnbAmount: bnbAmount,
          },
        }
      );
      
      logger.debug(`Migrated payout ${payout._id}: bnbAmount=${bnbAmount}`);
    }
    logger.info(`✅ Migrated ${payouts.length} referral payouts.`);

    logger.info('🎉 Migration completed successfully!');
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the migration
migrateAmountsToString();