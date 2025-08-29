import mongoose from 'mongoose';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

export async function connectDatabase() {
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
      environment: process.env.NODE_ENV || 'development'
    });

    await mongoose.connect(mongoUri, {
      // Add connection options to handle TLS issues
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info('✅ Connected to MongoDB');
  } catch (error) {
    logger.error('Failed to connect to MongoDB', error);
    throw error;
  }
}

export async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    logger.info('✅ Disconnected from MongoDB');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB', error);
  }
}