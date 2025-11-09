// Simple health check endpoint
module.exports = async (req, res) => {
  return res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString(),
    database: 'ok',
    lightspeed: {
      mode: 'live',
      writesEnabled: process.env.LIGHTSPEED_ENABLE_WRITE === 'true'
    }
  });
};
