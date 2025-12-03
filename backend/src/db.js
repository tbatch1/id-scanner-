const { Pool } = require('pg');
const logger = require('./logger');

const connectionString = process.env.DATABASE_URL;

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
  max: 40, // Maximum number of connections in pool (upgraded for 18 locations)
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Timeout if can't connect in 2s
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
async function query(text, params) {
  const start = Date.now();

  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    logger.logPerformance('db_query', duration, true);

    if (duration > 1000) {
      logger.warn({
        event: 'slow_query',
        duration_ms: duration,
        query: text.substring(0, 100) // Log first 100 chars
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
