// Import mocks first - order matters!
import { mockChat } from '../../mocks/gemini.mock';
import { mockScannerUtils } from '../../mocks/scannerUtils.mock';
import { mockGetDeFiPositions, mockDetectStakingPositions, mockGetSmartYieldOpportunities } from '../../mocks/defi.mock';
import { mockAnalyzeToken, mockTokenAnalysis } from '../../mocks/rugAlerts.mock';
import '../../mocks/database.mock';
import '../../mocks/logger.mock';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiAIService } from '@/services/ai/geminiService';
import { UserService } from '@/services/user';
import { TokenPriceModel } from '@/database/models/TokenPrice';
import { DeFiPosition } from '@/database/models/DeFiPosition';
import type { UserSession } from '@/types';

// Mock UserService
vi.mock('@/services/user', () => ({
  UserService: {
    getTradingWalletAddress: vi.fn(),
    getWalletConnection: vi.fn()
  }
}));

// Mock formatUSDValue
vi.mock('@/services/wallet/balance', () => ({
  formatUSDValue: vi.fn((value: number) => `$${value.toFixed(2)}`)
}));

describe('GeminiAIService', () => {
  let geminiService: GeminiAIService;
  const mockUserId = '123';
  const mockMainWallet = '0x1234567890123456789012345678901234567890';
  const mockTradingWallet = '0xTRADING1234567890123456789012345678901234';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset global userSessions
    global.userSessions = new Map();
    
    // Set up default user session
    const mockSession: Partial<UserSession> = {
      client: {} as unknown as UserSession['client'], // Mock SignClient
      address: mockMainWallet,
      selectedWallet: 'main'
    };
    global.userSessions.set(Number(mockUserId), mockSession as UserSession);

    // Set up default mocks
    vi.mocked(UserService.getTradingWalletAddress).mockResolvedValue(mockTradingWallet);
    vi.mocked(UserService.getWalletConnection).mockResolvedValue(null);
    
    mockScannerUtils.getWalletTokensWithPrices.mockResolvedValue([
      {
        token_address: '0xtoken1',
        name: 'Test Token',
        symbol: 'TEST',
        balance: '1000000000000000000',
        decimals: 18,
        usd_price: 10,
        usd_value: 10
      }
    ]);
    
    mockScannerUtils.formatTokenBalance.mockReturnValue('1.0');
    
    // Mock TokenPriceModel
    const mockQuery = {
      sort: vi.fn().mockResolvedValue({ price: 10 })
    };
    vi.mocked(TokenPriceModel.findOne).mockReturnValue(mockQuery as ReturnType<typeof TokenPriceModel.findOne>);
    
    // Mock DeFiPosition
    vi.mocked(DeFiPosition.findOne).mockResolvedValue(null);
    
    geminiService = new GeminiAIService();
  });

  describe('processMessage', () => {
    it('should process message without function calls', async () => {
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Hello, how can I help you?',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Hello', 'Hello', mockUserId);

      expect(result).toBe('Hello, how can I help you?');
      expect(mockChat.sendMessage).toHaveBeenCalledWith('Hello');
    });

    it('should handle errors gracefully', async () => {
      mockChat.sendMessage.mockRejectedValueOnce(new Error('API Error'));

      const result = await geminiService.processMessage('Hello', 'Hello', mockUserId);

      expect(result).toBe('I apologize, but I encountered an error processing your request. Please try again.');
    });
  });

  describe('getPortfolio function calls', () => {
    it('should process getPortfolio function call for main wallet', async () => {
      // First call returns function call
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: { walletType: 'main' }
          }]
        }
      });

      // Second call returns final response
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Here is your main wallet portfolio',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my portfolio', 'Show my portfolio', mockUserId);

      expect(result).toBe('Here is your main wallet portfolio');
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledWith(mockMainWallet);
      expect(mockChat.sendMessage).toHaveBeenCalledTimes(2);
      
      // Check that portfolio data was sent back
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.name).toBe('getPortfolio');
      expect(functionResponse.response.walletType).toBe('Main Wallet');
    });

    it('should process getPortfolio function call for trading wallet', async () => {
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: { walletType: 'trading' }
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Here is your trading wallet portfolio',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my trading wallet', 'Show my trading wallet', mockUserId);

      expect(result).toBe('Here is your trading wallet portfolio');
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledWith(mockTradingWallet);
    });

    it('should process getPortfolio function call for both wallets', async () => {
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: { walletType: 'both' }
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Here is your combined portfolio',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show both wallets', 'Show both wallets', mockUserId);

      expect(result).toBe('Here is your combined portfolio');
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledTimes(2);
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledWith(mockMainWallet);
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledWith(mockTradingWallet);
      
      // Check combined wallet response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.walletType).toBe('Combined');
      expect(functionResponse.response.wallets).toHaveLength(2);
    });

    it('should use session selectedWallet preference when no walletType specified', async () => {
      // Update session preference
      const session = global.userSessions.get(Number(mockUserId));
      if (session) {
        session.selectedWallet = 'trading';
      }

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: {} // No walletType specified
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Portfolio using preference',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my portfolio', 'Show my portfolio', mockUserId);

      expect(result).toBe('Portfolio using preference');
      expect(mockScannerUtils.getWalletTokensWithPrices).toHaveBeenCalledWith(mockTradingWallet);
    });

    it('should handle missing main wallet connection', async () => {
      // Remove wallet address from session
      const session = global.userSessions.get(Number(mockUserId));
      if (session) {
        session.address = undefined;
      }

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: { walletType: 'main' }
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Please connect your wallet first',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my portfolio', 'Show my portfolio', mockUserId);

      expect(result).toBe('Please connect your wallet first');
      expect(mockScannerUtils.getWalletTokensWithPrices).not.toHaveBeenCalled();
      
      // Check error response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.error).toBe('No main wallet connected');
    });

    it('should handle missing trading wallet', async () => {
      vi.mocked(UserService.getTradingWalletAddress).mockResolvedValue(null);

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: { walletType: 'trading' }
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Trading wallet not found',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my trading wallet', 'Show my trading wallet', mockUserId);

      expect(result).toBe('Trading wallet not found');
      expect(mockScannerUtils.getWalletTokensWithPrices).not.toHaveBeenCalled();
      
      // Check error response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.error).toBe('No trading wallet found');
    });

    it('should handle missing user session', async () => {
      global.userSessions.delete(Number(mockUserId));
      // When there's no session and no wallet type specified, it defaults to 'trading'
      vi.mocked(UserService.getTradingWalletAddress).mockResolvedValue(null);

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getPortfolio',
            args: {}
          }]
        }
      });

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => 'Trading wallet not found',
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Show my portfolio', 'Show my portfolio', mockUserId);

      expect(result).toBe('Trading wallet not found');
      expect(mockScannerUtils.getWalletTokensWithPrices).not.toHaveBeenCalled();
      
      // Check error response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.error).toBe('No trading wallet found');
    });
  });

  describe('getYieldInfo function calls', () => {
    it('should process getYieldInfo function call for main wallet', async () => {
      // Simulate AI deciding to call getYieldInfo tool
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getYieldInfo',
            args: { walletType: 'main' }
          }]
        }
      });

      // Simulate AI generating final response after receiving tool data
      const expectedFinalResponse = "Here is your yield information for your main wallet.";
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });
      
      // Mock the new smart yield opportunities function
      mockGetSmartYieldOpportunities.mockResolvedValueOnce([
        { project: 'PancakeSwap', symbol: 'CAKE-BNB', apy: 15.5, tvlUsd: 1000000, pool: 'pool123' }
      ]);

      const result = await geminiService.processMessage('Show my yield', 'Show my yield', mockUserId);

      // Verify the correct functions were called
      expect(mockGetDeFiPositions).toHaveBeenCalledWith(mockMainWallet);
      expect(mockDetectStakingPositions).toHaveBeenCalledWith(mockMainWallet);
      expect(mockGetSmartYieldOpportunities).toHaveBeenCalled(); // Verify new function is called

      // Verify final result is AI's response
      expect(result).toBe(expectedFinalResponse);
    });

    it('should process getYieldInfo function call for both wallets', async () => {
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'getYieldInfo',
            args: { walletType: 'both' }
          }]
        }
      });
      
      const expectedFinalResponse = "Here is the combined yield info for both of your wallets.";
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });
      
      // Mock smart yield opportunities
      mockGetSmartYieldOpportunities.mockResolvedValueOnce([
        { project: 'Venus', symbol: 'USDT', apy: 8.2, tvlUsd: 5000000, pool: 'venus456' }
      ]); 

      const result = await geminiService.processMessage('Show yield for both wallets', 'Show yield for both wallets', mockUserId);

      expect(result).toBe(expectedFinalResponse);
      expect(mockGetDeFiPositions).toHaveBeenCalledTimes(2);
      expect(mockDetectStakingPositions).toHaveBeenCalledTimes(2);
      expect(mockGetSmartYieldOpportunities).toHaveBeenCalled();
    });
  });

  describe('Multiple function calls', () => {
    it('should handle multiple function calls in one message', async () => {
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [
            { name: 'getPortfolio', args: { walletType: 'main' } },
            { name: 'getYieldInfo', args: { walletType: 'main' } }
          ]
        }
      });

      const expectedFinalResponse = 'Here is your portfolio and yield info combined.';
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });
      
      // Mock smart yield opportunities for getYieldInfo call
      mockGetSmartYieldOpportunities.mockResolvedValueOnce([
        { project: 'Alpaca', symbol: 'ALPACA', apy: 12.3, tvlUsd: 800000, pool: 'alpaca789' }
      ]);

      const result = await geminiService.processMessage('Show my portfolio and yield', 'Show my portfolio and yield', mockUserId);

      expect(result).toBe(expectedFinalResponse);
      expect(mockChat.sendMessage).toHaveBeenCalledTimes(2);
      
      // Check that both function responses were sent
      const functionResponses = mockChat.sendMessage.mock.calls[1][0];
      expect(functionResponses).toHaveLength(2);
      expect(functionResponses[0].functionResponse.name).toBe('getPortfolio');
      expect(functionResponses[1].functionResponse.name).toBe('getYieldInfo');
    });
  });

  describe('analyzeTokenSafety function calls', () => {
    beforeEach(() => {
      mockAnalyzeToken.mockResolvedValue(mockTokenAnalysis);
    });

    it('should analyze token safety when requested', async () => {
      const tokenAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'analyzeTokenSafety',
            args: { tokenAddress }
          }]
        }
      });

      const expectedFinalResponse = 'This token seems SAFE with a score of 85/100.';
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage(`Is ${tokenAddress} safe?`, `Is ${tokenAddress} safe?`, mockUserId);

      expect(result).toBe(expectedFinalResponse);
      expect(mockAnalyzeToken).toHaveBeenCalledWith(tokenAddress);
      
      // Check the safety analysis response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.name).toBe('analyzeTokenSafety');
      expect(functionResponse.response.safetyScore).toBe(85);
      expect(functionResponse.response.safetyLevel).toBe('SAFE');
    });

    it('should handle invalid token address', async () => {
      const invalidAddress = 'invalid-address';

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'analyzeTokenSafety',
            args: { tokenAddress: invalidAddress }
          }]
        }
      });

      const expectedFinalResponse = "That doesn't look like a valid address. Please provide a correct BSC token address.";
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage(`Is ${invalidAddress} safe?`, `Is ${invalidAddress} safe?`, mockUserId);

      expect(result).toBe(expectedFinalResponse);
      expect(mockAnalyzeToken).not.toHaveBeenCalled();
      
      // Check error response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.error).toBe('Invalid token address');
    });

    it('should handle token analysis failure', async () => {
      const tokenAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
      mockAnalyzeToken.mockResolvedValue(null);

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'analyzeTokenSafety',
            args: { tokenAddress }
          }]
        }
      });

      const expectedFinalResponse = "Sorry, I was unable to analyze this token right now.";
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage(`Check ${tokenAddress}`, `Check ${tokenAddress}`, mockUserId);

      expect(result).toBe(expectedFinalResponse);
      expect(mockAnalyzeToken).toHaveBeenCalledWith(tokenAddress);
      
      // Check error response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.error).toBe('Analysis failed');
    });

    it('should identify risky tokens', async () => {
      const riskyToken = {
        ...mockTokenAnalysis,
        safetyScore: 25,
        holderAnalysis: {
          ...mockTokenAnalysis.holderAnalysis,
          top10ConcentrationExcludingLP: 85,
          riskLevel: 'CRITICAL',
          riskFactors: ['Owner holds 60% of supply', 'LP not locked']
        },
        liquidityAnalysis: {
          ...mockTokenAnalysis.liquidityAnalysis,
          lpTokenBurned: false,
          lpTokenLocked: false
        }
      };

      mockAnalyzeToken.mockResolvedValue(riskyToken);

      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => '',
          functionCalls: () => [{
            name: 'analyzeTokenSafety',
            args: { tokenAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' }
          }]
        }
      });

      const expectedFinalResponse = "This token looks DANGEROUS, with a safety score of only 25/100.";
      mockChat.sendMessage.mockResolvedValueOnce({
        response: {
          text: () => expectedFinalResponse,
          functionCalls: () => null
        }
      });

      const result = await geminiService.processMessage('Is 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 safe?', 'Is 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 safe?', mockUserId);

      expect(result).toBe(expectedFinalResponse);
      
      // Check risky token response
      const functionResponse = mockChat.sendMessage.mock.calls[1][0][0].functionResponse;
      expect(functionResponse.response.safetyScore).toBe(25);
      expect(functionResponse.response.safetyLevel).toBe('DANGEROUS');
      expect(functionResponse.response.riskFactors).toContain('Owner holds 60% of supply');
      expect(functionResponse.response.hasSecuredLiquidity).toBe(false);
    });

  });
});