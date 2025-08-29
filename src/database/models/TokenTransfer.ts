import { prop, getModelForClass, modelOptions, index, Severity } from '@typegoose/typegoose';

@modelOptions({
  schemaOptions: {
    collection: 'tokentransfers',
    timestamps: true
  },
  options: {
    allowMixed: Severity.ALLOW
  }
})
@index({ walletAddress: 1, tokenAddress: 1, blockTimestamp: -1 }) // Compound index for efficient queries
@index({ updatedAt: 1 }) // For cache expiration
export class TokenTransfer {
  @prop({ required: true })
  walletAddress!: string; // The wallet we're analyzing

  @prop({ required: true })
  tokenAddress!: string; // The token contract address

  @prop({ required: true, unique: true })
  hash!: string; // Transaction hash

  @prop({ required: true })
  blockNumber!: string;

  @prop({ required: true })
  blockTimestamp!: Date;

  @prop({ required: true })
  fromAddress!: string;

  @prop({ required: true })
  toAddress!: string;

  @prop({ required: true })
  value!: string; // Raw value in wei

  @prop({ required: true })
  valueDecimal!: string; // Human-readable value

  @prop()
  tokenName?: string;

  @prop()
  tokenSymbol?: string;

  @prop()
  tokenDecimals?: number;

  @prop()
  tokenLogo?: string;

  @prop({ default: false })
  possibleSpam?: boolean;

  @prop()
  securityScore?: number;

  @prop({ default: false })
  verifiedContract?: boolean;

  // Transfer direction relative to the wallet
  @prop({ required: true, enum: ['in', 'out', 'self'] })
  direction!: 'in' | 'out' | 'self';

  // Metadata about when we fetched this data
  @prop({ required: true })
  fetchedAt!: Date;

  // The date range this transfer was fetched for (to know what period we've covered)
  @prop({ required: true })
  fetchedForDateRange!: {
    from: Date;
    to: Date;
  };
}

export const TokenTransferModel = getModelForClass(TokenTransfer);