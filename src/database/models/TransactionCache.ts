import { prop, getModelForClass } from '@typegoose/typegoose';

class TransactionCacheClass {
  @prop({ required: true })
  walletAddress!: string;

  @prop({ required: true })
  lastFetchedAt!: Date;

  @prop({ type: () => [Transaction] })
  transactions?: Transaction[];

  @prop({ default: 0 })
  totalValue!: number;

  @prop({ default: false })
  isWhale!: boolean;

  @prop({ type: () => [String] })
  topTokens?: string[];
  
  @prop({ type: () => [DiamondHandsData] })
  diamondHandsData?: DiamondHandsData[];
  
  @prop({ type: () => [HugeValueData] })
  hugeValueData?: HugeValueData[];
}

class DiamondHandsData {
  @prop({ required: true })
  tokenAddress!: string;
  
  @prop({ required: true })
  isDiamondHands!: boolean;
  
  @prop({ required: true })
  holdingDays!: number;
  
  @prop()
  firstTransactionDate?: Date;
}

class HugeValueData {
  @prop({ required: true })
  tokenAddress!: string;
  
  @prop({ required: true })
  isHugeValue!: boolean;
  
  @prop({ required: true })
  hugeValueAmount!: number;
  
  @prop()
  lastChecked?: Date;
}

class Transaction {
  @prop()
  hash!: string;

  @prop()
  timestamp!: Date;

  @prop()
  tokenAddress!: string;

  @prop()
  tokenSymbol!: string;

  @prop()
  tokenName!: string;

  @prop()
  amount!: string;

  @prop()
  value!: number;

  @prop()
  from!: string;

  @prop()
  to!: string;
}

export const TransactionCache = getModelForClass(TransactionCacheClass);
export default TransactionCache;