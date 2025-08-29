import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format with safe stringify for circular references
const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  // Helper function to safely stringify objects with circular references and BigInt
  const safeStringify = (obj: any, indent = 2) => {
    let cache: any[] | null = [];
    const retVal = JSON.stringify(
      obj,
      (key, value) => {
        // Handle BigInt
        if (typeof value === 'bigint') {
          return value.toString();
        }
        // Handle circular references
        if (typeof value === 'object' && value !== null) {
          return cache!.includes(value)
            ? undefined // Duplicate reference found, discard key
            : cache!.push(value) && value; // Store value in cache and return it
        }
        return value;
      },
      indent
    );
    cache = null; // Enable garbage collection
    return retVal;
  };
  
  // Add metadata if present
  if (Object.keys(metadata).length > 0) {
    // Check for an 'error' object in metadata and simplify it
    if (metadata.error && typeof metadata.error === 'object') {
        const originalError = metadata.error as any; // Type as any to access properties safely
        metadata.error = {
            message: originalError.message,
            name: originalError.name,
            code: originalError.code,
            // Only include stack if it exists and we're not already logging it
            ...(originalError.stack && !stack && { stack: originalError.stack.split('\n').slice(0, 5).join('\n') }),
            // Include other simple properties if they exist
            ...(originalError.config && { url: originalError.config.url, method: originalError.config.method }),
            ...(originalError.response && { status: originalError.response.status, data: originalError.response.data }),
        };
    }
    msg += ` ${safeStringify(metadata)}`; // Use safe stringify
  }
  
  // Add stack trace for errors
  if (stack) {
    msg += `\n${stack}`;
  }
  
  return msg;
});

// Console format with colors
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  logFormat
);

// File format without colors
const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  logFormat
);

// Create logs directory
const logsDir = path.join(process.cwd(), 'logs');

// Daily rotate file transport
const fileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: fileFormat,
});

// Error file transport
const errorFileTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  level: 'error',
  format: fileFormat,
});

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fileFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transports
    fileRotateTransport,
    errorFileTransport,
  ],
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'exceptions.log'),
      format: fileFormat,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'rejections.log'),
      format: fileFormat,
    }),
  ],
});

// Create child loggers for different modules
export const createLogger = (module: string) => {
  return logger.child({ module });
};

// Export main logger
export default logger;

// Convenience methods
export const logInfo = (message: string, meta?: any) => logger.info(message, meta);
export const logError = (message: string, error?: any) => {
  if (error instanceof Error) {
    logger.error(message, { error: error.message, stack: error.stack });
  } else {
    logger.error(message, error);
  }
};
export const logWarn = (message: string, meta?: any) => logger.warn(message, meta);
export const logDebug = (message: string, meta?: any) => logger.debug(message, meta);