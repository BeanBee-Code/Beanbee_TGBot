import { prop, getModelForClass, modelOptions } from '@typegoose/typegoose';

@modelOptions({
  schemaOptions: {
    timestamps: true,
    collection: 'tokenprices'
  }
})
export class TokenPrice {
  @prop({ required: true, index: true })
  tokenAddress!: string;

  @prop({ required: true })
  chainId!: string;

  @prop({ required: true })
  price!: number;

  @prop()
  priceSource?: string;

  @prop({ default: Date.now })
  lastUpdated!: Date;

  @prop()
  symbol?: string;

  @prop()
  name?: string;

  @prop()
  decimals?: number;
}

export const TokenPriceModel = getModelForClass(TokenPrice);