import { prop, getModelForClass, pre, modelOptions, Severity } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';

@pre<WalletWatch>('save', function() {
  if (this.isNew) {
    this.createdAt = new Date();
  }
  this.updatedAt = new Date();
})
@modelOptions({ 
  options: { allowMixed: Severity.ALLOW }
})
export class WalletWatch extends TimeStamps {
  @prop({ required: true })
  public telegramId!: number;

  @prop({ required: true })
  public walletAddress!: string;

  @prop()
  public alias?: string;

  @prop({ default: true })
  public isActive!: boolean;

  @prop({ default: Date.now })
  public lastNotified?: Date;

  @prop({ default: 0 })
  public transactionCount!: number;
}

export const WalletWatchModel = getModelForClass(WalletWatch);