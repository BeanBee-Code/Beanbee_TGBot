import { prop, getModelForClass, index } from '@typegoose/typegoose';

@index({ telegramId: 1, createdAt: -1 }) // Index for efficient queries by user and date
export class ChatHistory {
  @prop({ required: true })
  public telegramId!: number; // Store Telegram ID directly

  @prop({ required: true })
  public role!: 'user' | 'assistant' | 'system';

  @prop({ required: true })
  public content!: string;

  @prop({ required: true, default: 0 })
  public tokenCount!: number;

  @prop({ default: Date.now })
  public createdAt!: Date;

  @prop({ default: true })
  public isActive!: boolean; // For soft deletion or marking messages as excluded
}

export const ChatHistoryModel = getModelForClass(ChatHistory);