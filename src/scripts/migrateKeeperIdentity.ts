import { connectDatabase } from '../database/connection';
import { UserModel } from '../database/models/User';
import { createLogger } from '../utils/logger';

const logger = createLogger('migration.keeper');

async function migrateKeeperIdentity() {
  try {
    logger.info('Starting Keeper identity migration...');
    
    // Connect to database
    await connectDatabase();
    
    // Update all users who have connected wallets to be Keepers
    const result = await UserModel.updateMany(
      { 
        walletAddress: { $exists: true },
        isKeeper: { $exists: false }
      },
      {
        $set: {
          isKeeper: true,
          role: 'keeper',
          dailyHoney: 10, // Give initial honey balance
          totalHoneyEarned: 10,
          activeReferralsCount: 0,
          consecutiveActiveDays: 0,
          keeperSince: new Date(),
          totalActionsUsed: 0
        }
      }
    );
    
    logger.info(`Updated ${result.modifiedCount} users to Keepers`);
    
    // Update referral counts for existing users
    const users = await UserModel.find({ referrer: { $exists: true } });
    
    for (const user of users) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const activeReferrals = await UserModel.countDocuments({
        referrer: (user as any)._id,
        walletAddress: { $exists: true },
        lastConnected: { $gte: thirtyDaysAgo }
      });
      
      await UserModel.updateOne(
        { _id: (user as any)._id },
        { activeReferralsCount: activeReferrals }
      );
    }
    
    logger.info('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', { error });
    process.exit(1);
  }
}

// Run migration
migrateKeeperIdentity();