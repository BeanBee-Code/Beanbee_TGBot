import { SentimentAnalysisService } from '@/services/sentiment';
import { SentimentCacheModel } from '@/database/models/SentimentCache';
import { connectDatabase } from '@/database/connection';
import mongoose from 'mongoose';
import { config } from 'dotenv';

config();

async function testSentimentCache() {
  console.log('🚀 Testing Sentiment Cache Implementation...\n');
  
  try {
    // Connect to database
    await connectDatabase();
    const sentimentService = SentimentAnalysisService.getInstance();
    
    // Clear existing cache
    console.log('📧 Clearing existing cache...');
    sentimentService.clearCache();
    await sentimentService.clearDatabaseCache();
    
    // Test 1: First fetch should call APIs and save to DB if successful
    console.log('\n📊 Test 1: Fetching fresh sentiment data for 24h...');
    const result1 = await sentimentService.analyzeBSCSentiment('24h');
    console.log('Result:', {
      score: result1.overall.score,
      label: result1.overall.label,
      confidence: result1.overall.confidence,
      sources: {
        news: { score: result1.sources.news.score, articles: result1.sources.news.articles },
        social: { score: result1.sources.social.score, mentions: result1.sources.social.mentions },
        market: result1.sources.market
      }
    });
    
    // Check database
    const dbCache = await SentimentCacheModel.findOne({ key: 'sentiment_24h' });
    console.log('\n💾 Database cache status:', dbCache ? 'SAVED' : 'NOT SAVED');
    if (dbCache) {
      console.log('Cached data:', {
        score: dbCache.overallScore,
        label: dbCache.overallLabel,
        hasValidMarketData: dbCache.marketData.priceChange24h !== 0 || dbCache.marketData.volumeChange24h !== 0
      });
    }
    
    // Test 2: Second fetch should use in-memory cache
    console.log('\n📊 Test 2: Fetching again (should use in-memory cache)...');
    const startTime = Date.now();
    const result2 = await sentimentService.analyzeBSCSentiment('24h');
    const duration = Date.now() - startTime;
    console.log(`Fetch duration: ${duration}ms (should be < 50ms for cache hit)`);
    console.log('Results match:', result1.overall.score === result2.overall.score);
    
    // Test 3: Clear in-memory cache and fetch again (should use DB cache)
    console.log('\n📊 Test 3: Clear memory cache and fetch (should use DB cache)...');
    sentimentService.clearCache();
    const result3 = await sentimentService.analyzeBSCSentiment('24h');
    console.log('Using DB cache:', result3.overall.score === result1.overall.score);
    
    // Test 4: Test with different timeframe
    console.log('\n📊 Test 4: Testing different timeframe (7d)...');
    const result4 = await sentimentService.analyzeBSCSentiment('7d');
    console.log('7d sentiment:', {
      score: result4.overall.score,
      label: result4.overall.label
    });
    
    // Check how many items in DB
    const allCaches = await SentimentCacheModel.find({});
    console.log(`\n💾 Total cached items in database: ${allCaches.length}`);
    allCaches.forEach(cache => {
      console.log(`- ${cache.key}: score=${cache.overallScore}, hasValidData=${
        cache.marketData.priceChange24h !== 0 || cache.newsData.articles > 0
      }`);
    });
    
    console.log('\n✅ Test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  }
}

// Run the test
testSentimentCache().then(() => process.exit(0)).catch(() => process.exit(1));