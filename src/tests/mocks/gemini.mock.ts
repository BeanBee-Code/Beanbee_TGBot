import { vi } from 'vitest';

export const mockChat = {
  sendMessage: vi.fn()
};

export const mockStartChat = vi.fn();

export const mockModel = {
  startChat: mockStartChat
};

export const mockGoogleGenerativeAI = vi.fn().mockImplementation(() => ({
  getGenerativeModel: vi.fn().mockReturnValue(mockModel)
}));

// Set default mock behavior
mockStartChat.mockReturnValue(mockChat);

// Mock the Google Generative AI module
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: mockGoogleGenerativeAI,
  SchemaType: {
    OBJECT: 'object',
    STRING: 'string'
  }
}));