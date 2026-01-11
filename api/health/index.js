// Simple health check endpoint (optionally performs a DB round-trip when requested)
module.exports = async (req, res) => {
  const env = (process.env.NODE_ENV || 'production').trim();
  const enableWritesRaw = String(process.env.LIGHTSPEED_ENABLE_WRITE || '').trim().toLowerCase();

  const dbQueryParam = String(req?.query?.db || req?.query?.deep || '').trim().toLowerCase();
  const shouldCheckDb = ['1', 'true', 'yes', 'on'].includes(dbQueryParam);

  let dbOk = null;
  let dbError = null;

  if (shouldCheckDb) {
    try {
      // eslint-disable-next-line global-require
      const db = require('../../backend/src/db');
      dbOk = await db.testConnection();
      if (!dbOk) dbError = 'DB_HEALTH_CHECK_FAILED';
    } catch (err) {
      dbOk = false;
      dbError = err?.message || String(err);
    }
  }

  if (shouldCheckDb && dbOk === false) {
    return res.status(503).json({
      status: 'error',
      environment: env,
      timestamp: new Date().toISOString(),
      database: 'error',
      database_checked: true,
      database_error: dbError,
      lightspeed: {
        mode: 'live',
        writesEnabled: enableWritesRaw === 'true'
      }
    });
  }

  return res.status(200).json({
    status: 'ok',
    environment: env,
    timestamp: new Date().toISOString(),
    database: shouldCheckDb ? (dbOk ? 'ok' : 'error') : 'unknown',
    database_checked: shouldCheckDb,
    database_error: dbError,
    lightspeed: {
      mode: 'live',
      writesEnabled: enableWritesRaw === 'true'
    }
  });
};
