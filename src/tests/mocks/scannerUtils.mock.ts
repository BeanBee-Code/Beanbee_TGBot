import { vi } from 'vitest';

export const mockScannerUtils = {
  getWalletTokensWithPrices: vi.fn(),
  formatTokenBalance: vi.fn()
};

vi.mock('@/services/wallet/scannerUtils', () => mockScannerUtils);