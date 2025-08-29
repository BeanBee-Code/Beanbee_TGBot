import { LeaderboardService } from './leaderboard';
import { createLogger } from '../utils/logger';

const logger = createLogger('leaderboard.scheduler');

export class LeaderboardScheduler {
  private static intervalId: NodeJS.Timeout | null = null;
  private static cleanupIntervalId: NodeJS.Timeout | null = null;

  /**
   * Start the leaderboard scheduler
   */
  static start(): void {
    logger.info('Starting leaderboard scheduler...');

    // Update leaderboards daily at midnight (00:00)
    this.intervalId = setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        try {
          logger.info('Daily leaderboard update starting...');
          await LeaderboardService.updateLeaderboards();
          logger.info('Daily leaderboard update completed');
        } catch (error) {
          logger.error('Error during daily leaderboard update', { error });
        }
      }
    }, 60 * 1000); // Check every minute

    // Clean up old entries daily at 2 AM
    this.cleanupIntervalId = setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 2 && now.getMinutes() === 0) {
        try {
          logger.info('Starting leaderboard cleanup...');
          await LeaderboardService.cleanupOldEntries();
          logger.info('Leaderboard cleanup completed');
        } catch (error) {
          logger.error('Error during leaderboard cleanup', { error });
        }
      }
    }, 60 * 1000); // Check every minute

    // Initial update
    this.initialUpdate();

    logger.info('Leaderboard scheduler started successfully');
  }

  /**
   * Stop the leaderboard scheduler
   */
  static stop(): void {
    logger.info('Stopping leaderboard scheduler...');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    logger.info('Leaderboard scheduler stopped');
  }

  /**
   * Perform initial leaderboard update
   */
  private static async initialUpdate(): Promise<void> {
    try {
      logger.info('Performing initial leaderboard update...');
      
      // Add a small delay to ensure database is ready
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await LeaderboardService.updateLeaderboards();
      logger.info('Initial leaderboard update completed successfully');
    } catch (error) {
      logger.error('Error during initial leaderboard update', { 
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // Retry once after 10 seconds
      setTimeout(async () => {
        try {
          logger.info('Retrying initial leaderboard update...');
          await LeaderboardService.updateLeaderboards();
          logger.info('Retry leaderboard update completed successfully');
        } catch (retryError) {
          logger.error('Retry leaderboard update also failed', { retryError });
        }
      }, 10000);
    }
  }

  /**
   * Get next update time
   */
  static getNextUpdateTime(): Date {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // Next midnight
    return next;
  }
}