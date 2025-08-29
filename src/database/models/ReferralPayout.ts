import { prop, getModelForClass, modelOptions, Ref } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';
import { User } from './User';

/**
 * Model to track referral payouts to users
 * Each record represents a successful BNB payout from referral earnings
 */
@modelOptions({
  schemaOptions: { collection: 'referral_payouts', timestamps: true }
})
export class ReferralPayout extends TimeStamps {
  @prop({ ref: () => User, required: true, index: true })
  public user!: Ref<User>; // User who received the payout

  @prop({ type: () => String, required: true })
  public bnbAmount!: string; // BNB amount paid out (stored as string for precision)

  @prop({ required: true })
  public recipientWalletAddress!: string; // Wallet address that received the funds

  @prop({ required: true, unique: true })
  public transactionHash!: string; // On-chain transaction hash

  @prop({ default: 'completed' })
  public status!: 'pending' | 'completed' | 'failed';
}

export const ReferralPayoutModel = getModelForClass(ReferralPayout);