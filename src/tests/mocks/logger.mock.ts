import { vi } from 'vitest';

export const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis()
};

vi.mock('@/utils/logger', () => ({
  logger: mockLogger,
  default: mockLogger,
  createLogger: vi.fn(() => mockLogger)
}));