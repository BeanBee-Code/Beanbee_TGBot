import { describe, it, expect, vi } from 'vitest';
import { tavilyNewsService } from '@/services/news/tavilyService';

describe('TavilyNewsService - Simple Tests', () => {
  describe('getNewsFormatted', () => {
    it('should return formatted news section when news is available', async () => {
      const mockSummary = 'Test BSC news summary';
      vi.spyOn(tavilyNewsService, 'getDailyCryptoNews').mockResolvedValue(mockSummary);

      const result = await tavilyNewsService.getNewsFormatted();

      expect(result).toBe('\n\n📰 Market News & Updates\n\n' + mockSummary);
    });

    it('should return empty string when no news is available', async () => {
      vi.spyOn(tavilyNewsService, 'getDailyCryptoNews').mockResolvedValue('');

      const result = await tavilyNewsService.getNewsFormatted();

      expect(result).toBe('');
    });
  });
});