const pino = require('pino');
const config = require('./config');

/**
 * Enhanced enterprise-grade logger with structured logging
 *
 * Log Levels:
 * - trace (10): Very detailed debug information
 * - debug (20): Debug information
 * - info (30): General informational messages
 * - warn (40): Warning messages
 * - error (50): Error messages
 * - fatal (60): Fatal errors that crash the application
 */

const STANDARD_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
});

const baseLoggerOptions = {
  name: 'id-scanner',
  level: (process.env.LOG_LEVEL || '').trim().toLowerCase() || (config.env === 'production' ? 'info' : 'debug'),

  // Pretty print in development, JSON in production
  transport: config.env === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{levelLabel} - {msg}'
        }
      }
    : undefined,

  // Base context included in every log
  base: {
    env: config.env,
    service: 'id-scanner-api'
  },

  // Redact sensitive information
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'apiKey',
      'token',
      'dob',
      '*.dob',
      'verificationData.dob'
    ],
    censor: '[REDACTED]'
  },

  // Serialize errors properly
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res
  }
};

function buildLogger(overrides = {}) {
  return pino({
    ...baseLoggerOptions,
    ...overrides
  });
}

function createConsoleFallback(error) {
  const shim = {};
  const consoleMap = {
    fatal: 'error',
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug',
    trace: 'trace'
  };

  if (error) {
    console.error('Structured logger failed to initialize, using console fallback.', error);
  }

  Object.entries(consoleMap).forEach(([level, consoleMethod]) => {
    const target = typeof console[consoleMethod] === 'function' ? console[consoleMethod] : console.log;
    shim[level] = target.bind(console, `[${level.toUpperCase()}]`);
  });

  shim.child = () => shim;
  shim.flush = () => {};
  return shim;
}

let logger;

try {
  logger = buildLogger();
} catch (error) {
  if (error && typeof error.message === 'string' && error.message.includes('default level')) {
    try {
      logger = buildLogger({
        customLevels: STANDARD_LEVELS,
        useOnlyCustomLevels: false
      });
    } catch (secondaryError) {
      logger = createConsoleFallback(secondaryError);
    }
  } else {
    logger = createConsoleFallback(error);
  }
}

if (!logger) {
  logger = createConsoleFallback();
}

/**
 * Log a verification attempt
 */
logger.logVerification = function(saleId, clerkId, approved, age, extra = {}) {
  this.info({
    event: 'verification_attempt',
    saleId,
    clerkId,
    approved,
    age: age || 'unknown',
    documentType: extra.documentType || null,
    issuingCountry: extra.issuingCountry || null,
    timestamp: new Date().toISOString()
  }, `Verification ${approved ? 'APPROVED' : 'REJECTED'} for sale ${saleId}`);
};

/**
 * Log a sale completion
 */
logger.logSaleComplete = function(saleId, paymentType, amount) {
  this.info({
    event: 'sale_completed',
    saleId,
    paymentType,
    amount,
    timestamp: new Date().toISOString()
  }, `Sale ${saleId} completed with ${paymentType} payment ($${amount})`);
};

/**
 * Log an API error with context
 */
logger.logAPIError = function(operation, error, context = {}) {
  this.error({
    event: 'api_error',
    operation,
    error: {
      message: error.message,
      code: error.code,
      stack: error.stack
    },
    ...context,
    timestamp: new Date().toISOString()
  }, `API Error in ${operation}: ${error.message}`);
};

/**
 * Log circuit breaker state changes
 */
logger.logCircuitBreaker = function(state, failures = 0) {
  const level = state === 'OPEN' ? 'error' : 'info';
  this[level]({
    event: 'circuit_breaker',
    state,
    failures,
    timestamp: new Date().toISOString()
  }, `Circuit breaker: ${state} (failures: ${failures})`);
};

/**
 * Log performance metrics
 */
logger.logPerformance = function(operation, duration, success = true) {
  this.info({
    event: 'performance',
    operation,
    duration_ms: duration,
    success,
    timestamp: new Date().toISOString()
  }, `${operation} completed in ${duration}ms`);
};

/**
 * Log security events
 */
logger.logSecurity = function(event, details = {}) {
  this.warn({
    event: 'security_event',
    eventType: event,
    ...details,
    timestamp: new Date().toISOString()
  }, `Security event: ${event}`);
};

module.exports = logger;
