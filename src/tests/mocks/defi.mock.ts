import { vi } from 'vitest';

export const mockGetDeFiPositions = vi.fn().mockResolvedValue([]);
export const mockDetectStakingPositions = vi.fn().mockResolvedValue([]);
export const mockGetTopBSCYieldOpportunities = vi.fn().mockResolvedValue([]);
export const mockGetSmartYieldOpportunities = vi.fn().mockResolvedValue([]);

vi.mock('@/services/defi', () => ({
  getDeFiPositions: mockGetDeFiPositions
}));

vi.mock('@/services/staking', () => ({
  detectStakingPositions: mockDetectStakingPositions
}));

vi.mock('@/services/defiLlama/yieldService', () => ({
  getTopBSCYieldOpportunities: mockGetTopBSCYieldOpportunities,
  getSmartYieldOpportunities: mockGetSmartYieldOpportunities
}));