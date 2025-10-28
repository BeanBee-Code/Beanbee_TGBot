// src/database/models/AddressRiskCache.ts
import { prop, getModelForClass, ModelOptions } from '@typegoose/typegoose';

/**
 * Address Risk Cache Model
 * Stores HAPI Labs address risk assessment results
 */
@ModelOptions({ schemaOptions: { timestamps: true } })
class AddressRiskCacheClass {
  @prop({ required: true, lowercase: true })
  address!: string;

  @prop({ required: true, lowercase: true, default: 'bsc' })
  network!: string;

  @prop({ required: true, type: () => Object })
  riskData!: any; // Stores AddressRiskResult object

  @prop({ required: true })
  cachedAt!: Date;

  @prop()
  createdAt?: Date;

  @prop()
  updatedAt?: Date;
}

// Create model and export
export const AddressRiskCache = getModelForClass(AddressRiskCacheClass);

// Create indexes after model initialization
AddressRiskCache.collection.createIndex(
  { address: 1, network: 1 },
  { unique: true }
);

AddressRiskCache.collection.createIndex(
  { cachedAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60 } // Auto-delete after 24 hours
);
