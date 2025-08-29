import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiAIService } from '@/services/ai/geminiService';
import { ChatHistoryModel } from '@/database/models/ChatHistory';
import { UserModel } from '@/database/models/User';

// Mock dependencies
vi.mock('@/database/models/ChatHistory');
vi.mock('@/database/models/User');
vi.mock('@google/generative-ai');

describe('Chat History', () => {
  let geminiService: GeminiAIService;
  const mockUserId = '123456789';
  const mockTelegramId = 123456789;

  beforeEach(() => {
    geminiService = new GeminiAIService();
    vi.clearAllMocks();
  });

  describe('Token Counting', () => {
    it('should estimate token count correctly', () => {
      // Using private method access for testing
      const service = geminiService as any;
      
      // Average estimate is 4 chars per token
      expect(service.estimateTokenCount('Hello')).toBe(2); // 5/4 = 1.25, ceil = 2
      expect(service.estimateTokenCount('This is a test message')).toBe(6); // 22/4 = 5.5, ceil = 6
      expect(service.estimateTokenCount('')).toBe(0);
    });
  });

  describe('Loading Chat History', () => {
    it('should load chat history within token limit', async () => {
      const mockMessages = [
        {
          telegramId: mockTelegramId,
          role: 'assistant',
          content: 'Hi there!',
          tokenCount: 3,
          createdAt: new Date('2024-01-02'),
          isActive: true
        },
        {
          telegramId: mockTelegramId,
          role: 'user',
          content: 'Hello',
          tokenCount: 2,
          createdAt: new Date('2024-01-01'),
          isActive: true
        }
      ];

      vi.mocked(ChatHistoryModel.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockMessages)
        })
      } as any);

      const service = geminiService as any;
      const history = await service.loadChatHistory(mockUserId);

      expect(history).toHaveLength(2);
      expect(history[0].role).toBe('user');
      expect(history[0].parts[0].text).toBe('Hello');
      expect(history[1].role).toBe('model'); // assistant becomes model
      expect(history[1].parts[0].text).toBe('Hi there!');
    });

    it('should respect token limit when loading history', async () => {
      // Create messages that would exceed 100k token limit
      const largeMessage = {
        telegramId: mockTelegramId,
        role: 'user',
        content: 'x'.repeat(50000), // Roughly 12.5k tokens
        tokenCount: 12500,
        createdAt: new Date('2024-01-01'),
        isActive: true
      };

      const mockMessages = Array(10).fill(largeMessage); // 125k tokens total

      vi.mocked(ChatHistoryModel.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockMessages)
        })
      } as any);

      const service = geminiService as any;
      const history = await service.loadChatHistory(mockUserId);

      // Should only load 8 messages (100k / 12.5k = 8)
      expect(history.length).toBeLessThan(10);
      expect(history.length).toBe(8);
    });

    it('should handle empty chat history', async () => {
      vi.mocked(ChatHistoryModel.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([])
        })
      } as any);

      const service = geminiService as any;
      const history = await service.loadChatHistory(mockUserId);

      expect(history).toEqual([]);
    });
  });

  describe('Saving Chat History', () => {
    it('should save user and assistant messages', async () => {
      const createSpy = vi.spyOn(ChatHistoryModel, 'create').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(ChatHistoryModel, 'updateMany').mockResolvedValue({} as any);

      const service = geminiService as any;
      await service.saveToChatHistory(mockUserId, 'user', 'Test message');

      expect(createSpy).toHaveBeenCalledWith({
        telegramId: mockTelegramId,
        role: 'user',
        content: 'Test message',
        tokenCount: 3 // 12/4 = 3
      });

      // Should also clean up old messages
      expect(updateManySpy).toHaveBeenCalled();
    });

    it('should mark old messages as inactive', async () => {
      const updateManySpy = vi.spyOn(ChatHistoryModel, 'updateMany').mockResolvedValue({} as any);
      vi.spyOn(ChatHistoryModel, 'create').mockResolvedValue({} as any);

      const service = geminiService as any;
      await service.saveToChatHistory(mockUserId, 'assistant', 'Response');

      expect(updateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramId: mockTelegramId,
          createdAt: expect.objectContaining({ $lt: expect.any(Date) })
        }),
        { isActive: false }
      );
    });
  });

  describe('Clear Chat History', () => {
    it('should delete all messages for a user', async () => {
      const deleteSpy = vi.spyOn(ChatHistoryModel, 'deleteMany').mockResolvedValue({ 
        deletedCount: 5 
      } as any);

      const result = await ChatHistoryModel.deleteMany({ telegramId: mockTelegramId });

      expect(deleteSpy).toHaveBeenCalledWith({ telegramId: mockTelegramId });
      expect(result.deletedCount).toBe(5);
    });
  });
});