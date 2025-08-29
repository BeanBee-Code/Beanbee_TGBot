import { vi } from 'vitest';

export const mockContract = {
  decimals: vi.fn().mockResolvedValue(18),
  symbol: vi.fn().mockResolvedValue('TEST'),
  name: vi.fn().mockResolvedValue('Test Token'),
  totalSupply: vi.fn().mockResolvedValue('1000000000000000000000000'),
  balanceOf: vi.fn().mockResolvedValue('1000000000000000000'),
  allowance: vi.fn().mockResolvedValue('0'),
  owner: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000000'),
  buyTax: vi.fn().mockResolvedValue(0),
  sellTax: vi.fn().mockResolvedValue(0),
  getReserves: vi.fn().mockResolvedValue({
    reserve0: '1000000000000000000000',
    reserve1: '2000000000000000000000',
    blockTimestampLast: 1234567890
  }),
  token0: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000001'),
  token1: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000002'),
  getPair: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000003')
};

export const mockProvider = {
  getBlockNumber: vi.fn().mockResolvedValue(123456),
  getBalance: vi.fn().mockResolvedValue('1000000000000000000'),
  getCode: vi.fn().mockResolvedValue('0x'),
  getTransactionCount: vi.fn().mockResolvedValue(0)
};

export const mockEthers = {
  JsonRpcProvider: vi.fn().mockImplementation(() => mockProvider),
  Contract: vi.fn().mockImplementation(() => mockContract),
  formatUnits: vi.fn().mockImplementation((value: string | bigint, decimals = 18) => {
    const divisor = BigInt(10) ** BigInt(decimals);
    return (BigInt(value) / divisor).toString();
  }),
  parseUnits: vi.fn().mockImplementation((value: string, decimals = 18) => {
    const multiplier = BigInt(10) ** BigInt(decimals);
    return (BigInt(Math.floor(Number(value))) * multiplier).toString();
  })
};

vi.mock('ethers', () => ({
  ethers: mockEthers,
  JsonRpcProvider: mockEthers.JsonRpcProvider,
  Contract: mockEthers.Contract,
  formatUnits: mockEthers.formatUnits,
  parseUnits: mockEthers.parseUnits,
  isAddress: vi.fn().mockImplementation((address: string) => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  })
}));