import { ethers } from 'ethers';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createLogger } from '@/utils/logger';

dotenv.config();

const logger = createLogger('wallet.trading');

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

// Ensure encryption key is exactly 32 bytes for AES-256
function getEncryptionKey(): Buffer {
  if (process.env.WALLET_ENCRYPTION_KEY) {
    // If provided, ensure it's 32 bytes
    const keyBuffer = Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex');
    if (keyBuffer.length === 32) {
      return keyBuffer;
    } else {
      logger.error('WALLET_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
      logger.info('Generating a new key. Use this in your .env file:');
      const newKey = crypto.randomBytes(32).toString('hex');
      logger.info(`WALLET_ENCRYPTION_KEY=${newKey}`);
      return Buffer.from(newKey, 'hex');
    }
  } else {
    logger.warn('Using random encryption key. Set WALLET_ENCRYPTION_KEY in .env for production');
    const newKey = crypto.randomBytes(32).toString('hex');
    logger.info('Generated key for development. Add to .env:');
    logger.info(`WALLET_ENCRYPTION_KEY=${newKey}`);
    return Buffer.from(newKey, 'hex');
  }
}

const ENCRYPTION_KEY = getEncryptionKey();

/**
 * Generates a new Ethereum wallet keypair
 */
export function generateWallet(): { address: string; privateKey: string; mnemonic: string } {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic!.phrase
  };
}

/**
 * Encrypts a private key for storage
 */
export function encryptPrivateKey(privateKey: string): { encrypted: string; iv: string } {
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    encrypted,
    iv: iv.toString('hex')
  };
}

/**
 * Decrypts a private key for one-time viewing
 */
export function decryptPrivateKey(encryptedData: string, ivHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Creates a wallet instance from encrypted private key for trading
 */
export function getTradingWallet(encryptedPrivateKey: string, iv: string, provider: ethers.Provider): ethers.Wallet {
  const privateKey = decryptPrivateKey(encryptedPrivateKey, iv);
  return new ethers.Wallet(privateKey, provider);
}