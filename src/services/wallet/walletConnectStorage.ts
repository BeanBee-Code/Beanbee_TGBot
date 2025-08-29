import { KeyValueStorage } from '@walletconnect/keyvaluestorage';
import { createLogger } from '@/utils/logger';
import mongoose from 'mongoose';

const logger = createLogger('wallet.storage');

// MongoDB schema for WalletConnect storage
const WalletConnectStorageSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const WalletConnectStorageModel = mongoose.model('WalletConnectStorage', WalletConnectStorageSchema);

/**
 * MongoDB-based storage adapter for WalletConnect
 * This ensures sessions persist across bot restarts
 */
export class MongoDBStorage implements Omit<KeyValueStorage, 'database' | 'setInitialized' | 'initialize'> {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Ensure MongoDB connection is established
      if (mongoose.connection.readyState !== 1) {
        logger.warn('MongoDB not connected, waiting for connection...');
        await new Promise((resolve) => {
          if (mongoose.connection.readyState === 1) {
            resolve(true);
          } else {
            mongoose.connection.once('connected', resolve);
          }
        });
      }
      
      this.initialized = true;
      logger.info('MongoDB storage adapter initialized');
    } catch (error) {
      logger.error('Failed to initialize MongoDB storage', { error });
      throw error;
    }
  }

  async getItem<T = any>(key: string): Promise<T | undefined> {
    if (!this.initialized) await this.init();
    
    try {
      const doc = await WalletConnectStorageModel.findOne({ key });
      if (!doc) {
        return undefined;
      }
      
      logger.debug('Retrieved item from storage', { key });
      return doc.value as T;
    } catch (error) {
      logger.error('Failed to get item from storage', { key, error });
      throw error;
    }
  }

  async setItem<T = any>(key: string, value: T): Promise<void> {
    if (!this.initialized) await this.init();
    
    try {
      await WalletConnectStorageModel.findOneAndUpdate(
        { key },
        { key, value, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      
      logger.debug('Stored item in storage', { key });
    } catch (error) {
      logger.error('Failed to set item in storage', { key, error });
      throw error;
    }
  }

  async removeItem(key: string): Promise<void> {
    if (!this.initialized) await this.init();
    
    try {
      await WalletConnectStorageModel.deleteOne({ key });
      logger.debug('Removed item from storage', { key });
    } catch (error) {
      logger.error('Failed to remove item from storage', { key, error });
      throw error;
    }
  }

  async getKeys(): Promise<string[]> {
    if (!this.initialized) await this.init();
    
    try {
      const docs = await WalletConnectStorageModel.find({}, 'key');
      const keys = docs.map(doc => doc.key);
      logger.debug('Retrieved all keys from storage', { count: keys.length });
      return keys;
    } catch (error) {
      logger.error('Failed to get keys from storage', { error });
      throw error;
    }
  }

  async getEntries<T = any>(): Promise<[string, T][]> {
    if (!this.initialized) await this.init();
    
    try {
      const docs = await WalletConnectStorageModel.find({});
      const entries = docs.map(doc => [doc.key, doc.value] as [string, T]);
      logger.debug('Retrieved all entries from storage', { count: entries.length });
      return entries;
    } catch (error) {
      logger.error('Failed to get entries from storage', { error });
      throw error;
    }
  }

  /**
   * Clean up old entries (optional maintenance method)
   */
  async cleanupOldEntries(daysOld: number = 30): Promise<number> {
    if (!this.initialized) await this.init();
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      const result = await WalletConnectStorageModel.deleteMany({
        updatedAt: { $lt: cutoffDate }
      });
      
      logger.info('Cleaned up old storage entries', { 
        deleted: result.deletedCount,
        daysOld 
      });
      
      return result.deletedCount || 0;
    } catch (error) {
      logger.error('Failed to cleanup old entries', { error });
      return 0;
    }
  }

  /**
   * Clear all WalletConnect storage data
   */
  async clearAll(): Promise<void> {
    if (!this.initialized) await this.init();
    
    try {
      const result = await WalletConnectStorageModel.deleteMany({});
      logger.info('Cleared all WalletConnect storage', { 
        deleted: result.deletedCount 
      });
    } catch (error) {
      logger.error('Failed to clear all storage', { error });
    }
  }

  /**
   * Clear session-specific data
   */
  async clearSessionData(topic: string): Promise<void> {
    if (!this.initialized) await this.init();
    
    try {
      // Clear all keys related to this session topic
      const keys = await this.getKeys();
      const sessionKeys = keys.filter(key => 
        key.includes(topic) || 
        key.includes('session') || 
        key.includes('pairing') ||
        key.includes('proposal')
      );
      
      for (const key of sessionKeys) {
        // Check if this key contains data related to the topic
        try {
          const value = await this.getItem(key);
          const valueStr = JSON.stringify(value);
          if (valueStr.includes(topic)) {
            await this.removeItem(key);
          }
        } catch (e) {
          // If we can't check, just skip
        }
      }
      
      logger.info('Cleared session-specific storage', { 
        topic,
        keysChecked: sessionKeys.length 
      });
    } catch (error) {
      logger.error('Failed to clear session storage', { topic, error });
    }
  }
}

// Export singleton instance
export const walletConnectStorage = new MongoDBStorage();