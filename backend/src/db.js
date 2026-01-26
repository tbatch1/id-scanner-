const { Pool } = require('pg');
const logger = require('./logger');

function sanitizeConnectionString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\r\\n/g, '')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/[\r\n]/g, '')
    .trim()
    .replace(/^"|"$/g, '');
}

const connectionString = sanitizeConnectionString(process.env.DATABASE_URL);

function parseIntOr(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

if (!connectionString) {
  logger.warn(
    { event: 'db_disabled' },
    'DATABASE_URL is not configured. Compliance storage features are disabled.'
  );

  module.exports = {
    async query() {
      throw new Error('DATABASE_URL is not configured');
    },
    pool: null,
    async testConnection() {
      return false;
    },
    async getStats() {
      return null;
    },
    async shutdown() {
      logger.info({ event: 'db_shutdown_noop' }, 'Database shutdown skipped (no pool).');
    }
  };
  return;
}

/**
 * PostgreSQL Database Connection Pool
 *
 * For TABC Compliance: Permanent storage of all age verifications
 *
 * Vercel automatically provides DATABASE_URL when you create a Postgres database
 * in the Vercel dashboard: Storage > Create Database > Postgres
 */

// Create connection pool
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false // Required for Vercel Postgres
  } : false,
  // IMPORTANT: Vercel is serverless. Keep the per-instance pool small and rely on Neon Pooler.
  // You can override with env vars if needed.
  max: parseIntOr(process.env.DB_POOL_MAX, process.env.NODE_ENV === 'production' ? 10 : 20),
  idleTimeoutMillis: parseIntOr(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
  connectionTimeoutMillis: parseIntOr(process.env.DB_CONNECTION_TIMEOUT_MS, 5_000),
});

// Log successful connections
pool.on('connect', (client) => {
  logger.debug({ event: 'db_connection_acquired' }, 'Database connection acquired from pool');
});

// Log errors
pool.on('error', (err, client) => {
  logger.error({ event: 'db_pool_error', error: err.message }, 'Unexpected database pool error');
});

/**
 * Query helper function
 *
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise} Query result
 */
async function query(text, params, timeoutMs = 5000) {
  const start = Date.now();

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('DATABASE_QUERY_TIMEOUT')), timeoutMs);
  });

  const isRetryableDbError = (error) => {
    const msg = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '');
    return (
      msg.includes('connection terminated') ||
      msg.includes('connection terminated unexpectedly') ||
      msg.includes('connection reset') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      code === '57P01' || // admin_shutdown
      code === '57P02' || // crash_shutdown
      code === '57P03' || // cannot_connect_now
      code === '53300' // too_many_connections
    );
  };

  const execute = async () => Promise.race([pool.query(text, params), timeoutPromise]);

  try {
    let result;
    try {
      result = await execute();
    } catch (error) {
      // One retry for transient connection issues (never loops indefinitely).
      if (isRetryableDbError(error)) {
        await new Promise((r) => setTimeout(r, 120));
        result = await execute();
      } else {
        throw error;
      }
    }
    const duration = Date.now() - start;

    logger.logPerformance('db_query', duration, true);

    if (duration > 1000) {
      logger.warn({
        event: 'slow_query',
        duration_ms: duration,
        query: text.substring(0, 100)
      }, `Slow database query: ${duration}ms`);
    }

    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.logPerformance('db_query', duration, false);
    logger.logAPIError('db_query', error, {
      query: text.substring(0, 100),
      params: params ? params.length : 0
    });
    throw error;
  }
}

/**
 * Test database connection
 * Used by health check endpoint
 */
async function testConnection() {
  try {
    const result = await query('SELECT NOW() as now, current_database() as database');
    logger.info({
      event: 'db_health_check_success',
      database: result.rows[0].database
    }, 'Database health check passed');
    return true;
  } catch (error) {
    logger.error({
      event: 'db_health_check_failed',
      error: error.message
    }, 'Database health check failed');
    return false;
  }
}

/**
 * Get database statistics
 * Useful for monitoring
 */
async function getStats() {
  try {
    const verificationsCount = await query('SELECT COUNT(*) as count FROM verifications');
    const completionsCount = await query('SELECT COUNT(*) as count FROM sales_completions');
    const todayVerifications = await query(
      "SELECT COUNT(*) as count FROM verifications WHERE created_at > CURRENT_DATE"
    );

    return {
      total_verifications: parseInt(verificationsCount.rows[0].count),
      total_completions: parseInt(completionsCount.rows[0].count),
      today_verifications: parseInt(todayVerifications.rows[0].count),
      pool_total: pool.totalCount,
      pool_idle: pool.idleCount,
      pool_waiting: pool.waitingCount
    };
  } catch (error) {
    logger.error({ event: 'db_stats_error', error: error.message }, 'Failed to get database stats');
    return null;
  }
}

/**
 * Graceful shutdown
 * Close all connections in pool
 */
async function shutdown() {
  logger.info({ event: 'db_shutdown' }, 'Closing database connection pool');
  await pool.end();
}

// Handle process termination
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
  query,
  pool,
  testConnection,
  getStats,
  shutdown
};
