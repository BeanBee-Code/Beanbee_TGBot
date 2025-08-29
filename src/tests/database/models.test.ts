import '../mocks/database.mock';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase } from '@/database/connection';
import { TokenPriceModel } from '@/database/models/TokenPrice';
import { UserModel } from '@/database/models/User';

describe.skip('Database Models', () => {
  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    // Clean up test data
    await TokenPriceModel.deleteMany({});
    await UserModel.deleteMany({});
  });

  describe('TokenPrice Model', () => {
    it('should create and retrieve a token price', async () => {
      const tokenPrice = await TokenPriceModel.create({
        tokenAddress: '0x1234567890123456789012345678901234567890',
        chainId: '0x38',
        price: 100.50,
        priceSource: 'moralis',
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 18
      });

      expect(tokenPrice.tokenAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(tokenPrice.price).toBe(100.50);

      const retrieved = await TokenPriceModel.findOne({ tokenAddress: tokenPrice.tokenAddress });
      expect(retrieved).toBeTruthy();
      expect(retrieved?.price).toBe(100.50);
    });
  });

  describe('User Model', () => {
    it('should create and retrieve a user', async () => {
      const user = await UserModel.create({
        telegramId: 123456789,
        walletAddress: '0x1234567890123456789012345678901234567890',
        isActive: true
      });

      expect(user.telegramId).toBe(123456789);
      expect(user.walletAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(user.isActive).toBe(true);

      const retrieved = await UserModel.findOne({ telegramId: 123456789 });
      expect(retrieved).toBeTruthy();
      expect(retrieved?.walletAddress).toBe('0x1234567890123456789012345678901234567890');
    });
  });
});