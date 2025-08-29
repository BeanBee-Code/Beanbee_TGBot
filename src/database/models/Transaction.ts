import { prop, getModelForClass, modelOptions, Severity } from '@typegoose/typegoose';

@modelOptions({
  schemaOptions: {
    collection: 'transactions',
    timestamps: true
  },
  options: {
    allowMixed: Severity.ALLOW
  }
})
export class Transaction {
  @prop({ required: true })
  walletAddress!: string;

  @prop({ required: true })
  hash!: string;

  @prop({ required: true })
  blockNumber!: string;

  @prop({ required: true })
  blockTimestamp!: Date;

  @prop({ required: true })
  from!: string;

  @prop({ required: true })
  to!: string;

  @prop({ required: true })
  value!: string;

  @prop()
  valueDecimal?: number;

  @prop()
  gas?: string;

  @prop()
  gasPrice?: string;

  @prop()
  receiptStatus?: number;

  @prop()
  category?: string;

  @prop()
  method?: string;

  @prop({ type: () => [Object] })
  nativeTransfers?: any[];

  @prop({ type: () => [Object] })
  erc20Transfers?: any[];

  @prop({ type: () => [Object] })
  nftTransfers?: any[];

  @prop({ type: () => Object })
  summary?: any;

  @prop({ type: () => Object })
  possibleSpam?: any;
}

export const TransactionModel = getModelForClass(Transaction);