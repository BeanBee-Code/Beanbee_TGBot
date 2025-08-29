import { prop, getModelForClass, ModelOptions } from '@typegoose/typegoose';

@ModelOptions({ 
  schemaOptions: { 
    timestamps: true
  } 
})
export class SentimentCache {
  @prop({ required: true, index: true })
  key!: string; // Format: sentiment_{timeframe} or sentiment_{timeframe}_{date}

  @prop({ required: true, enum: ['1h', '24h', '7d', '30d'] })
  timeframe!: string;

  @prop({ required: true })
  overallScore!: number; // 0 to 100

  @prop({ required: true, enum: ['Very Bearish', 'Bearish', 'Neutral', 'Bullish', 'Very Bullish'] })
  overallLabel!: string;

  @prop({ required: true })
  confidence!: number; // 0 to 1

  @prop({ required: true, type: () => Object })
  newsData!: {
    score: number;
    articles: number;
    topHeadlines: string[];
  };

  @prop({ required: true, type: () => Object })
  socialData!: {
    score: number;
    mentions: number;
    trending: boolean;
  };

  @prop({ required: true, type: () => Object })
  marketData!: {
    priceChange24h: number;
    volumeChange24h: number;
    dominance: number;
  };

  @prop({ type: () => [String] })
  insights!: string[];

  @prop({ required: true })
  dataTimestamp!: Date; // When the sentiment data was generated

  @prop({ required: true })
  expiresAt!: Date; // TTL for automatic deletion

  @prop()
  createdAt?: Date;

  @prop()
  updatedAt?: Date;
}

export const SentimentCacheModel = getModelForClass(SentimentCache);