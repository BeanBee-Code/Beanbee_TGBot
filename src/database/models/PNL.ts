import { prop, getModelForClass, modelOptions, Severity } from '@typegoose/typegoose';

interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
}

export interface TokenPNL {
  realizedPNL: number;
  unrealizedPNL: number;
  totalPNL: number;
  currentHoldings: number;
  averageBuyPrice: number;
  currentPrice: number;
}

@modelOptions({
  schemaOptions: {
    collection: 'pnls',
    timestamps: true
  },
  options: {
    allowMixed: Severity.ALLOW
  }
})
export class PNL {
  @prop({ required: true, unique: true })
  walletAddress!: string;

  @prop({ required: true })
  lastUpdated!: Date;

  @prop({ required: true })
  lastTransaction!: string;

  @prop({ type: () => Object, required: true })
  pnl!: Record<string, number>; // Legacy field for backward compatibility

  @prop({ type: () => Object })
  detailedPNL?: Record<string, TokenPNL>;

  @prop({ type: () => Number, default: 0 })
  totalPNL!: number;

  @prop({ type: () => Number, default: 0 })
  totalRealizedPNL?: number;

  @prop({ type: () => Number, default: 0 })
  totalUnrealizedPNL?: number;

  @prop({ type: () => Object })
  tokenMetadata?: Record<string, TokenInfo>;
}

export const PNLModel = getModelForClass(PNL);