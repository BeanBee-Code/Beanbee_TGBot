import { prop, getModelForClass, pre, modelOptions, Severity } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';
import { SessionTypes } from '@walletconnect/types';
import { Types } from 'mongoose';

@pre<User>('save', function() {
  if (this.isNew) {
    this.createdAt = new Date();
  }
  this.updatedAt = new Date();
})
@modelOptions({ 
  options: { allowMixed: Severity.ALLOW }
})
export class User extends TimeStamps {
  @prop({ required: true, unique: true })
  public telegramId!: number;

  @prop()
  public walletAddress?: string;

  @prop({ enum: ['walletconnect'], default: 'walletconnect' })
  public walletProvider?: string;

  @prop()
  public walletConnectTopic?: string;

  @prop({ type: () => Object })
  public walletConnectSession?: SessionTypes.Struct;

  @prop({ default: Date.now })
  public lastConnected?: Date;

  @prop({ default: true })
  public isActive!: boolean;

  @prop()
  public tradingWalletAddress?: string;

  @prop()
  public encryptedPrivateKey?: string;

  @prop()
  public encryptionIv?: string;

  @prop({ default: false })
  public privateKeyExported!: boolean;

  @prop({ default: 'en' })
  public language!: string;

  @prop()
  public name?: string;

  @prop({ default: false })
  public hasChosenAnonymous!: boolean;

  @prop({ default: true })
  public dailyNotificationEnabled!: boolean;

  @prop({ default: 9 })
  public dailyNotificationHour!: number;

  @prop()
  public dailyNotificationLastSent?: Date;

  @prop({ default: 'UTC' })
  public timezone!: string;

  @prop({ default: true })
  public showTradeConfirmations!: boolean;

  @prop({ default: false })
  public debugMode!: boolean;

  @prop()
  public referralCode?: string;

  @prop({ ref: () => User })
  public referrer?: Types.ObjectId;

  @prop({
    default: () => ({
      firstHand: 10,
      secondHand: 5,
      thirdHand: 2
    })
  })
  public referralPercents!: {
    firstHand: number;
    secondHand: number;
    thirdHand: number;
  };

  @prop({ default: 0 })
  public discountPercentage!: number;

  @prop()
  public discountExpiry?: Date;
  
  // Referral earnings tracking
  @prop({ type: () => String, default: '0' })
  public unclaimedReferralBNB!: string; // Stored as string for precision

  @prop({ type: () => String, default: '0' })
  public totalReferralBNBEarned!: string; // Stored as string for precision

  // Keeper Identity System
  @prop({ default: false })
  public isKeeper!: boolean;

  @prop({ enum: ['keeper', 'worker_bee', 'forager', 'swarm_leader', 'queen_bee'] })
  public role?: string;

  @prop({ default: 0 })
  public dailyHoney!: number;

  @prop()
  public lastHoneyClaimDate?: Date;

  @prop({ default: 0 })
  public totalHoneyEarned!: number;

  @prop({ default: 0 })
  public activeReferralsCount!: number;

  @prop({ default: 0 })
  public consecutiveActiveDays!: number;

  @prop()
  public lastActiveDate?: Date;

  @prop({ default: Date.now })
  public keeperSince!: Date;

  @prop()
  public roleUpgradedAt?: Date;

  // New fields for role progression
  @prop({ default: 0 })
  public totalHoneyBurned!: number;

  @prop({ default: 0 })
  public purchasedHoney!: number;

  @prop({ default: 0 })
  public nectrStaked!: number;

  @prop({ default: 0 })
  public totalActionsUsed!: number;

  @prop({ enum: ['bnb', 'opbnb'], default: 'bnb' })
  public selectedChain!: string;

  static async countReferrals(user: User): Promise<number> {
    return await UserModel.countDocuments({ referrer: (user as any)._id });
  }
}

export const UserModel = getModelForClass(User);