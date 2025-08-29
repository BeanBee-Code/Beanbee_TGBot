import { vi } from 'vitest';

export const mockMongooseConnection = {
  readyState: 1,
  close: vi.fn().mockResolvedValue(undefined)
};

export const mockMongoose = {
  connect: vi.fn().mockResolvedValue(mockMongooseConnection),
  connection: mockMongooseConnection,
  disconnect: vi.fn().mockResolvedValue(undefined)
};

vi.mock('mongoose', () => ({
  default: mockMongoose,
  ...mockMongoose
}));

vi.mock('@/database/connection', () => ({
  connectDatabase: vi.fn().mockResolvedValue(mockMongooseConnection),
  disconnectDatabase: vi.fn().mockResolvedValue(undefined)
}));

// Mock database models to prevent typegoose initialization errors
vi.mock('@/database/models/TokenPrice', () => ({
  TokenPriceModel: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn()
  }
}));

vi.mock('@/database/models/TransactionCache', () => ({
  TransactionCache: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn()
  },
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn()
  }
}));

vi.mock('@/database/models/User', () => ({
  UserModel: {
    findOne: vi.fn(),
    create: vi.fn(),
    findByIdAndUpdate: vi.fn()
  }
}));

vi.mock('@/database/models/DeFiPosition', () => ({
  DeFiPositionModel: {
    find: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn()
  },
  DeFiPosition: {
    findOne: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn()
  }
}));

vi.mock('@/database/models/PNL', () => ({
  PNLModel: {
    find: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock('@/database/models/Transaction', () => ({
  TransactionModel: {
    find: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock('@/database/models/ChatHistory', () => ({
  ChatHistoryModel: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue([])
      })
    }),
    create: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({})
  }
}));