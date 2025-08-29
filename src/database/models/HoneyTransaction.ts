import { prop, getModelForClass, modelOptions, Ref } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';
import { User } from './User';

export enum HoneyTransactionType {
  DAILY_CLAIM = 'daily_claim',
  TASK_REWARD = 'task_reward',
  REFERRAL_BONUS = 'referral_bonus',
  FEATURE_USAGE = 'feature_usage',
  NECTR_EXCHANGE = 'nectr_exchange',
  ADMIN_GRANT = 'admin_grant',
  BNB_PURCHASE = 'bnb_purchase',
  REFERRAL_CONVERSION = 'referral_conversion' // New type for converting referral BNB to Honey
}

export enum HoneyFeature {
  WALLET_SCAN = 'wallet_scan',
  TOKEN_ANALYSIS = 'token_analysis',
  RUG_ALERT = 'rug_alert',
  STRATEGY_EXECUTION = 'strategy_execution',
  PRICE_ALERT = 'price_alert',
  TRADE_ALERT = 'trade_alert',
  YIELD_TIPS = 'yield_tips',
  MARKET_SENTIMENT = 'market_sentiment',
  AI_QUERY = 'ai_query' // Added for natural language AI queries
}

@modelOptions({ 
  schemaOptions: { collection: 'honey_transactions' }
})
export class HoneyTransaction extends TimeStamps {
  @prop({ ref: () => User, required: true })
  public user!: Ref<User>;

  @prop({ required: true })
  public telegramId!: number;

  @prop({ enum: HoneyTransactionType, required: true })
  public type!: HoneyTransactionType;

  @prop({ required: true })
  public amount!: number; // Positive for earnings, negative for spending

  @prop({ required: true })
  public balanceAfter!: number;

  @prop({ enum: HoneyFeature })
  public feature?: HoneyFeature;

  @prop()
  public description?: string;

  @prop()
  public metadata?: Record<string, any>;

  @prop({ default: Date.now })
  public timestamp!: Date;
}

export const HoneyTransactionModel = getModelForClass(HoneyTransaction);