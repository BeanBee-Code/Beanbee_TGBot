import { prop, modelOptions, getModelForClass, Severity } from '@typegoose/typegoose';
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses';

export enum LeaderboardType {
  OVERALL = 'overall',
  HONEY_BURNED = 'honey_burned',
  LOGIN_STREAK = 'login_streak',
  REFERRALS = 'referrals'
}

@modelOptions({
  schemaOptions: {
    collection: 'leaderboard_entries',
    timestamps: true
  },
  options: {
    allowMixed: Severity.ALLOW
  }
})
export class LeaderboardEntry extends TimeStamps {
  @prop({ required: true, index: true })
  public telegramId!: number;

  @prop({ required: true, enum: LeaderboardType, index: true })
  public type!: LeaderboardType;

  @prop({ required: true, index: true })
  public rank!: number;

  @prop({ required: true })
  public score!: number;

  @prop({ required: true, index: true })
  public period!: string; // Format: YYYY-MM-DD or YYYY-WW for weekly

  // User info for display purposes
  @prop()
  public userName?: string;

  @prop()
  public userRole?: string;

  // Breakdown scores for overall leaderboard
  @prop()
  public scoreBreakdown?: {
    // 计算后的评分（用于内部）
    loginScore?: number;
    honeyScore?: number;
    referralScore?: number;
    roleBonus?: number;
    // 原始数据（用于显示）
    loginStreak: number;
    honeyBurned: number;
    referrals: number;
    actionsUsed?: number; // 仅用于显示，不参与评分
    nectrStaked: number;  // 未来功能
  };

  @prop({ default: Date.now })
  public calculatedAt!: Date;
}

export const LeaderboardEntryModel = getModelForClass(LeaderboardEntry);