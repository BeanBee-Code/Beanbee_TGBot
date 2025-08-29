import * as cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { DailySummaryService } from './dailySummary';
import logger from '@/utils/logger';

const log = logger.child({ module: 'notificationScheduler' });

export class NotificationScheduler {
  private dailySummaryService: DailySummaryService;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(bot: Telegraf) {
    this.dailySummaryService = new DailySummaryService(bot);
  }

  start() {
    // Run every hour at the beginning of the hour
    this.cronJob = cron.schedule('0 * * * *', async () => {
      log.info('Running hourly notification check');
      try {
        await this.dailySummaryService.sendDailySummaries();
      } catch (error) {
        log.error('Error in notification scheduler:', error);
      }
    });

    log.info('Notification scheduler started');
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      log.info('Notification scheduler stopped');
    }
  }
}