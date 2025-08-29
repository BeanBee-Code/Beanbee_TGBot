import { prop, getModelForClass, pre, modelOptions, Severity } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';

@pre<TrackedToken>('save', function() {
  if (this.isNew) {
    this.createdAt = new Date();
  }
  this.updatedAt = new Date();
})
@modelOptions({ 
  options: { allowMixed: Severity.ALLOW }
})
export class TrackedToken extends TimeStamps {
  @prop({ required: true })
  public telegramId!: number;

  @prop({ required: true })
  public tokenAddress!: string;

  @prop({ required: true })
  public pairAddress!: string;

  @prop({ required: true })
  public pairedToken!: string; // WBNB, USDT, BUSD, etc.

  @prop()
  public tokenSymbol?: string;

  @prop()
  public tokenName?: string;

  @prop()
  public totalSupply?: string;

  @prop()
  public currentPrice?: string;

  @prop()
  public marketCap?: string;

  @prop()
  public alias?: string; // User-defined alias for the token

  @prop({ default: true })
  public isActive!: boolean;

  @prop({ default: 0 })
  public notificationCount!: number;

  @prop()
  public lastNotified?: Date;

  @prop({ default: 5 })
  public priceChangeThreshold!: number; // Percentage change threshold for notifications

  @prop({ default: false })
  public enableLargeTransactionAlerts!: boolean;

  @prop({ default: Date.now })
  public addedAt!: Date;

  // Automated trading fields
  @prop({ default: false })
  public isAutoTradeActive!: boolean; // Master switch for auto-trading on this token

  @prop()
  public autoTradeStatus?: 'pending_entry' | 'executing_entry' | 'position_open' | 'completed'; // Current auto-trade status

  // Entry rules
  @prop()
  public marketCapEntryTarget?: number; // Deprecated: Target market cap in USD to trigger buy

  @prop()
  public priceEntryTarget?: number; // Target price in USD to trigger buy

  @prop()
  public entryAmountBNB?: number; // Amount in BNB to buy when entry is triggered
  
  @prop()
  public entryAmountUSD?: number; // Deprecated: Amount in USD to buy when entry is triggered

  // Exit rules
  @prop()
  public takeProfitPrice?: number; // Take profit price in USD

  @prop()
  public stopLossPrice?: number; // Stop loss price in USD
}

export const TrackedTokenModel = getModelForClass(TrackedToken);