import { getModelForClass, index, modelOptions, prop, Severity } from '@typegoose/typegoose';

export interface TokenDetail {
  token_type: string;
  symbol: string;
  token_address?: string;
  balance_formatted: string;
  usd_value: number;
}

export interface DeFiProtocolPosition {
  protocol_name: string;
  protocol_id: string;
  protocol_url: string;
  balance_usd: number;
  total_unclaimed_usd_value: number;
  tokens: TokenDetail[];
  yearly_earnings_usd: number;
  apy?: number;
  poolId?: string;
}

export interface StakingPosition {
  protocol: string;
  tokenSymbol: string;
  tokenAddress: string;
  stakedAmount: string;
  stakedAmountFormatted: string;
  usdValue: number;
  unlockTime?: Date;
  contractAddress?: string;
}

@modelOptions({
  schemaOptions: {
    timestamps: true,
    collection: 'defipositions'
  },
  options: {
    allowMixed: Severity.ALLOW
  }
})
@index({ userId: 1, walletAddress: 1 })
@index({ lastRefreshAt: 1 })
export class DeFiPositionClass {
  @prop({ required: true })
  userId!: number;

  @prop({ required: true, lowercase: true })
  walletAddress!: string;

  @prop({ type: () => [Object], default: [] })
  defiPositions!: DeFiProtocolPosition[];

  @prop({ type: () => [Object], default: [] })
  stakingPositions!: StakingPosition[];

  @prop({ required: true, default: 0 })
  totalDefiValue!: number;

  @prop({ required: true, default: 0 })
  totalStakingValue!: number;

  @prop({ required: true, default: Date.now })
  lastRefreshAt!: Date;

  @prop({ default: 0 })
  apiCallsSaved!: number;

  @prop({ type: () => [String], default: [] })
  detectedProtocols!: string[];

  @prop({ default: false })
  hasActivePositions!: boolean;
}

export const DeFiPosition = getModelForClass(DeFiPositionClass);