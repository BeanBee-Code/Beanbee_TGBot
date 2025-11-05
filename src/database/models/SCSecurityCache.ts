// src/database/models/SCSecurityCache.ts
import { prop, getModelForClass, ModelOptions } from '@typegoose/typegoose';

/**
 * Smart Contract Security Cache Model
 * Stores HAPI Labs smart contract security analysis results
 */
@ModelOptions({ schemaOptions: { timestamps: true } })
class SCSecurityCacheClass {
  @prop({ required: true, lowercase: true })
  contractAddress!: string;

  @prop({ required: true, lowercase: true, default: 'bsc' })
  chain!: string;

  @prop({ required: true, type: () => Object })
  securityData!: any; // Stores SCSecurityAnalysis object

  @prop({ required: true })
  cachedAt!: Date;

  @prop()
  createdAt?: Date;

  @prop()
  updatedAt?: Date;
}

// Create model and export
export const SCSecurityCache = getModelForClass(SCSecurityCacheClass);

// Create indexes after model initialization
SCSecurityCache.collection.createIndex(
  { contractAddress: 1, chain: 1 },
  { unique: true }
);

SCSecurityCache.collection.createIndex(
  { cachedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 } // Auto-delete after 7 days
);
