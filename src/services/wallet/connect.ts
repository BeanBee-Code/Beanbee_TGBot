import { Context } from 'telegraf';
import SignClient from "@walletconnect/sign-client";
import QRCode from "qrcode";
import { Buffer } from 'buffer';
import { UserSession } from '../../types';
import { UserService } from '../user';
import { mainMenu, mainMenuEdit } from '../../telegram/menus/main';
import { getTranslation } from '@/i18n';
import { createLogger } from '@/utils/logger';
import { SignClientManager } from './signClientManager';

const logger = createLogger('wallet.connect');

export class WalletService {
	private sessionPingIntervals: Map<number, NodeJS.Timeout> = new Map();
	
	constructor(private userSessions: Map<number, UserSession>) { }

	/**
	 * Restore all active wallet sessions on bot startup
	 * This should be called once when the bot starts
	 */
	async restoreAllSessions(): Promise<void> {
		// First, clean up any stale WalletConnect storage entries
		try {
			const { walletConnectStorage } = await import('./walletConnectStorage');
			await walletConnectStorage.cleanupOldEntries(7); // Clean entries older than 7 days
		} catch (error) {
			logger.warn('Failed to cleanup old storage entries', { error });
		}
		try {
			logger.info('🔄 STARTING SESSION RESTORATION...');
			
			// Get all users with active wallet connections
			const activeUsers = await UserService.getActiveUsers();
			const usersWithWallets = activeUsers.filter(user => user.walletAddress && user.walletConnectTopic);
			
			logger.info(`👥 Found ${usersWithWallets.length} users with saved wallet connections`, {
				users: usersWithWallets.map(u => ({ 
					userId: u.telegramId, 
					address: u.walletAddress,
					topic: u.walletConnectTopic 
				}))
			});
			
			// Get the SignClient instance
			const client = await SignClientManager.getClient();
			
			// Get all active sessions from SignClient
			const activeSessions = client.session.getAll();
			logger.info(`📋 SignClient has ${activeSessions.length} active sessions`, {
				topics: activeSessions.map(s => s.topic)
			});
			
			// Clean up orphaned sessions (sessions without corresponding user data)
			const validTopics = new Set(usersWithWallets.map(u => u.walletConnectTopic));
			
			for (const session of activeSessions) {
				if (!validTopics.has(session.topic)) {
					logger.info('Disconnecting orphaned session', { topic: session.topic });
					try {
						await client.disconnect({
							topic: session.topic,
							reason: { code: 6000, message: 'Orphaned session' }
						});
						
						// Clear session storage
						const { walletConnectStorage } = await import('./walletConnectStorage');
						await walletConnectStorage.clearSessionData(session.topic);
					} catch (error) {
						logger.debug('Error disconnecting orphaned session', { topic: session.topic, error });
					}
				}
			}
			
			let restoredCount = 0;
			let invalidCount = 0;
			
			for (const user of usersWithWallets) {
				try {
					// Check if the session still exists in SignClient
					const activeSession = activeSessions.find(s => s.topic === user.walletConnectTopic);
					
					if (activeSession && activeSession.namespaces?.eip155?.accounts?.length > 0) {
						const address = activeSession.namespaces.eip155.accounts[0].split(':')[2];
						
						// Verify the address matches
						if (address.toLowerCase() === user.walletAddress!.toLowerCase()) {
							// Register this topic as active
							SignClientManager.registerTopic(user.walletConnectTopic!);
							
							// Restore the session to memory
							this.userSessions.set(user.telegramId, {
								client,
								address,
								provider: 'walletconnect'
							});
							
							logger.info('✅ SESSION RESTORED', {
								userId: user.telegramId,
								address,
								topic: user.walletConnectTopic,
								expiry: activeSession.expiry
							});
							
							// Set up disconnect handler
							const sessionDeleteHandler = async ({ topic }: { topic: string }) => {
								if (topic === user.walletConnectTopic) {
									logger.info('🔔 SESSION_DELETE EVENT RECEIVED', { userId: user.telegramId, topic });
									// Unregister the topic
									SignClientManager.unregisterTopic(topic);
									await UserService.disconnectWallet(user.telegramId);
									this.userSessions.delete(user.telegramId);
									logger.info('✅ WALLET DISCONNECTED (session_delete)', { userId: user.telegramId, topic });
									client.off('session_delete', sessionDeleteHandler);
								}
							};
							// Session update handler to track expiry changes
						const sessionUpdateHandler = ({ topic, params }: any) => {
							if (topic === user.walletConnectTopic) {
								logger.info('Session updated', { 
									userId: user.telegramId, 
									topic,
									expiry: params?.expiry
								});
							}
						};
						
						// Session expire handler
						const sessionExpireHandler = async ({ topic }: { topic: string }) => {
							if (topic === user.walletConnectTopic) {
								logger.info('Session expired', { userId: user.telegramId, topic });
								// Unregister the topic
								SignClientManager.unregisterTopic(topic);
								await UserService.disconnectWallet(user.telegramId);
								this.userSessions.delete(user.telegramId);
								client.off('session_expire', sessionExpireHandler);
								client.off('session_update', sessionUpdateHandler);
							}
						};
						
						client.on('session_delete', sessionDeleteHandler);
						client.on('session_update', sessionUpdateHandler);
						client.on('session_expire', sessionExpireHandler);
							
							restoredCount++;
							logger.debug('Restored session', { 
								userId: user.telegramId, 
								address 
							});
						} else {
							// Address mismatch, clear invalid data
							logger.warn('Address mismatch in stored session', {
								userId: user.telegramId,
								stored: user.walletAddress,
								actual: address
							});
							await UserService.disconnectWallet(user.telegramId);
							invalidCount++;
						}
					} else {
						// Session not found, clear invalid data
						logger.debug('Session not found in SignClient', {
							userId: user.telegramId,
							topic: user.walletConnectTopic
						});
						await UserService.disconnectWallet(user.telegramId);
						invalidCount++;
					}
				} catch (error) {
					logger.error('Error restoring session for user', {
						userId: user.telegramId,
						error: error instanceof Error ? error.message : String(error)
					});
					invalidCount++;
				}
			}
			
			logger.info('🎯 SESSION RESTORATION COMPLETED', {
				total: usersWithWallets.length,
				restored: restoredCount,
				invalid: invalidCount,
				activeTopics: Array.from(SignClientManager.activeTopics)
			});
			
		} catch (error) {
			logger.error('Failed to restore sessions', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}

	async initializeConnection(userId: number): Promise<SignClient> {
		try {
			const existingSession = this.userSessions.get(userId);
			if (existingSession?.client) {
				return existingSession.client;
			}

			// Use SignClientManager to get the shared client instance
			const client = await SignClientManager.getClient();

			const savedConnection = await UserService.getWalletConnection(userId);

			if (savedConnection?.topic && savedConnection?.session && savedConnection?.address) {
				try {
					const activeSessions = client.session.getAll();
					const activeSession = activeSessions.find(s => s.topic === savedConnection.topic);

					if (activeSession && activeSession.namespaces?.eip155?.accounts?.length > 0) {
						// Check if session is still valid
						const sessionExpiry = activeSession.expiry;
						const currentTime = Math.floor(Date.now() / 1000);
						
						if (sessionExpiry && sessionExpiry < currentTime) {
							logger.info('Session expired, clearing stored data', { 
								userId, 
								expiry: sessionExpiry,
								currentTime
							});
							
							// Clear expired session
							await UserService.disconnectWallet(userId);
							this.userSessions.set(userId, { client });
							return client;
						}
						
						const address = activeSession.namespaces.eip155.accounts[0].split(':')[2];

						// Register this topic as active
						SignClientManager.registerTopic(savedConnection.topic);

						this.userSessions.set(userId, {
							client,
							address,
							provider: 'walletconnect'
						});

						logger.info('Restored active wallet session', { 
							userId, 
							address,
							expiry: activeSession.expiry,
							timeUntilExpiry: activeSession.expiry ? activeSession.expiry - Math.floor(Date.now() / 1000) : 'unknown'
						});
						
						// Start session ping to keep it alive
						this.startSessionPing(userId, savedConnection.topic, client);

						// Set up disconnect handler only once
						const sessionDeleteHandler = async ({ topic }: { topic: string }) => {
							if (topic === savedConnection.topic) {
								logger.info('🔔 SESSION_DELETE EVENT RECEIVED', { userId, topic });
								// Unregister the topic
								SignClientManager.unregisterTopic(topic);
								await UserService.disconnectWallet(userId);
								this.userSessions.delete(userId);
								logger.info('✅ WALLET DISCONNECTED (session_delete)', { userId, topic });
								// Remove the listener after handling
								client.off('session_delete', sessionDeleteHandler);
							}
						};
						// Session update handler to track expiry changes
						const sessionUpdateHandler = ({ topic, params }: any) => {
							if (topic === savedConnection.topic) {
								logger.info('Session updated', { 
									userId, 
									topic,
									expiry: params?.expiry
								});
							}
						};
						
						// Session expire handler
						const sessionExpireHandler = async ({ topic }: { topic: string }) => {
							if (topic === savedConnection.topic) {
								logger.info('Session expired', { userId, topic });
								// Unregister the topic
								SignClientManager.unregisterTopic(topic);
								await UserService.disconnectWallet(userId);
								this.userSessions.delete(userId);
								client.off('session_expire', sessionExpireHandler);
								client.off('session_update', sessionUpdateHandler);
							}
						};
						
						client.on('session_delete', sessionDeleteHandler);
						client.on('session_update', sessionUpdateHandler);
						client.on('session_expire', sessionExpireHandler);

						return client;
					} else {
						// Session not found in WalletConnect, clear invalid data
						logger.info('Session not found in WalletConnect, clearing stored data', { 
							userId, 
							savedTopic: savedConnection.topic,
							address: savedConnection.address 
						});
						
						// Clear the invalid session from database
						await UserService.disconnectWallet(userId);
						
						// Don't restore with invalid session data
						this.userSessions.set(userId, { client });
						
						return client;
					}
				} catch (error) {
					logger.info('Could not restore session, clearing stored data', { 
						userId, 
						error: error instanceof Error ? error.message : String(error) 
					});
					
					// Clear invalid session data
					await UserService.disconnectWallet(userId);
				}
			}

			this.userSessions.set(userId, { client });
			return client;

		} catch (error) {
			logger.error('Error initializing WalletConnect', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
			throw error;
		}
	}

	async validateSession(userId: number): Promise<boolean> {
		try {
			const session = this.userSessions.get(userId);
			if (!session?.client) return false;

			const savedConnection = await UserService.getWalletConnection(userId);
			if (!savedConnection?.topic) return false;

			const activeSessions = session.client.session.getAll();
			const activeSession = activeSessions.find(s => s.topic === savedConnection.topic);
			
			return !!activeSession;
		} catch (error) {
			logger.warn('Session validation failed', { userId, error });
			return false;
		}
	}

	/**
	 * Constructs the specific deep link URL for Binance Wallet.
	 * @param uri The WalletConnect URI (wc:...)
	 * @returns The full deep link URL.
	 */
	private constructBinanceDeepLink(uri: string): string {
		const encodedUri = encodeURIComponent(uri);
		const pageQuery = `wc=${encodedUri}`;
		const base64Query = Buffer.from(pageQuery).toString('base64');
		
		// Static values based on Binance Wallet mini app configuration
		const appId = process.env.BINANCE_WALLET_APP_ID || 'xoqXxUSMRccLCrZNRembzj';
		const startPagePath = process.env.BINANCE_WALLET_START_PAGE_PATH || 'L3BhZ2VzL2Rpc2NvdmVyL3dpZGVfYXNj'; // Base64 for '/pages/discover/wide_asc'

		const dpPayload = `/mp/app?appId=${appId}&startPagePath=${startPagePath}&startPageQuery=${base64Query}`;
		const base64Dp = Buffer.from(dpPayload).toString('base64');
		
		return `https://app.binance.com/mp/app?_dp=${base64Dp}`;
	}

	/**
	 * Handle Binance Wallet specific connection flow
	 */
	async handleBinanceConnect(ctx: Context) {
		const userId = ctx.from!.id;
		
		logger.info('🔌 HANDLE BINANCE CONNECT STARTED', {
			userId,
			timestamp: new Date().toISOString()
		});

		try {
			const client = await this.initializeConnection(userId);
			const { uri, approval } = await client.connect({
				optionalNamespaces: {
					eip155: {
						methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
						chains: ["eip155:56"], // BNB Chain Mainnet
						events: ["accountsChanged", "chainChanged"],
					},
				},
			});

			if (!uri) {
				throw new Error('Failed to generate connection URI for Binance Wallet');
			}
			
			const qrBuffer = await QRCode.toBuffer(uri);
			const deepLink = this.constructBinanceDeepLink(uri);

			const caption = await getTranslation(ctx, 'wallet.connectingToBinance');
			
			await ctx.replyWithPhoto({ source: qrBuffer }, {
				caption: caption,
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ text: '🔶 Open Binance Wallet', url: deepLink }]
					]
				}
			});

			// Handle wallet connection approval
			approval()
				.then(async (walletSession) => {
					logger.info('✅ BINANCE WALLET APPROVED CONNECTION', {
						userId,
						topic: walletSession.topic,
					});
					const address = walletSession.namespaces.eip155.accounts[0].split(':')[2];
					
					SignClientManager.registerTopic(walletSession.topic);
					
					await UserService.saveWalletConnection(
						userId,
						address,
						walletSession.topic,
						walletSession
					);

					this.userSessions.set(userId, {
						client,
						address,
						provider: 'walletconnect',
					});

					await ctx.reply(`✅ Binance Wallet connected: ${address}`);
					await mainMenu(ctx);
					
					this.startSessionPing(userId, walletSession.topic, client);

					const sessionDeleteHandler = async ({ topic }: { topic: string }) => {
						if (topic === walletSession.topic) {
							SignClientManager.unregisterTopic(topic);
							await UserService.disconnectWallet(userId);
							this.userSessions.delete(userId);
							this.stopSessionPing(userId);
							client.off('session_delete', sessionDeleteHandler);
							await ctx.reply('🔌 Binance Wallet disconnected');
							await mainMenuEdit(ctx);
						}
					};
					client.on('session_delete', sessionDeleteHandler);
				})
				.catch(async (error) => {
					logger.error('❌ BINANCE WALLET APPROVAL ERROR', { 
						userId, 
						error: error instanceof Error ? error.message : String(error), 
					});
					const timeoutMsg = await getTranslation(ctx, 'wallet.walletConnectionTimeout');
					await ctx.reply(timeoutMsg);
					this.userSessions.delete(userId);
				});

		} catch (error) {
			logger.error('❌ BINANCE WALLET CONNECTION ERROR', { 
				userId, 
				error: error instanceof Error ? error.message : String(error),
			});
			const errorMsg = await getTranslation(ctx, 'wallet.errorConnectingWallet');
			await ctx.reply(errorMsg);
			this.userSessions.delete(userId);
		}
	}

	/**
	 * Handle Trust Wallet specific connection flow
	 */
	async handleTrustWalletConnect(ctx: Context) {
		const userId = ctx.from!.id;
		
		logger.info('🔌 HANDLE TRUST WALLET CONNECT STARTED', {
			userId,
			timestamp: new Date().toISOString()
		});

		try {
			const client = await this.initializeConnection(userId);
			const { uri, approval } = await client.connect({
				optionalNamespaces: {
					eip155: {
						methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
						chains: ["eip155:56"], // BNB Chain Mainnet
						events: ["accountsChanged", "chainChanged"],
					},
				},
			});

			if (!uri) {
				throw new Error('Failed to generate connection URI for Trust Wallet');
			}
			
			const qrBuffer = await QRCode.toBuffer(uri);
			// Trust Wallet Deep Link format
			const deepLink = `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`;

			const caption = await getTranslation(ctx, 'wallet.connectingToTrustWallet');
			
			await ctx.replyWithPhoto({ source: qrBuffer }, {
				caption: caption,
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ text: '🔷 Open Trust Wallet', url: deepLink }]
					]
				}
			});

			// Handle wallet connection approval
			approval()
				.then(async (walletSession) => {
					logger.info('✅ TRUST WALLET APPROVED CONNECTION', {
						userId,
						topic: walletSession.topic,
					});
					const address = walletSession.namespaces.eip155.accounts[0].split(':')[2];
					
					SignClientManager.registerTopic(walletSession.topic);
					
					await UserService.saveWalletConnection(
						userId,
						address,
						walletSession.topic,
						walletSession
					);

					this.userSessions.set(userId, {
						client,
						address,
						provider: 'walletconnect',
					});

					await ctx.reply(`✅ Trust Wallet connected: ${address}`);
					await mainMenu(ctx);
					
					this.startSessionPing(userId, walletSession.topic, client);

					const sessionDeleteHandler = async ({ topic }: { topic: string }) => {
						if (topic === walletSession.topic) {
							SignClientManager.unregisterTopic(topic);
							await UserService.disconnectWallet(userId);
							this.userSessions.delete(userId);
							this.stopSessionPing(userId);
							client.off('session_delete', sessionDeleteHandler);
							await ctx.reply('🔌 Trust Wallet disconnected');
							await mainMenuEdit(ctx);
						}
					};
					client.on('session_delete', sessionDeleteHandler);
				})
				.catch(async (error) => {
					logger.error('❌ TRUST WALLET APPROVAL ERROR', { 
						userId, 
						error: error instanceof Error ? error.message : String(error), 
					});
					const timeoutMsg = await getTranslation(ctx, 'wallet.walletConnectionTimeout');
					await ctx.reply(timeoutMsg);
					this.userSessions.delete(userId);
				});

		} catch (error) {
			logger.error('❌ TRUST WALLET CONNECTION ERROR', { 
				userId, 
				error: error instanceof Error ? error.message : String(error),
			});
			const errorMsg = await getTranslation(ctx, 'wallet.errorConnectingWallet');
			await ctx.reply(errorMsg);
			this.userSessions.delete(userId);
		}
	}

	async handleConnect(ctx: Context) {
		const userId = ctx.from!.id;
		const session = this.userSessions.get(userId);
		
		logger.info('🔌 HANDLE CONNECT STARTED', {
			userId,
			hasExistingSession: !!session,
			hasAddress: !!session?.address,
			timestamp: new Date().toISOString()
		});

		// Check if already connected
		if (session?.address) {
			const keyboard = {
				inline_keyboard: [
					[{ text: '🔌 Disconnect Wallet', callback_data: 'disconnect_wallet' }],
					[{ text: '🔙 Back to Menu', callback_data: 'start_edit' }]
				]
			};

			const connectedTitle = await getTranslation(ctx, 'wallet.walletConnected');
			const connectedDesc = await getTranslation(ctx, 'wallet.walletConnectedDesc');
			
			await ctx.editMessageText(
				`${connectedTitle}\n\n` +
				`📱 Address: \`${session.address}\`\n\n` +
				`${connectedDesc}`,
				{
					reply_markup: keyboard,
					parse_mode: 'Markdown'
				}
			);
			return;
		}

		try {
			logger.info('🔗 INITIALIZING CONNECTION', { userId });
			const client = await this.initializeConnection(userId);
			logger.info('✅ CLIENT INITIALIZED', { userId, hasClient: !!client });

			logger.info('🌐 CALLING CLIENT.CONNECT()', { userId });
			const { uri, approval } = await client.connect({
				optionalNamespaces: {
					eip155: {
						methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
						chains: ["eip155:56"], // BNB Chain Mainnet
						events: ["accountsChanged", "chainChanged"],
					},
				},
			});

			if (!uri) {
				logger.error('❌ NO URI GENERATED', { userId });
				throw new Error('Failed to generate connection URI');
			}
			
			logger.info('🔗 URI GENERATED', { userId, uriLength: uri.length });

			// Generate and send QR code with button
			const qrBuffer = await QRCode.toBuffer(uri);
			const connectTitle = await getTranslation(ctx, 'wallet.connectYourWallet');
			const scanQR = await getTranslation(ctx, 'wallet.scanQRCode');
			const cantScan = await getTranslation(ctx, 'wallet.cantScan');
			const supported = await getTranslation(ctx, 'wallet.supportedWallets');
			const autoConfirm = await getTranslation(ctx, 'wallet.connectionConfirmed');
			const linkButton = await getTranslation(ctx, 'wallet.connectViaLink');
			
			await ctx.replyWithPhoto({ source: qrBuffer }, {
				caption: `${connectTitle}\n\n` +
					`${scanQR}\n` +
					`${cantScan}\n\n` +
					`${supported}\n\n` +
					`${autoConfirm}`,
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ text: linkButton, callback_data: `show_wc_link:${userId}` }]
					]
				}
			});
			
			// Store the URI temporarily for the callback
			const session = this.userSessions.get(userId);
			if (session) {
				session.pendingUri = uri;
			}

			// Handle wallet connection approval
			logger.info('⏳ WAITING FOR WALLET APPROVAL', { userId });
			approval()
				.then(async (walletSession) => {
					logger.info('✅ WALLET APPROVED CONNECTION', {
						userId,
						topic: walletSession.topic,
						expiry: walletSession.expiry,
						timestamp: new Date().toISOString()
					});
					const address = walletSession.namespaces.eip155.accounts[0].split(':')[2];
					
					// Log session details for debugging
					logger.info('New session established', {
						userId,
						address,
						topic: walletSession.topic,
						expiry: walletSession.expiry,
						acknowledged: walletSession.acknowledged,
						controller: walletSession.controller,
						timeUntilExpiry: walletSession.expiry ? walletSession.expiry - Math.floor(Date.now() / 1000) : 'unknown'
					});

					// Register this topic as active
					logger.info('📝 REGISTERING TOPIC', { userId, topic: walletSession.topic });
					SignClientManager.registerTopic(walletSession.topic);
					logger.info('✅ TOPIC REGISTERED', { userId, topic: walletSession.topic });
					
					// Save to database
					await UserService.saveWalletConnection(
						userId,
						address,
						walletSession.topic,
						walletSession
					);

					// Update in-memory session
					this.userSessions.set(userId, {
						client,
						address,
						provider: 'walletconnect',
						pendingUri: undefined // Clear the pending URI
					});

					await ctx.reply(`✅ Wallet connected: ${address}`);
					await mainMenu(ctx);
					
					// Start session ping to keep it alive
					this.startSessionPing(userId, walletSession.topic, client);

					// Set up disconnect handler for this specific session
					const sessionDeleteHandler = async ({ topic }: { topic: string }) => {
						if (topic === walletSession.topic) {
							logger.info('🔔 SESSION_DELETE EVENT IN APPROVAL HANDLER', { userId, topic });
							// Unregister the topic
							SignClientManager.unregisterTopic(topic);
							await UserService.disconnectWallet(userId);
							this.userSessions.delete(userId);
							this.stopSessionPing(userId);
							// Remove this handler to prevent memory leaks
							client.off('session_delete', sessionDeleteHandler);
							logger.info('✅ WALLET DISCONNECTED FROM APPROVAL HANDLER', { userId, topic });
							await ctx.reply('🔌 Wallet disconnected');
							await mainMenuEdit(ctx);
						}
					};
					client.on('session_delete', sessionDeleteHandler);
				})
				.catch(async (error) => {
					logger.error('❌ WALLET APPROVAL ERROR', { 
						userId, 
						error: error instanceof Error ? error.message : String(error), 
						stack: error instanceof Error ? error.stack : undefined,
						timestamp: new Date().toISOString()
					});
					const timeoutMsg = await getTranslation(ctx, 'wallet.walletConnectionTimeout');
					await ctx.reply(timeoutMsg);
					this.userSessions.delete(userId);
				});

		} catch (error) {
			logger.error('❌ WALLET CONNECTION ERROR', { 
				userId, 
				error: error instanceof Error ? error.message : String(error), 
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString()
			});
			const errorMsg = await getTranslation(ctx, 'wallet.errorConnectingWallet');
			await ctx.reply(errorMsg);
			this.userSessions.delete(userId);
		}
	}

	async handleDisconnect(ctx: Context) {
		const userId = ctx.from!.id;
		const session = this.userSessions.get(userId);
		
		logger.info('🔌 HANDLE DISCONNECT STARTED', {
			userId,
			hasSession: !!session,
			hasAddress: !!session?.address,
			timestamp: new Date().toISOString()
		});

		if (!session?.address) {
			await ctx.answerCbQuery('No wallet connected');
			return;
		}

		try {
			// Get saved connection info before disconnecting
			logger.info('📋 FETCHING SAVED CONNECTION', { userId });
			const savedConnection = await UserService.getWalletConnection(userId);
			logger.info('📋 SAVED CONNECTION DATA', {
				userId,
				hasTopic: !!savedConnection?.topic,
				topic: savedConnection?.topic,
				address: savedConnection?.address
			});
			
			// Disconnect from WalletConnect
			if (session.client && savedConnection?.topic) {
				// Unregister the topic first
				logger.info('🗑️ UNREGISTERING TOPIC', { userId, topic: savedConnection.topic });
				SignClientManager.unregisterTopic(savedConnection.topic);
				logger.info('✅ TOPIC UNREGISTERED', { userId, topic: savedConnection.topic });
				
				try {
					// Disconnect the specific session
					logger.info('🔌 CALLING CLIENT.DISCONNECT()', { userId, topic: savedConnection.topic });
					await session.client.disconnect({
						topic: savedConnection.topic,
						reason: { code: 6000, message: 'User disconnected' }
					});
					logger.info('✅ CLIENT.DISCONNECT() COMPLETED', { userId, topic: savedConnection.topic });
				} catch (error) {
					// Session might already be disconnected
					logger.debug('⚠️ DISCONNECT ERROR (may be already disconnected)', { 
						userId, 
						error: error instanceof Error ? error.message : String(error)
					});
				}
				
				// Clear session-specific storage data
				try {
					const { walletConnectStorage } = await import('./walletConnectStorage');
					await walletConnectStorage.clearSessionData(savedConnection.topic);
				} catch (error) {
					logger.error('Error clearing session storage', { userId, error });
				}
				
				// Force recreate the client if we're having issues
				// This ensures a clean slate for the next connection
				if (SignClientManager.hasClient()) {
					logger.info('🔄 FORCE RECREATING SIGNCLIENT AFTER DISCONNECT', { userId });
					await SignClientManager.forceRecreate();
					logger.info('✅ SIGNCLIENT RECREATED', { userId });
				}
			}

			// Remove from database
			logger.info('🗄️ REMOVING FROM DATABASE', { userId });
			await UserService.disconnectWallet(userId);
			logger.info('✅ DATABASE UPDATED', { userId });

			// Stop session ping
			this.stopSessionPing(userId);
			
			// Remove from memory
			logger.info('🧹 REMOVING FROM MEMORY', { userId });
			this.userSessions.delete(userId);
			logger.info('✅ MEMORY CLEARED', { userId });

			const disconnectedTitle = await getTranslation(ctx, 'wallet.walletDisconnected');
			const disconnectedDesc = await getTranslation(ctx, 'wallet.walletDisconnectedDesc');
			
			await ctx.editMessageText(
				`${disconnectedTitle}\n\n${disconnectedDesc}`,
				{ parse_mode: 'Markdown' }
			);

			// Show updated main menu
			setTimeout(() => {
				mainMenuEdit(ctx);
			}, 2000);

			logger.info('✅ DISCONNECT COMPLETED SUCCESSFULLY', { userId });
			
		} catch (error) {
			logger.error('❌ ERROR DISCONNECTING WALLET', { 
				userId, 
				error: error instanceof Error ? error.message : String(error), 
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString()
			});
			const errorMsg = await getTranslation(ctx, 'wallet.errorDisconnectingWallet');
			await ctx.reply(errorMsg);
		}
	}

	async handleWalletInfo(ctx: Context) {
		const userId = ctx.from!.id;
		const session = this.userSessions.get(userId);
		
		if (!session?.address) {
			const noWalletMsg = await getTranslation(ctx, 'wallet.noWalletConnected');
			await ctx.answerCbQuery(noWalletMsg);
			return;
		}

		// Import services
		const { UserService } = await import('../user');
		const { getMultipleBNBBalances, formatBNBBalance } = await import('./balance');
		
		// Get trading wallet info
		const tradingWalletAddress = await UserService.getTradingWalletAddress(userId);
		
		// Fetch balances for both wallets
		const addressesToFetch = [session.address];
		if (tradingWalletAddress) addressesToFetch.push(tradingWalletAddress);
		
		const balances = await getMultipleBNBBalances(addressesToFetch);
		const mainBalance = balances[session.address] || '0';
		const tradingBalance = tradingWalletAddress ? (balances[tradingWalletAddress] || '0') : '0';
		const totalBalance = (parseFloat(mainBalance) + parseFloat(tradingBalance)).toString();
		
		// Get translations
		const transferText = await getTranslation(ctx, 'wallet.transfer');
		const disconnectText = await getTranslation(ctx, 'wallet.disconnect');
		const backText = await getTranslation(ctx, 'wallet.backToMenu');
		
		const keyboard = {
			inline_keyboard: [
				[{ text: transferText + ' BNB', callback_data: 'transfer_menu' }],
				[{ text: disconnectText, callback_data: 'disconnect_wallet' }],
				[{ text: backText, callback_data: 'start_edit' }]
			]
		};
		
		// Build message with translations
		const walletInfoTitle = await getTranslation(ctx, 'wallet.walletInfo');
		const mainWalletLabel = await getTranslation(ctx, 'wallet.mainWallet');
		const tradingWalletLabel = await getTranslation(ctx, 'wallet.tradingWalletLabel');
		const balanceLabel = await getTranslation(ctx, 'wallet.balance');
		const totalBalanceLabel = await getTranslation(ctx, 'wallet.totalBalance');
		const tradingWalletInfo = await getTranslation(ctx, 'wallet.tradingWalletInfo');
		const noTradingWallet = await getTranslation(ctx, 'wallet.noTradingWallet');
		
		await ctx.editMessageText(
			`${walletInfoTitle}\n\n` +
			`${mainWalletLabel}\n\`${session.address}\`\n${balanceLabel} ${formatBNBBalance(mainBalance)} BNB\n\n` +
			`${tradingWalletLabel}\n\`${tradingWalletAddress || noTradingWallet}\`\n${balanceLabel} ${formatBNBBalance(tradingBalance)} BNB\n\n` +
			`${totalBalanceLabel} ${formatBNBBalance(totalBalance)} BNB\n\n` +
			`${tradingWalletInfo}`,
			{ 
				reply_markup: keyboard,
				parse_mode: 'Markdown'
			}
		);
	}

	async handleShowWcLink(ctx: Context) {
		const userId = ctx.from!.id;
		const session = this.userSessions.get(userId);
		
		if (!session?.pendingUri) {
			const expiredMsg = await getTranslation(ctx, 'wallet.connectionLinkExpired');
			await ctx.answerCbQuery(expiredMsg);
			return;
		}
		
		await ctx.answerCbQuery();
		
		// Create deep links for popular wallets
		const encodedUri = encodeURIComponent(session.pendingUri);
		const walletLinks = [
			{ name: '🦊 MetaMask', url: `https://metamask.app.link/wc?uri=${encodedUri}` }
		];
		
		const copyLinkText = await getTranslation(ctx, 'wallet.copyLinkInstead');
		const connectTitle = await getTranslation(ctx, 'wallet.connectYourWallet');
		const chooseWallet = await getTranslation(ctx, 'wallet.chooseWalletApp');
		const walletNotListed = await getTranslation(ctx, 'wallet.walletNotListed');
		const openWalletApp = await getTranslation(ctx, 'wallet.openWalletApp');
		const findWalletConnect = await getTranslation(ctx, 'wallet.findWalletConnect');
		const connectViaLinkOption = await getTranslation(ctx, 'wallet.connectViaLinkOption');
		const connectionExpires = await getTranslation(ctx, 'wallet.connectionExpires');
		
		const keyboard = {
			inline_keyboard: [
				...walletLinks.map(wallet => [{ text: wallet.name, url: wallet.url }]),
				[{ text: copyLinkText, callback_data: `copy_wc_link:${userId}` }]
			]
		};
		
		await ctx.reply(
			`${connectTitle}\n\n` +
			`${chooseWallet}\n\n` +
			`${walletNotListed}\n` +
			`${openWalletApp}\n` +
			`${findWalletConnect}\n` +
			`${connectViaLinkOption}\n\n` +
			`${connectionExpires}`,
			{ 
				parse_mode: 'Markdown',
				reply_markup: keyboard
			}
		);
	}

	async handleCopyWcLink(ctx: Context) {
		const userId = ctx.from!.id;
		const session = this.userSessions.get(userId);
		
		if (!session?.pendingUri) {
			const expiredMsg = await getTranslation(ctx, 'wallet.connectionLinkExpired');
			await ctx.answerCbQuery(expiredMsg);
			return;
		}
		
		await ctx.answerCbQuery();
		
		const linkTitle = await getTranslation(ctx, 'wallet.walletConnectLink');
		const copyAndPaste = await getTranslation(ctx, 'wallet.copyAndPaste');
		const howToUse = await getTranslation(ctx, 'wallet.howToUse');
		const copyLink = await getTranslation(ctx, 'wallet.copyLink');
		const openWallet = await getTranslation(ctx, 'wallet.openWallet');
		const lookFor = await getTranslation(ctx, 'wallet.lookForWalletConnect');
		const chooseConnect = await getTranslation(ctx, 'wallet.chooseConnectVia');
		const pasteLink = await getTranslation(ctx, 'wallet.pasteThisLink');
		const popularWallets = await getTranslation(ctx, 'wallet.popularWallets');
		
		await ctx.reply(
			`${linkTitle}\n\n` +
			`${copyAndPaste}\n\n` +
			`\`${session.pendingUri}\`\n\n` +
			`${howToUse}\n` +
			`${copyLink}\n` +
			`${openWallet}\n` +
			`${lookFor}\n` +
			`${chooseConnect}\n` +
			`${pasteLink}\n\n` +
			`${popularWallets}`,
			{ parse_mode: 'Markdown' }
		);
	}

	async handleReconnect(ctx: Context, userId: number) {
		try {
			// Clean up any existing session data
			const existingSession = this.userSessions.get(userId);
			if (existingSession?.client) {
				try {
					const sessions = existingSession.client.session.getAll();
					for (const wcSession of sessions) {
						try {
							await existingSession.client.disconnect({
								topic: wcSession.topic,
								reason: { code: 6000, message: 'Reconnecting' }
							});
						} catch (error) {
							logger.debug('Error disconnecting old session during reconnect', { error });
						}
					}
				} catch (error) {
					logger.debug('Error cleaning up old sessions', { error });
				}
			}
			
			// Clear from database
			await UserService.disconnectWallet(userId);
			
			// Remove from memory
			this.userSessions.delete(userId);
			
			// Initialize new connection with the same SignClient instance
			const client = await this.initializeConnection(userId);

			const { uri, approval } = await client.connect({
				optionalNamespaces: {
					eip155: {
						methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
						chains: ["eip155:56"], // BNB Chain Mainnet
						events: ["accountsChanged", "chainChanged"],
					},
				},
			});

			if (!uri) {
				logger.error('❌ NO URI GENERATED', { userId });
				throw new Error('Failed to generate connection URI');
			}
			
			logger.info('🔗 URI GENERATED', { userId, uriLength: uri.length });

			// Generate and send QR code with button
			const qrBuffer = await QRCode.toBuffer(uri);
			const sessionExpired = await getTranslation(ctx, 'wallet.sessionExpired');
			const scanQR = await getTranslation(ctx, 'wallet.scanQRCode');
			const cantScan = await getTranslation(ctx, 'wallet.cantScan');
			const reconnectDesc = await getTranslation(ctx, 'wallet.reconnectDesc');
			const autoConfirm = await getTranslation(ctx, 'wallet.connectionConfirmed');
			const linkButton = await getTranslation(ctx, 'wallet.connectViaLink');
			
			await ctx.replyWithPhoto({ source: qrBuffer }, {
				caption: `${sessionExpired}\n\n` +
					`${scanQR}\n` +
					`${cantScan}\n\n` +
					`${reconnectDesc}\n\n` +
					`${autoConfirm}`,
				parse_mode: 'Markdown',
				reply_markup: {
					inline_keyboard: [
						[{ text: linkButton, callback_data: `show_wc_link:${userId}` }]
					]
				}
			});
			
			// Store the URI temporarily for the callback
			const session = this.userSessions.get(userId);
			if (session) {
				session.pendingUri = uri;
			}

			// Handle wallet connection approval
			logger.info('⏳ WAITING FOR WALLET APPROVAL', { userId });
			approval()
				.then(async (walletSession) => {
					logger.info('✅ WALLET APPROVED CONNECTION', {
						userId,
						topic: walletSession.topic,
						expiry: walletSession.expiry,
						timestamp: new Date().toISOString()
					});
					const address = walletSession.namespaces.eip155.accounts[0].split(':')[2];
					
					// Log session details for debugging
					logger.info('New session established', {
						userId,
						address,
						topic: walletSession.topic,
						expiry: walletSession.expiry,
						acknowledged: walletSession.acknowledged,
						controller: walletSession.controller,
						timeUntilExpiry: walletSession.expiry ? walletSession.expiry - Math.floor(Date.now() / 1000) : 'unknown'
					});

					// Save to database
					await UserService.saveWalletConnection(
						userId,
						address,
						walletSession.topic,
						walletSession
					);

					// Update in-memory session
					this.userSessions.set(userId, {
						client,
						address,
						provider: 'walletconnect',
						pendingUri: undefined // Clear the pending URI
					});

					const successTitle = await getTranslation(ctx, 'wallet.walletReconnectedSuccess');
					const addressLabel = await getTranslation(ctx, 'wallet.address');
					const retryDesc = await getTranslation(ctx, 'wallet.walletReconnectedDesc');
					
					await ctx.reply(
						`${successTitle}\n\n` +
						`${addressLabel} \`${address}\`\n\n` +
						`${retryDesc}`,
						{ parse_mode: 'Markdown' }
					);
				})
				.catch(async (error) => {
					logger.error('Connection error during reconnect', { userId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
					const failedMsg = await getTranslation(ctx, 'wallet.connectionFailed');
					await ctx.reply(failedMsg);
				});

		} catch (error) {
			logger.error('Error in handleReconnect', { userId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
			const failedMsg = await getTranslation(ctx, 'wallet.failedToGenerate');
			await ctx.reply(failedMsg);
		}
	}
	
	private async handleSessionDisconnect(userId: number) {
		try {
			// Get saved connection info before disconnecting
			const savedConnection = await UserService.getWalletConnection(userId);
			
			// Clear session-specific storage data if we have a topic
			if (savedConnection?.topic) {
				// Unregister the topic
				SignClientManager.unregisterTopic(savedConnection.topic);
				
				try {
					const { walletConnectStorage } = await import('./walletConnectStorage');
					await walletConnectStorage.clearSessionData(savedConnection.topic);
				} catch (error) {
					logger.error('Error clearing session storage', { userId, error });
				}
			}
			
			await UserService.disconnectWallet(userId);
			this.stopSessionPing(userId);
			this.userSessions.delete(userId);
			logger.info('User disconnected', { userId });
		} catch (error) {
			logger.error('Error during disconnect', { userId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	
	private startSessionPing(userId: number, topic: string, client: SignClient) {
		// Stop any existing ping for this user
		this.stopSessionPing(userId);
		
		// Ping every 5 minutes to keep session alive
		const interval = setInterval(async () => {
			try {
				const sessions = client.session.getAll();
				const session = sessions.find(s => s.topic === topic);
				
				if (!session) {
					logger.info('Session no longer exists, stopping ping', { userId, topic });
					this.stopSessionPing(userId);
					return;
				}
				
				// Check if session is about to expire (within 1 hour)
				const currentTime = Math.floor(Date.now() / 1000);
				const timeUntilExpiry = session.expiry ? session.expiry - currentTime : 0;
				
				if (timeUntilExpiry < 3600 && timeUntilExpiry > 0) {
					logger.warn('Session expiring soon', { 
						userId, 
						topic,
						timeUntilExpiry 
					});
					
					// Try to extend session
					try {
						await client.extend({ topic });
						logger.info('Session extended successfully', { userId, topic });
					} catch (extendError) {
						logger.error('Failed to extend session', { 
							userId, 
							topic,
							error: extendError instanceof Error ? extendError.message : String(extendError)
						});
					}
				}
				
				// Send a ping to keep connection alive
				await client.ping({ topic });
				logger.debug('Session ping sent', { userId, topic, timeUntilExpiry });
				
			} catch (error) {
				logger.error('Session ping failed', { 
					userId, 
					topic,
					error: error instanceof Error ? error.message : String(error)
				});
				
				// If ping fails, session might be dead
				if (error instanceof Error && error.message.includes('No matching')) {
					this.stopSessionPing(userId);
					this.handleSessionDisconnect(userId);
				}
			}
		}, 5 * 60 * 1000); // 5 minutes
		
		this.sessionPingIntervals.set(userId, interval);
		logger.info('Started session ping', { userId, topic });
	}
	
	private stopSessionPing(userId: number) {
		const interval = this.sessionPingIntervals.get(userId);
		if (interval) {
			clearInterval(interval);
			this.sessionPingIntervals.delete(userId);
			logger.info('Stopped session ping', { userId });
		}
	}

	async validateAllSessions() {
		logger.debug('Validating all active sessions...');
		const invalidSessions: number[] = [];
		
		for (const [userId, session] of this.userSessions.entries()) {
			if (!session.client || !session.address) continue;
			
			try {
				const savedConnection = await UserService.getWalletConnection(userId);
				if (!savedConnection?.topic) {
					invalidSessions.push(userId);
					continue;
				}
				
				const activeSessions = session.client.session.getAll();
				const sessionExists = activeSessions.some(s => s.topic === savedConnection.topic);
				
				if (!sessionExists) {
					logger.debug('Found invalid session', { userId, topic: savedConnection.topic });
					invalidSessions.push(userId);
				}
			} catch (error) {
				logger.debug('Error validating session', { userId, error });
				invalidSessions.push(userId);
			}
		}
		
		// Clean up invalid sessions
		for (const userId of invalidSessions) {
			try {
				await UserService.disconnectWallet(userId);
				this.userSessions.delete(userId);
				this.stopSessionPing(userId);
				logger.info('Cleaned up invalid session', { userId });
			} catch (error) {
				logger.error('Error cleaning up session', { userId, error });
			}
		}
		
		if (invalidSessions.length > 0) {
			logger.info(`Cleaned up ${invalidSessions.length} invalid sessions`);
		}
	}
}