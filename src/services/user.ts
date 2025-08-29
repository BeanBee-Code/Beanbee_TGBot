import { UserModel, User } from '../database/models/User';
import { SessionTypes } from '@walletconnect/types';
import { generateWallet, encryptPrivateKey, decryptPrivateKey } from './wallet/tradingWallet';
import { KeeperService } from './keeper';

export class UserService {
  // Find or create user by Telegram ID
  static async findOrCreateUser(telegramId: number): Promise<User> {
    let user = await UserModel.findOne({ telegramId });
    
    if (!user) {
      // New users automatically become Keepers with basic role
      user = new UserModel({ 
        telegramId,
        isKeeper: true,              // Default to Keeper status
        role: 'keeper',              // Default role
        dailyHoney: 0,               // Start with 0 honey, earn through claims and tasks
        totalHoneyEarned: 0,
        keeperSince: new Date()
      });
      await user.save();
    }
    
    return user;
  }

  // Save wallet connection data
  static async saveWalletConnection(
    telegramId: number, 
    walletAddress: string, 
    topic: string, 
    session: SessionTypes.Struct
  ): Promise<void> {
    // Check if this is the first wallet connection before updating
    const user = await UserModel.findOne({ telegramId });
    const isFirstConnection = !user?.walletAddress;

    await UserModel.updateOne(
      { telegramId },
      {
        walletAddress,
        walletConnectTopic: topic,
        walletConnectSession: session,
        walletProvider: 'walletconnect',
        lastConnected: new Date(),
        isActive: true
      },
      { upsert: true }
    );
    
    // Only initialize keeper rewards if it's the first wallet connection
    if (isFirstConnection) {
      await KeeperService.initializeKeeper(telegramId);
    }
  }


  // Get user's wallet connection
  static async getWalletConnection(telegramId: number): Promise<{
    address?: string;
    topic?: string;
    session?: SessionTypes.Struct;
  } | null> {
    const user = await UserModel.findOne({ telegramId, isActive: true });
    
    if (!user || !user.walletAddress) {
      return null;
    }

    return {
      address: user.walletAddress,
      topic: user.walletConnectTopic,
      session: user.walletConnectSession
    };
  }

  // Disconnect wallet
  static async disconnectWallet(telegramId: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      {
        $unset: {
          walletAddress: 1,
          walletConnectTopic: 1,
          walletConnectSession: 1,
          walletProvider: 1
        },
        isActive: false
      }
    );
  }

  // Check if user has active wallet connection
  static async hasActiveWallet(telegramId: number): Promise<boolean> {
    const user = await UserModel.findOne({ 
      telegramId, 
      isActive: true,
      walletAddress: { $exists: true }
    });
    
    return !!user;
  }

  // Update last connected timestamp
  static async updateLastConnected(telegramId: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      { lastConnected: new Date() }
    );
  }

  // Get all active users (for admin purposes)
  static async getActiveUsers(): Promise<User[]> {
    return UserModel.find({ isActive: true }).exec();
  }

  // Clean up expired sessions (you can run this periodically)
  static async cleanupExpiredSessions(): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const result = await UserModel.updateMany(
      { 
        lastConnected: { $lt: thirtyDaysAgo },
        isActive: true 
      },
      {
        $unset: {
          walletAddress: 1,
          walletConnectTopic: 1,
          walletConnectSession: 1
        },
        isActive: false
      }
    );

    return result.modifiedCount;
  }

  // Get trading wallet address
  static async getTradingWalletAddress(telegramId: number): Promise<string | null> {
    const user = await UserModel.findOne({ telegramId });
    return user?.tradingWalletAddress || null;
  }

  // Export private key (one-time only)
  static async exportPrivateKey(telegramId: number): Promise<string | null> {
    const user = await UserModel.findOne({ telegramId });
    
    if (!user || !user.encryptedPrivateKey || !user.encryptionIv) {
      return null;
    }

    // Check if already exported
    if (user.privateKeyExported) {
      throw new Error('Private key has already been exported and cannot be viewed again');
    }

    // Decrypt the private key
    const privateKey = decryptPrivateKey(user.encryptedPrivateKey, user.encryptionIv);

    // Mark as exported and remove encrypted data
    await UserModel.updateOne(
      { telegramId },
      {
        privateKeyExported: true,
        $unset: {
          encryptedPrivateKey: 1,
          encryptionIv: 1
        }
      }
    );

    return privateKey;
  }

  // Check if private key can be exported
  static async canExportPrivateKey(telegramId: number): Promise<boolean> {
    const user = await UserModel.findOne({ telegramId });
    return !!(user && user.encryptedPrivateKey && !user.privateKeyExported);
  }

  // Get trading wallet for transactions (internal use only)
  static async getTradingWalletData(telegramId: number): Promise<{
    encryptedPrivateKey: string;
    iv: string;
  } | null> {
    const user = await UserModel.findOne({ telegramId });
    
    if (!user || !user.encryptedPrivateKey || !user.encryptionIv) {
      return null;
    }

    return {
      encryptedPrivateKey: user.encryptedPrivateKey,
      iv: user.encryptionIv
    };
  }

  // Update trading wallet information
  static async updateTradingWallet(
    telegramId: number,
    address: string,
    encryptedPrivateKey: string,
    encryptionIv: string
  ): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      {
        tradingWalletAddress: address,
        encryptedPrivateKey,
        encryptionIv,
        privateKeyExported: false
      }
    );
  }

  // Mark private key as exported
  static async markPrivateKeyAsExported(telegramId: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      { privateKeyExported: true }
    );
  }

  // Update user's name
  static async updateUserName(telegramId: number, name: string): Promise<void> {
    const updateData = name 
      ? { name, hasChosenAnonymous: false } 
      : { $unset: { name: 1 } };
    await UserModel.updateOne(
      { telegramId },
      updateData
    );
  }

  // Get user's name
  static async getUserName(telegramId: number): Promise<string | null> {
    const user = await UserModel.findOne({ telegramId });
    return user?.name || null;
  }

  // Mark user as having chosen to remain anonymous
  static async markUserAsAnonymous(telegramId: number): Promise<void> {
    await UserModel.updateOne(
      { telegramId },
      { hasChosenAnonymous: true, $unset: { name: 1 } }
    );
  }

  // Check if user has chosen to remain anonymous
  static async hasChosenAnonymous(telegramId: number): Promise<boolean> {
    const user = await UserModel.findOne({ telegramId });
    return user?.hasChosenAnonymous || false;
  }

  // Update main wallet address from web frontend
  static async updateMainWalletAddress(telegramId: number, walletAddress: string): Promise<void> {
    const user = await this.findOrCreateUser(telegramId);

    // Check if it's the first time connecting a wallet
    const isFirstConnection = !user.walletAddress;

    await UserModel.updateOne(
      { telegramId },
      {
        walletAddress: walletAddress.toLowerCase(),
        lastConnected: new Date(),
        isActive: true,
        // We don't touch WalletConnect fields here
      },
      { upsert: true }
    );
    
    // Only initialize keeper rewards if it's the first wallet connection
    if (isFirstConnection) {
      await KeeperService.initializeKeeper(telegramId);
    }
  }

  // Get main wallet address
  static async getMainWalletAddress(telegramId: number): Promise<string | undefined> {
    const user = await UserModel.findOne({ telegramId });
    return user?.walletAddress;
  }
}