/**
 * Utility functions for handling Telegram markdown formatting
 */

/**
 * Sanitizes markdown content to prevent Telegram parsing errors
 * @param text - The markdown text to sanitize
 * @returns Sanitized markdown text
 */
export function sanitizeMarkdown(text: string): string {
  if (!text) return '';
  
  let sanitized = text;

  // [新建议] 修复常见的AI格式错误，例如 "**Title**:**"
  // 这会将无效的 "**:**" 序列替换为更安全的 ":**"
  // 例如： "**Safety Score**:**" -> "**Safety Score:**"
  sanitized = sanitized.replace(/\*\*:\*\*/g, ':**');

  // [新建议] 修复另一个常见错误，例如 "**Title**:** Value**"
  // 这会确保标题和值之间的正确间距
  sanitized = sanitized.replace(/(\*\*):(\s*)\*\*/g, '$1: $2**');

  // [新建议] 移除字符串末尾未闭合的 "**"
  if (sanitized.endsWith('**') && (sanitized.match(/\*\*/g) || []).length % 2 !== 0) {
    sanitized = sanitized.slice(0, -2);
  }

  // Very minimal sanitization - only fix the most problematic patterns
  sanitized = sanitized
    // Fix unmatched bold markers (this was likely the original issue)
    .replace(/\*\*([^*\n]+)(?!\*\*)/g, '**$1**')
    // Fix incomplete bold at the end of lines
    .replace(/\*\*([^*\n]+)$/gm, '**$1**')
    // Ensure code blocks are properly formatted
    .replace(/```([^`]*)```/g, (match, code) => {
      return '```\n' + code.trim() + '\n```';
    });
  
  return sanitized;
}

/**
 * Removes all markdown formatting from text
 * @param text - The markdown text to strip
 * @returns Plain text without markdown
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  
  return text
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove code blocks and inline code
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove other markdown elements
    .replace(/[#>+\-*]/g, '')
    .trim();
}

/**
 * Escapes special characters for Telegram Markdown v1
 * @param text - The text to escape
 * @returns Escaped text safe for Telegram Markdown
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  
  // Escape special Markdown characters
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}