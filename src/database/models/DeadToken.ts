import { getModelForClass, prop, index } from '@typegoose/typegoose';

@index({ tokenAddress: 1, chain: 1 }, { unique: true })
@index({ detectedAt: 1 })
@index({ isActive: 1 })
export class DeadToken {
	@prop({ required: true, lowercase: true })
	public tokenAddress!: string;

	@prop({ required: true, default: '0x38' })
	public chain!: string;

	@prop({ required: true })
	public symbol!: string;

	@prop({ required: true })
	public name!: string;

	@prop({ required: true, enum: ['no_liquidity', 'no_activity', 'no_analytics', 'invalid_metadata'] })
	public reason!: 'no_liquidity' | 'no_activity' | 'no_analytics' | 'invalid_metadata';

	@prop({ type: () => Object })
	public analytics?: {
		totalLiquidityUsd: string;
		totalBuys24h: number;
		totalSells24h: number;
		uniqueWallets24h: number;
		usdPrice: string;
	};

	@prop({ required: true, default: Date.now })
	public detectedAt!: Date;

	@prop({ required: true, default: true })
	public isActive!: boolean;

	@prop()
	public lastCheckedAt?: Date;

	@prop({ default: 1 })
	public detectionCount!: number;
}

export const DeadTokenModel = getModelForClass(DeadToken, {
	schemaOptions: {
		collection: 'deadtokens',
		timestamps: true,
	},
});