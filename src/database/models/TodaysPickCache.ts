import { prop, getModelForClass, modelOptions } from '@typegoose/typegoose';

export interface TodaysPickData {
  tokenAddress: string;
  name: string;
  symbol: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  safetyScore: number;
  buyerCount24h?: number; // 24-hour buyer count
  sellerCount24h?: number; // 24-hour seller count
}

@modelOptions({
  schemaOptions: {
    collection: 'todayspickcache',
    timestamps: true,
  },
})
export class TodaysPickCache {
  @prop({ required: true, unique: true, default: 'bsc_top_5' })
  key!: string;

  @prop({ type: () => [Object], required: true })
  picks!: TodaysPickData[];

  @prop({ required: true, expires: '24h' })
  expiresAt!: Date;
}

export const TodaysPickCacheModel = getModelForClass(TodaysPickCache);