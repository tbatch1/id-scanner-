const logger = require('./logger');
const oauth = require('./lightspeedOAuth');

const USE_MOCK = process.env.LIGHTSPEED_USE_MOCK === 'true';

if (USE_MOCK) {
  logger.warn({ event: 'using_mock_client' }, 'WARNING: Using MOCK Lightspeed client');
  module.exports = { ...require('./mockLightspeedClient'), ...oauth };
} else {
  logger.info({ event: 'using_real_client' }, 'Using REAL Lightspeed client with Personal Token');
  module.exports = { ...require('./lightspeedRealClient'), ...oauth };
}
