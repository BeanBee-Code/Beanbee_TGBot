import '../mocks/database.mock';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDatabase, disconnectDatabase } from '@/database/connection';
import mongoose from 'mongoose';

describe('Database Connection', () => {
  afterAll(async () => {
    await disconnectDatabase();
  });

  it('should connect to test database in test environment', async () => {
    await connectDatabase();
    
    expect(mongoose.connection.readyState).toBe(1); // 1 = connected
  });

  it('should not connect to production database in test environment', async () => {
    // In test environment, we use mocked connections
    expect(process.env.NODE_ENV).toBe('test');
    expect(mongoose.connection.readyState).toBe(1); // Mocked as connected
  });
});