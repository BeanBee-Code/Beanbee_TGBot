import { prop, getModelForClass, modelOptions, Ref } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';
import { User } from './User';
import { HoneyTransaction } from './HoneyTransaction';

/**
 * Model to track individual referral earnings
 * Each record represents one earning event when a referred user makes a purchase
 */
@modelOptions({
  schemaOptions: { collection: 'referral_earnings', timestamps: true }
})
export class ReferralEarning extends TimeStamps {
  @prop({ ref: () => User, required: true, index: true })
  public earningUser!: Ref<User>; // User who earned the referral reward

  @prop({ ref: () => User, required: true })
  public fromUser!: Ref<User>; // User who made the purchase

  @prop({ ref: () => HoneyTransaction, required: true })
  public sourceTransaction!: Ref<HoneyTransaction>; // The honey purchase transaction

  @prop({ required: true })
  public tier!: number; // Referral tier (1=direct, 2=indirect, 3=third-level)

  @prop({ type: () => String, required: true })
  public bnbAmount!: string; // BNB amount earned (stored as string for precision)

  @prop({ required: true })
  public usdValueAtTime!: number; // USD value at the time of earning

  @prop({ default: false, index: true })
  public isClaimed!: boolean; // Whether this earning has been claimed

  @prop()
  public payoutTransactionHash?: string; // Transaction hash when claimed
}

export const ReferralEarningModel = getModelForClass(ReferralEarning);