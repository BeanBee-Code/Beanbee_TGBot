import { prop, getModelForClass, ModelOptions } from '@typegoose/typegoose';

@ModelOptions({ schemaOptions: { timestamps: true } })
export class NewsCache {
  @prop({ required: true, unique: true })
  date!: string; // Format: YYYY-MM-DD

  @prop({ required: true })
  summary!: string;

  @prop({ type: () => [String] })
  topics!: string[];

  @prop()
  rawData?: string;

  @prop({ default: false })
  isProcessed!: boolean;

  @prop()
  createdAt?: Date;

  @prop()
  updatedAt?: Date;
}

export const NewsCacheModel = getModelForClass(NewsCache);