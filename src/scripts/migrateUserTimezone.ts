import { connectDatabase } from '@/database/connection';
import { UserModel } from '@/database/models/User';
import mongoose from 'mongoose';
import { config } from 'dotenv';

config();

async function migrateUserTimezone() {
  console.log('🔄 Starting timezone migration...');
  
  try {
    // Connect to database
    await connectDatabase();
    
    // Find all users without timezone field
    const usersWithoutTimezone = await UserModel.find({
      $or: [
        { timezone: { $exists: false } },
        { timezone: null },
        { timezone: '' }
      ]
    });
    
    console.log(`Found ${usersWithoutTimezone.length} users without timezone`);
    
    // Update each user to have UTC timezone
    let updated = 0;
    for (const user of usersWithoutTimezone) {
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { timezone: 'UTC' } }
      );
      updated++;
      
      if (updated % 100 === 0) {
        console.log(`Updated ${updated} users...`);
      }
    }
    
    console.log(`✅ Migration complete! Updated ${updated} users to have UTC timezone`);
    
    // Verify the migration
    const usersStillWithoutTimezone = await UserModel.countDocuments({
      $or: [
        { timezone: { $exists: false } },
        { timezone: null },
        { timezone: '' }
      ]
    });
    
    if (usersStillWithoutTimezone > 0) {
      console.warn(`⚠️  Warning: ${usersStillWithoutTimezone} users still without timezone`);
    } else {
      console.log('✅ All users now have a timezone set');
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  }
}

// Run the migration
migrateUserTimezone().then(() => process.exit(0)).catch(() => process.exit(1));