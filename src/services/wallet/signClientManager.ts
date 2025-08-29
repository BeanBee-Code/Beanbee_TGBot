import SignClient from "@walletconnect/sign-client";
import { createLogger } from '@/utils/logger';
import { walletConnectStorage } from './walletConnectStorage';

const logger = createLogger('wallet.signClientManager');

/**
 * Singleton manager for WalletConnect SignClient instances
 * Prevents multiple initialization of WalletConnect Core
 */
export class SignClientManager {
  private static instance: SignClient | null = null;
  private static isInitializing: boolean = false;
  static activeTopics: Set<string> = new Set(); // Made public for debugging

  /**
   * Register a session topic as active
   */
  static registerTopic(topic: string) {
    this.activeTopics.add(topic);
    logger.info('🟢 TOPIC REGISTERED', { 
      topic, 
      totalActive: this.activeTopics.size,
      allTopics: Array.from(this.activeTopics),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Unregister a session topic
   */
  static unregisterTopic(topic: string) {
    const wasActive = this.activeTopics.has(topic);
    this.activeTopics.delete(topic);
    logger.info('🔴 TOPIC UNREGISTERED', { 
      topic, 
      wasActive,
      totalActive: this.activeTopics.size,
      remainingTopics: Array.from(this.activeTopics),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Check if a topic is registered as active
   */
  static isTopicActive(topic: string): boolean {
    return this.activeTopics.has(topic);
  }

  /**
   * Get or create a single shared SignClient instance
   * This prevents multiple WalletConnect Core initializations
   */
  static async getClient(): Promise<SignClient> {
    // If already initialized, return existing instance
    if (this.instance) {
      logger.debug('Returning existing SignClient instance');
      return this.instance;
    }

    // If currently initializing, wait for it
    if (this.isInitializing) {
      logger.debug('SignClient is already initializing, waiting...');
      
      // Wait for initialization to complete
      let attempts = 0;
      while (this.isInitializing && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      if (this.instance) {
        return this.instance;
      }
      
      throw new Error('SignClient initialization timeout');
    }

    // Mark as initializing
    this.isInitializing = true;

    try {
      logger.info('🚀 INITIALIZING NEW SIGNCLIENT INSTANCE');
      
      // Initialize storage adapter
      await walletConnectStorage.init();
      
      const client = await SignClient.init({
        projectId: process.env.PROJECT_ID!,
        metadata: {
          name: "BeanBee",
          description: "Your DeFi assistant on Telegram",
          url: "https://beanbee.ai",
          icons: ["https://beanbee.ai/icon.png"],
        },
        storage: walletConnectStorage,
      });
      
      // Add error handlers to prevent crashes
      client.core.relayer.on('relayer_error', (error: any) => {
        logger.warn('Relayer error', { error });
      });
      
      // Handle core errors
      client.core.on('core_error', (error: any) => {
        logger.warn('Core error', { error });
      });
      
      // CRITICAL: Override session validation to prevent crashes from stale topics
      // This intercepts the validation before it can throw errors
      if (client.session) {
        const originalGet = client.session.get.bind(client.session);
        (client.session as any).get = function(topic: string) {
          try {
            return originalGet(topic);
          } catch (error: any) {
            // Only suppress "No matching key" errors
            if (error?.message?.includes('No matching key')) {
              logger.debug('🚫 SESSION.GET - No matching key', { topic });
              return undefined;
            }
            // Re-throw other errors
            throw error;
          }
        };
      }
      
      // Override engine methods that perform validation
      if (client.engine) {
        const engine = client.engine as any;
        
        // Override isValidSessionTopic to NEVER throw errors
        if (engine.isValidSessionTopic) {
          engine.isValidSessionTopic = function(topic: string): boolean {
            // Check if session exists without throwing
            try {
              const sessions = client.session.getAll();
              return sessions.some(s => s.topic === topic);
            } catch (error) {
              logger.debug('🚫 isValidSessionTopic - Returning false', { topic });
              return false;
            }
          };
        }
        
        // Override isValidUpdate to NEVER throw errors
        if (engine.isValidUpdate) {
          engine.isValidUpdate = function(params: any): boolean {
            // Just return false for any update on non-existent sessions
            try {
              const topic = params?.topic;
              if (!topic) return false;
              
              const sessions = client.session.getAll();
              const sessionExists = sessions.some(s => s.topic === topic);
              
              if (!sessionExists) {
                logger.debug('🚫 isValidUpdate - Session does not exist', { topic });
                return false;
              }
              
              return true; // If session exists, assume update is valid
            } catch (error) {
              logger.debug('🚫 isValidUpdate - Error, returning false', { error });
              return false;
            }
          };
        }
        
        // Override isValidEmit to NEVER throw errors
        if (engine.isValidEmit) {
          engine.isValidEmit = function(params: any): boolean {
            // Just return false for any emit on non-existent sessions
            try {
              const topic = params?.topic;
              if (!topic) return false;
              
              const sessions = client.session.getAll();
              const sessionExists = sessions.some(s => s.topic === topic);
              
              if (!sessionExists) {
                logger.debug('🚫 isValidEmit - Session does not exist', { topic });
                return false;
              }
              
              return true; // If session exists, assume emit is valid
            } catch (error) {
              logger.debug('🚫 isValidEmit - Error, returning false', { error });
              return false;
            }
          };
        }
      }
      
      // NUCLEAR OPTION: Override the core session store to prevent "No matching key" errors
      if (client.core && client.core.storage) {
        const storage = client.core.storage as any;
        if (storage.getItem) {
          const originalGetItem = storage.getItem.bind(storage);
          storage.getItem = async function(key: string) {
            try {
              return await originalGetItem(key);
            } catch (error: any) {
              if (error?.message?.includes('No matching key')) {
                logger.debug('💣 STORAGE.GETITEM - No matching key, returning undefined', { key });
                return undefined;
              }
              throw error;
            }
          };
        }
      }
      
      // Override the engine's processRequest to catch errors at the source
      if (client.engine) {
        const engine = client.engine as any;
        
        if (engine.processRequest) {
          const originalProcessRequest = engine.processRequest.bind(engine);
          engine.processRequest = async function(request: any) {
            try {
              return await originalProcessRequest(request);
            } catch (error: any) {
              // If it's a "No matching key" error, suppress it
              if (error?.message?.includes('No matching key') || 
                  error?.message?.includes('session topic doesn\'t exist')) {
                const topic = request?.params?.topic || 'unknown';
                logger.warn('🚫 SUPPRESSED ERROR IN PROCESS REQUEST', { 
                  topic,
                  method: request?.method || 'unknown',
                  error: error.message
                });
                return; // Suppress the error
              }
              // Re-throw other errors
              throw error;
            }
          };
        }
        
        if (engine.onRelayEventRequest) {
          const originalOnRelayEventRequest = engine.onRelayEventRequest.bind(engine);
          engine.onRelayEventRequest = async function(event: any) {
            try {
              return await originalOnRelayEventRequest(event);
            } catch (error: any) {
              // If it's a "No matching key" error, just log and suppress
              if (error?.message?.includes('No matching key') || 
                  error?.message?.includes('session topic doesn\'t exist')) {
                const topic = event?.topic || event?.params?.topic || 'unknown';
                logger.debug('🚫 SUPPRESSED SESSION ERROR IN RELAY', { 
                  topic,
                  method: event?.method || 'unknown',
                  error: error.message
                });
                return; // Suppress the error
              }
              // Re-throw other errors
              throw error;
            }
          };
        }
      }

      // Log all sessions on initialization
      const sessions = client.session.getAll();
      logger.info('📋 SIGNCLIENT SESSIONS ON INIT', {
        count: sessions.length,
        topics: sessions.map(s => s.topic)
      });

      // Override event emission to filter out invalid session events
      const originalEmit = client.events.emit;
      client.events.emit = function(event: any, data?: any): boolean {
        const eventStr = String(event);
        
        // Log every event for debugging
        logger.info('🔔 WALLETCONNECT EVENT', {
          event: eventStr,
          hasData: !!data,
          dataKeys: data ? Object.keys(data) : [],
          topic: data?.topic || data?.params?.topic || 'NO_TOPIC',
          timestamp: new Date().toISOString()
        });
        
        try {
          // Check if this is a session-related event
          if (eventStr.includes('session')) {
            // Try to extract topic
            let topic: string | undefined;
            if (data?.topic) {
              topic = data.topic;
            } else if (data?.params?.topic) {
              topic = data.params.topic;
            }
            
            logger.info('🔍 SESSION EVENT DETAILS', {
              event: eventStr,
              extractedTopic: topic,
              isTopicActive: topic ? SignClientManager.isTopicActive(topic) : false,
              activeTopics: Array.from(SignClientManager.activeTopics),
              timestamp: new Date().toISOString()
            });
            
            // If we have a topic and it's not active, ignore the event
            if (topic && !SignClientManager.isTopicActive(topic)) {
              logger.warn('⚠️ IGNORING INACTIVE TOPIC EVENT', { 
                event: eventStr, 
                topic,
                timestamp: new Date().toISOString()
              });
              return true;
            }
          }
          
          return originalEmit.call(this, event, data);
        } catch (error: any) {
          logger.error('❌ ERROR IN EVENT EMIT', {
            event: eventStr,
            error: error.message,
            stack: error.stack
          });
          
          if (error?.message?.includes('No matching key') || 
              error?.message?.includes('session topic doesn\'t exist')) {
            logger.warn('🚫 SUPPRESSING SESSION ERROR', { 
              event: eventStr, 
              error: error.message,
              timestamp: new Date().toISOString()
            });
            return true;
          }
          throw error;
        }
      };

      this.instance = client;
      logger.info('✅ SIGNCLIENT INITIALIZED SUCCESSFULLY');
      
      return client;
    } catch (error) {
      logger.error('Failed to initialize SignClient', { error });
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Clear the SignClient instance
   */
  static async clear() {
    if (this.instance) {
      logger.info('🧹 CLEARING SIGNCLIENT INSTANCE', {
        activeTopics: Array.from(this.activeTopics),
        timestamp: new Date().toISOString()
      });
      
      try {
        // Clean up event listeners by removing all listeners
        // Note: removeAllListeners() without arguments removes all listeners
        (this.instance.events as any).removeAllListeners();
        
        // Remove core listeners
        if (this.instance.core) {
          (this.instance.core.events as any).removeAllListeners();
          if (this.instance.core.relayer) {
            (this.instance.core.relayer.events as any).removeAllListeners();
          }
        }
        
        // Disconnect all sessions
        const sessions = this.instance.session.getAll();
        logger.info('🔌 DISCONNECTING ALL SESSIONS', {
          count: sessions.length,
          topics: sessions.map(s => s.topic)
        });
        
        for (const session of sessions) {
          try {
            logger.info('🔌 DISCONNECTING SESSION', { topic: session.topic });
            await this.instance.disconnect({
              topic: session.topic,
              reason: { code: 6000, message: 'Client cleared' }
            });
            logger.info('✅ SESSION DISCONNECTED', { topic: session.topic });
          } catch (e) {
            // Ignore disconnect errors
            logger.debug('⚠️ DISCONNECT ERROR (ignored)', { 
              topic: session.topic,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
        
        // Clear storage for all topics
        const { walletConnectStorage } = await import('./walletConnectStorage');
        for (const topic of this.activeTopics) {
          await walletConnectStorage.clearSessionData(topic);
        }
      } catch (error) {
        logger.debug('Error cleaning up client', { error });
      }
      
      this.instance = null;
      this.isInitializing = false;
    }
    
    // Clear all active topics
    const topicsCleared = this.activeTopics.size;
    this.activeTopics.clear();
    logger.info('🗑️ CLEARED ALL ACTIVE TOPICS', {
      count: topicsCleared,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Legacy methods for backward compatibility
   */
  static async clearClient(key: string = 'default') {
    // Just clear the single instance
    await this.clear();
  }

  static async clearAll() {
    // Just clear the single instance
    await this.clear();
  }

  /**
   * Check if client is initialized
   */
  static hasClient(): boolean {
    return this.instance !== null;
  }

  /**
   * Force recreate the SignClient
   * Use this when experiencing persistent connection issues
   */
  static async forceRecreate(): Promise<SignClient> {
    logger.info('🔄 FORCE RECREATING SIGNCLIENT', {
      timestamp: new Date().toISOString(),
      previousActiveTopics: Array.from(this.activeTopics)
    });
    await this.clear();
    logger.info('🧹 CLEARED OLD SIGNCLIENT', {
      timestamp: new Date().toISOString()
    });
    const newClient = await this.getClient();
    logger.info('✨ NEW SIGNCLIENT CREATED', {
      timestamp: new Date().toISOString()
    });
    return newClient;
  }
}