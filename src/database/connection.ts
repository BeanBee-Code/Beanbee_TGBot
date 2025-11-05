import mongoose from 'mongoose';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 10;
const RETRY_DELAY = 10000; // 10 seconds

export async function connectDatabase(throwOnError = false) {
  try {
    let mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/';
    
    // If the URI doesn't end with a database name, append one based on NODE_ENV
    if (mongoUri.endsWith('/') || !mongoUri.includes('/', 10)) {
      const dbName = process.env.NODE_ENV === 'test' ? 'bnbcopilot-test' : 'bnbcopilot-prod';
      mongoUri = mongoUri.endsWith('/') ? mongoUri + dbName : mongoUri + '/' + dbName;
    } else if (process.env.NODE_ENV === 'test' && !mongoUri.includes('-test')) {
      // If we're in test mode but the URI doesn't have -test, replace the db name
      const parts = mongoUri.split('/');
      const lastPart = parts[parts.length - 1];
      const dbNameWithoutParams = lastPart.split('?')[0];
      const params = lastPart.includes('?') ? '?' + lastPart.split('?')[1] : '';
      parts[parts.length - 1] = dbNameWithoutParams + '-test' + params;
      mongoUri = parts.join('/');
    }

    logger.info('🔗 Connecting to MongoDB', { 
      uri: mongoUri.replace(/:[^:]*@/, ':***@'),
      environment: process.env.NODE_ENV || 'development',
      attempt: connectionRetries + 1
    });

    await mongoose.connect(mongoUri, {
      // Add connection options to handle TLS issues
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info('✅ Connected to MongoDB');
    isConnected = true;
    connectionRetries = 0;
  } catch (error: any) {
    logger.error('Failed to connect to MongoDB', error);
    
    // Check if this is an IP whitelist error
    if (error.message?.includes('IP') || error.message?.includes('whitelist')) {
      logger.error('⚠️  MongoDB Atlas IP Whitelist Error - Please add Cloud Run IPs to your Atlas cluster');
      logger.error('   Instructions: https://www.mongodb.com/docs/atlas/security-whitelist/');
      logger.error('   Tip: Add 0.0.0.0/0 to allow all IPs (for testing) or specific Cloud Run IP ranges');
    }
    
    if (throwOnError) {
      throw error;
    }
    
    // Retry logic
    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      logger.warn(`Retrying database connection in ${RETRY_DELAY / 1000} seconds... (Attempt ${connectionRetries}/${MAX_RETRIES})`);
      setTimeout(() => connectDatabase(false), RETRY_DELAY);
    } else {
      logger.error('Max database connection retries reached. Application will continue without database.');
    }
  }
}

export function isDatabaseConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}

export async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    logger.info('✅ Disconnected from MongoDB');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB', error);
  }
}