/**
 * ChainGPT Smart Contract Auditor Service
 *
 * Provides AI-powered smart contract security auditing using ChainGPT API.
 * Complements HAPI Labs security analysis with detailed AI-driven vulnerability detection.
 */

import axios from 'axios';
import { createLogger } from '@/utils/logger';
import { ChainGPTAuditCacheModel } from '@/database/models/ChainGPTAuditCache';

const logger = createLogger('chainGPT-auditor');

/**
 * ChainGPT API response structure (streaming)
 */
interface ChainGPTStreamResponse {
  data?: string;
  finish?: boolean;
  error?: string;
}

/**
 * Audit result structure
 */
export interface SmartContractAuditResult {
  success: boolean;
  auditReport: string;
  summary?: string;
  vulnerabilities?: {
    critical: string[];
    high: string[];
    medium: string[];
    low: string[];
    informational: string[];
  };
  error?: string;
}

export class ChainGPTAuditor {
  private apiKey: string;
  private baseUrl = 'https://api.chaingpt.org/chat/stream';
  private model = 'smart_contract_auditor';

  constructor() {
    this.apiKey = process.env.CHAINGPT_API_KEY || '';

    if (!this.apiKey) {
      logger.warn('CHAINGPT_API_KEY not found in environment variables');
    }
  }

  /**
   * Checks if the service is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Audits a smart contract by fetching its source code from BSCScan and analyzing it
   *
   * @param contractAddress - The contract address to audit
   * @param chainId - Chain ID (56 for BSC, 1 for Ethereum, etc.)
   * @returns Audit result with vulnerabilities and recommendations
   */
  async auditContractByAddress(
    contractAddress: string,
    chainId: number = 56
  ): Promise<SmartContractAuditResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        auditReport: '',
        error: 'ChainGPT API key not configured. Please add CHAINGPT_API_KEY to your environment variables.',
      };
    }

    try {
      // Check cache first
      const normalizedAddress = contractAddress.toLowerCase();
      const cachedAudit = await ChainGPTAuditCacheModel.findOne({
        contractAddress: normalizedAddress,
        chainId,
      });

      if (cachedAudit) {
        logger.info(`Found cached audit for ${contractAddress}`, {
          auditedAt: cachedAudit.auditedAt,
          hitCount: cachedAudit.hitCount,
        });

        // Update hit count and last accessed time
        await ChainGPTAuditCacheModel.updateOne(
          { contractAddress: normalizedAddress, chainId },
          {
            $inc: { hitCount: 1 },
            $set: { lastAccessedAt: new Date() },
          }
        );

        return {
          success: true,
          auditReport: cachedAudit.auditReport,
          summary: cachedAudit.summary,
          vulnerabilities: cachedAudit.vulnerabilities,
        };
      }

      logger.info(`No cache found, fetching contract source code for audit: ${contractAddress}`);

      // Import the source code fetcher dynamically
      const { getVerifiedSourceCode } = await import('@/scripts/getBscSourceCode');

      // Fetch source code from BSCScan/Etherscan V2 API
      const sourceCodeData = await getVerifiedSourceCode(contractAddress, chainId);

      if (!sourceCodeData || sourceCodeData.length === 0) {
        return {
          success: false,
          auditReport: '',
          error: 'Could not fetch verified source code for this contract. The contract may not be verified on the blockchain explorer.',
        };
      }

      const contractData = sourceCodeData[0];

      // Extract source code
      let sourceCode = contractData.SourceCode;

      // Handle multi-file contracts (JSON format)
      if (sourceCode.startsWith('{{') || sourceCode.startsWith('{')) {
        try {
          const cleanedSource = sourceCode.startsWith('{{')
            ? sourceCode.slice(1, -1)
            : sourceCode;
          const sourceJson = JSON.parse(cleanedSource);

          // Extract main contract file(s)
          if (sourceJson.sources) {
            const files = Object.keys(sourceJson.sources);
            const mainFile = files.find((f: string) => f.includes(contractData.ContractName)) || files[0];
            sourceCode = sourceJson.sources[mainFile]?.content || JSON.stringify(sourceJson, null, 2);
          } else {
            sourceCode = JSON.stringify(sourceJson, null, 2);
          }
        } catch (e) {
          logger.warn('Failed to parse multi-file source code', { error: e });
        }
      }

      // Truncate if too large (ChainGPT has token limits)
      const maxLength = 15000; // Conservative limit
      if (sourceCode.length > maxLength) {
        sourceCode = sourceCode.substring(0, maxLength) + '\n\n[... Contract truncated due to length ...]';
      }

      // Perform audit and cache the result
      const result = await this.auditSourceCode(
        sourceCode,
        contractData.ContractName,
        contractAddress
      );

      // If audit was successful, cache it
      if (result.success) {
        try {
          const now = new Date();
          const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

          await ChainGPTAuditCacheModel.create({
            contractAddress: normalizedAddress,
            chainId,
            contractName: contractData.ContractName,
            auditReport: result.auditReport,
            summary: result.summary,
            vulnerabilities: result.vulnerabilities,
            compilerVersion: contractData.CompilerVersion,
            auditedAt: now,
            expiresAt,
            hitCount: 0,
          });

          logger.info('Cached audit result', { contractAddress: normalizedAddress, chainId });
        } catch (cacheError) {
          // Don't fail the audit if caching fails
          logger.warn('Failed to cache audit result', {
            error: cacheError instanceof Error ? cacheError.message : String(cacheError),
          });
        }
      }

      return result;
    } catch (error) {
      logger.error('Error auditing contract by address', {
        contractAddress,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        auditReport: '',
        error: `Failed to audit contract: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Audits smart contract source code using ChainGPT AI
   *
   * @param sourceCode - The Solidity source code to audit
   * @param contractName - Optional contract name for context
   * @param contractAddress - Optional contract address for context
   * @returns Audit result with vulnerabilities and recommendations
   */
  async auditSourceCode(
    sourceCode: string,
    contractName?: string,
    contractAddress?: string
  ): Promise<SmartContractAuditResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        auditReport: '',
        error: 'ChainGPT API key not configured',
      };
    }

    try {
      // Construct audit request prompt
      const prompt = this.buildAuditPrompt(sourceCode, contractName, contractAddress);

      logger.info('Requesting smart contract audit from ChainGPT', {
        contractName,
        contractAddress,
        sourceCodeLength: sourceCode.length,
      });

      // Make API request
      const response = await axios.post(
        this.baseUrl,
        {
          model: this.model,
          question: prompt,
          chatHistory: 'off', // Don't need conversation memory for audits
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 120000, // 120 second timeout for audit (increased)
          responseType: 'text', // Important: treat as text for streaming
        }
      );

      logger.info('Received response from ChainGPT', {
        status: response.status,
        dataType: typeof response.data,
        dataLength: response.data?.length || 0,
        firstChars: response.data?.substring(0, 200) || 'empty'
      });

      // Parse streaming response
      const auditReport = this.parseStreamResponse(response.data);

      if (!auditReport) {
        return {
          success: false,
          auditReport: '',
          error: 'Received empty response from ChainGPT API',
        };
      }

      logger.info('Successfully received audit report from ChainGPT');

      // Clean markdown symbols from the report
      const cleanedReport = this.cleanMarkdownSymbols(auditReport);

      // Extract structured vulnerabilities (if possible)
      const vulnerabilities = this.extractVulnerabilities(cleanedReport);

      // Generate summary
      const summary = this.generateSummary(cleanedReport, vulnerabilities);

      // Return the result (caching is done in auditContractByAddress)
      return {
        success: true,
        auditReport: cleanedReport,
        summary,
        vulnerabilities,
      };
    } catch (error) {
      logger.error('Error calling ChainGPT API', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const errorMessage = error.response?.data?.error || error.message;

        if (statusCode === 401 || statusCode === 403) {
          return {
            success: false,
            auditReport: '',
            error: 'Invalid ChainGPT API key. Please check your CHAINGPT_API_KEY configuration.',
          };
        }

        if (statusCode === 429) {
          return {
            success: false,
            auditReport: '',
            error: 'Rate limit exceeded. Please try again in a moment.',
          };
        }

        return {
          success: false,
          auditReport: '',
          error: `API error: ${errorMessage}`,
        };
      }

      return {
        success: false,
        auditReport: '',
        error: `Audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Builds the audit prompt for ChainGPT
   */
  private buildAuditPrompt(
    sourceCode: string,
    contractName?: string,
    contractAddress?: string
  ): string {
    // ChainGPT expects the source code directly without extra instructions
    // The model is trained specifically for smart contract auditing
    let prompt = '';

    if (contractName || contractAddress) {
      prompt += '// ';
      if (contractName) {
        prompt += `Contract: ${contractName}`;
      }
      if (contractAddress) {
        prompt += ` (${contractAddress})`;
      }
      prompt += '\n\n';
    }

    // Just send the source code directly - the model knows to audit it
    prompt += sourceCode;

    return prompt;
  }

  /**
   * Parses ChainGPT's streaming response format
   */
  private parseStreamResponse(responseData: any): string {
    try {
      logger.info('Parsing ChainGPT response', {
        type: typeof responseData,
        isString: typeof responseData === 'string',
        length: responseData?.length || 0
      });

      // Response might be a string or object
      if (typeof responseData === 'string') {
        // Check if it looks like plain text/markdown (starts with readable text)
        const trimmed = responseData.trim();
        if (trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          // Plain text response - likely the audit report itself
          logger.info('Detected plain text response (audit report)', {
            length: trimmed.length,
            preview: trimmed.substring(0, 100)
          });
          return trimmed;
        }

        // Try parsing as complete JSON first
        try {
          const jsonData = JSON.parse(responseData);

          // Handle object response with data field
          if (jsonData.data) {
            logger.info('Found data in JSON object');
            return jsonData.data;
          }

          // Handle array of chunks
          if (Array.isArray(jsonData)) {
            let fullResponse = '';
            for (const chunk of jsonData) {
              if (chunk.data) {
                fullResponse += chunk.data;
              }
            }
            if (fullResponse) {
              logger.info('Parsed from JSON array', { length: fullResponse.length });
              return fullResponse;
            }
          }
        } catch (jsonError) {
          // Not valid JSON as a whole, try line-by-line parsing
          logger.info('Not a single JSON object, trying line-by-line parsing');
        }

        // Split by newlines and parse each JSON chunk (streaming format)
        const lines = responseData.trim().split('\n');
        let fullResponse = '';
        let parsedLines = 0;

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const chunk: ChainGPTStreamResponse = JSON.parse(line);
            if (chunk.data) {
              fullResponse += chunk.data;
              parsedLines++;
            }
            if (chunk.error) {
              logger.error('ChainGPT stream error', { error: chunk.error });
            }
          } catch (e) {
            // Try extracting data: prefix format (SSE-style)
            if (line.startsWith('data: ')) {
              try {
                const dataJson = JSON.parse(line.substring(6));
                if (dataJson.data) {
                  fullResponse += dataJson.data;
                  parsedLines++;
                }
              } catch (sseError) {
                // Skip invalid SSE lines
                continue;
              }
            }
            // Skip other invalid JSON lines
            continue;
          }
        }

        logger.info('Parsed streaming response', {
          lines: lines.length,
          parsedLines,
          responseLength: fullResponse.length
        });

        // If we got content from parsing, return it
        if (fullResponse) {
          return fullResponse;
        }

        // Otherwise return the original string (might be plain text)
        logger.info('Returning original string as fallback');
        return responseData.trim();
      } else if (responseData && typeof responseData === 'object') {
        // Handle direct object response
        if (responseData.data) {
          logger.info('Found data in object response');
          return responseData.data;
        }

        // Handle result field
        if (responseData.result) {
          logger.info('Found result in object response');
          return responseData.result;
        }
      }

      logger.warn('Could not extract data from response', {
        responseType: typeof responseData,
        keys: responseData && typeof responseData === 'object' ? Object.keys(responseData) : []
      });

      return '';
    } catch (error) {
      logger.error('Error parsing ChainGPT response', {
        error: error instanceof Error ? error.message : String(error)
      });
      return '';
    }
  }

  /**
   * Extracts structured vulnerability information from the audit report
   */
  private extractVulnerabilities(auditReport: string): {
    critical: string[];
    high: string[];
    medium: string[];
    low: string[];
    informational: string[];
  } {
    const vulnerabilities = {
      critical: [] as string[],
      high: [] as string[],
      medium: [] as string[],
      low: [] as string[],
      informational: [] as string[],
    };

    // Look for common vulnerability patterns in the report
    const lines = auditReport.toLowerCase().split('\n');

    for (const line of lines) {
      // Critical severity indicators
      if (line.includes('critical') && (line.includes('vulnerability') || line.includes('issue'))) {
        vulnerabilities.critical.push(line.trim());
      }
      // High severity indicators
      else if (line.includes('high') && (line.includes('severity') || line.includes('risk'))) {
        vulnerabilities.high.push(line.trim());
      }
      // Medium severity indicators
      else if (line.includes('medium') && (line.includes('severity') || line.includes('risk'))) {
        vulnerabilities.medium.push(line.trim());
      }
      // Low severity indicators
      else if (line.includes('low') && (line.includes('severity') || line.includes('risk'))) {
        vulnerabilities.low.push(line.trim());
      }
      // Informational
      else if (line.includes('informational') || line.includes('note:')) {
        vulnerabilities.informational.push(line.trim());
      }
    }

    return vulnerabilities;
  }

  /**
   * Generates a concise summary from the audit report
   */
  private generateSummary(
    auditReport: string,
    vulnerabilities: {
      critical: string[];
      high: string[];
      medium: string[];
      low: string[];
      informational: string[];
    }
  ): string {
    const criticalCount = vulnerabilities.critical.length;
    const highCount = vulnerabilities.high.length;
    const mediumCount = vulnerabilities.medium.length;
    const lowCount = vulnerabilities.low.length;

    let summary = '📋 Audit Summary: ';

    if (criticalCount > 0) {
      summary += `${criticalCount} Critical `;
    }
    if (highCount > 0) {
      summary += `${highCount} High `;
    }
    if (mediumCount > 0) {
      summary += `${mediumCount} Medium `;
    }
    if (lowCount > 0) {
      summary += `${lowCount} Low `;
    }

    if (criticalCount === 0 && highCount === 0 && mediumCount === 0 && lowCount === 0) {
      summary += 'No major vulnerabilities detected';
    } else {
      summary += 'vulnerabilities found';
    }

    // Add risk level emoji
    if (criticalCount > 0) {
      summary = '🚨 ' + summary;
    } else if (highCount > 0) {
      summary = '⚠️ ' + summary;
    } else if (mediumCount > 0) {
      summary = '🟡 ' + summary;
    } else {
      summary = '✅ ' + summary;
    }

    return summary;
  }

  /**
   * Cleans markdown symbols from the audit report
   * Removes ###, **, __, etc. for cleaner Telegram display
   */
  private cleanMarkdownSymbols(text: string): string {
    let cleaned = text;

    // Remove markdown headers (###, ##, #)
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

    // Remove bold (**text** or __text__)
    cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1');
    cleaned = cleaned.replace(/__(.*?)__/g, '$1');

    // Remove italic (*text* or _text_)  - but be careful not to break underscores in code
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
    cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

    // Remove strikethrough (~~text~~)
    cleaned = cleaned.replace(/~~(.*?)~~/g, '$1');

    // Remove code blocks (```...```) but keep the content
    cleaned = cleaned.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');

    // Remove inline code (`text`) but keep the content
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

    // Remove links but keep the text [text](url)
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove horizontal rules (---, ***, ___)
    cleaned = cleaned.replace(/^[\-\*_]{3,}\s*$/gm, '');

    // Remove blockquotes (> text)
    cleaned = cleaned.replace(/^>\s+/gm, '');

    // Clean up extra blank lines (more than 2 consecutive)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }
}

// Export singleton instance
export const chainGPTAuditor = new ChainGPTAuditor();
