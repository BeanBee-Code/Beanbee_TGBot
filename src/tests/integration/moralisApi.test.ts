import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../mocks/moralis.mock';
import '../mocks/logger.mock';

// Import after mocks are set up
const getMoralis = () => import('moralis');

describe('Moralis API Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize Moralis SDK', async () => {
    const Moralis = (await getMoralis()).default;
    
    expect(Moralis.Core.isStarted).toBe(false);
    await Moralis.start({ apiKey: 'test-key' });
    expect(Moralis.Core.isStarted).toBe(true);
  });

  it('should fetch wallet balances', async () => {
    const Moralis = (await getMoralis()).default;
    const testWallet = '0x1234567890123456789012345678901234567890';
    
    await Moralis.start({ apiKey: 'test-key' });
    
    const response = await Moralis.EvmApi.wallets.getWalletTokenBalancesPrice({
      chain: "0x38",
      address: testWallet
    });
    
    expect(response.toJSON).toBeDefined();
  });

  it('should handle rate limit errors', async () => {
    const Moralis = (await getMoralis()).default;
    
    Moralis.EvmApi.token.getTokenPrice = vi.fn().mockRejectedValueOnce(
      new Error('Rate limit exceeded')
    );
    
    await expect(
      Moralis.EvmApi.token.getTokenPrice({ chain: "0x38", address: "0x123" })
    ).rejects.toThrow('Rate limit exceeded');
  });
});