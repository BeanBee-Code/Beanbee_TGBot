import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables from main .env file
dotenv.config();

// Set test environment
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

// Mock crypto for Node.js environment if not available
if (!global.crypto) {
  Object.defineProperty(global, 'crypto', {
    value: {
      getRandomValues: (arr: any) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
      randomUUID: () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
    }
  });
}

// Global test lifecycle hooks
beforeAll(async () => {
  // Ensure we're using test database
  const dbName = mongoose.connection.db?.databaseName;
  if (dbName && !dbName.includes('test')) {
    throw new Error(`Refusing to run tests on non-test database: ${dbName}`);
  }
});

afterAll(async () => {
  // Clean up database connection
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

afterEach(async () => {
  // Clean up test data after each test if needed
  if (process.env.CLEAN_DB_AFTER_EACH === 'true' && mongoose.connection.db) {
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  }
});

// Mock console methods to reduce noise in tests
if (process.env.SUPPRESS_TEST_LOGS === 'true') {
  global.console = {
    ...global.console,
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };
}

// Global test utilities
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mockApiResponse = <T>(data: T, status = 200) => {
  return Promise.resolve({
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    ok: status >= 200 && status < 300
  });
};