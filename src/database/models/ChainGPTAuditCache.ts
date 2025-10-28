/**
 * ChainGPT Audit Cache Model
 *
 * Stores ChainGPT smart contract audit results to avoid redundant API calls
 * and provide instant audit reports for previously analyzed contracts.
 */

import { prop, getModelForClass, modelOptions, Severity } from '@typegoose/typegoose';

@modelOptions({
  schemaOptions: {
    collection: 'chaingpt_audit_cache',
    timestamps: true,
  },
  options: {
    allowMixed: Severity.ALLOW,
  },
})
export class ChainGPTAuditCache {
  /**
   * Contract address (lowercased for consistency)
   */
  @prop({ required: true, index: true, lowercase: true })
  contractAddress!: string;

  /**
   * Chain ID (56 for BSC, 1 for Ethereum, etc.)
   */
  @prop({ required: true, index: true })
  chainId!: number;

  /**
   * Contract name
   */
  @prop({ required: false })
  contractName?: string;

  /**
   * Full audit report from ChainGPT
   */
  @prop({ required: true })
  auditReport!: string;

  /**
   * Audit summary
   */
  @prop({ required: false })
  summary?: string;

  /**
   * Extracted vulnerabilities (if any)
   */
  @prop({ required: false, type: () => Object })
  vulnerabilities?: {
    critical: string[];
    high: string[];
    medium: string[];
    low: string[];
    informational: string[];
  };

  /**
   * Compiler version of the audited contract
   */
  @prop({ required: false })
  compilerVersion?: string;

  /**
   * Timestamp of when the audit was performed
   */
  @prop({ required: true })
  auditedAt!: Date;

  /**
   * TTL index - automatically delete after 30 days
   */
  @prop({ required: true, expires: 2592000 }) // 30 days in seconds
  expiresAt!: Date;

  /**
   * How many times this cached audit has been retrieved
   */
  @prop({ required: true, default: 0 })
  hitCount!: number;

  /**
   * Last time this cached audit was accessed
   */
  @prop({ required: false })
  lastAccessedAt?: Date;
}

// Create compound index for efficient lookups
export const ChainGPTAuditCacheModel = getModelForClass(ChainGPTAuditCache);

// Create compound index
ChainGPTAuditCacheModel.collection.createIndex(
  { contractAddress: 1, chainId: 1 },
  { unique: true }
).catch(() => {
  // Index may already exist
});
