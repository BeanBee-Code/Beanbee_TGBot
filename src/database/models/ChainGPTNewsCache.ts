/**
 * ChainGPT News Cache Model
 *
 * Stores ChainGPT news articles to avoid redundant API calls.
 * Fetches 5 news articles per day and caches them for 24 hours.
 */

import { prop, getModelForClass, modelOptions, Severity } from '@typegoose/typegoose';

@modelOptions({
  schemaOptions: {
    collection: 'chaingpt_news_cache',
    timestamps: true,
  },
  options: {
    allowMixed: Severity.ALLOW,
  },
})
export class ChainGPTNewsCache {
  /**
   * Unique news article ID from ChainGPT
   */
  @prop({ required: true, unique: true })
  newsId!: number;

  /**
   * News article title
   */
  @prop({ required: true })
  title!: string;

  /**
   * News article description/summary
   */
  @prop({ required: true })
  description!: string;

  /**
   * Category ID (e.g., 3=DAO, 5=DeFi, 8=NFT)
   */
  @prop({ required: false })
  categoryId?: number;

  /**
   * Category name
   */
  @prop({ required: false })
  categoryName?: string;

  /**
   * Sub-category/Blockchain ID (e.g., 12=BSC, 15=Ethereum)
   */
  @prop({ required: false })
  subCategoryId?: number;

  /**
   * Sub-category name
   */
  @prop({ required: false })
  subCategoryName?: string;

  /**
   * Token ID (e.g., 82=BNB, 80=ETH)
   */
  @prop({ required: false })
  tokenId?: number;

  /**
   * Token name
   */
  @prop({ required: false })
  tokenName?: string;

  /**
   * News article URL
   */
  @prop({ required: true })
  url!: string;

  /**
   * News article image URL
   */
  @prop({ required: false })
  imageUrl?: string;

  /**
   * Publication date of the news article
   */
  @prop({ required: true })
  pubDate!: Date;

  /**
   * Source of the news (e.g., CoinDesk, CoinTelegraph)
   */
  @prop({ required: false })
  source?: string;

  /**
   * The date this news was fetched (for daily refresh logic)
   */
  @prop({ required: true, index: true })
  fetchDate!: Date;

  /**
   * TTL index - automatically delete after 7 days
   */
  @prop({ required: true, expires: 604800 }) // 7 days in seconds
  expiresAt!: Date;

  /**
   * How many times this news has been viewed
   */
  @prop({ required: true, default: 0 })
  viewCount!: number;

  /**
   * Last time this news was accessed
   */
  @prop({ required: false })
  lastAccessedAt?: Date;
}

export const ChainGPTNewsCacheModel = getModelForClass(ChainGPTNewsCache);

// Create index on fetchDate for efficient daily lookups
ChainGPTNewsCacheModel.collection.createIndex(
  { fetchDate: 1 },
  { background: true }
).catch(() => {
  // Index may already exist
});

// Create index on pubDate for sorting by newest
ChainGPTNewsCacheModel.collection.createIndex(
  { pubDate: -1 },
  { background: true }
).catch(() => {
  // Index may already exist
});
