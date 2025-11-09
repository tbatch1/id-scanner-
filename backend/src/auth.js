const logger = require('./logger');
const config = require('./config');

/**
 * API Key Authentication Middleware
 *
 * Protects API endpoints from unauthorized access
 * Required for TABC compliance to prevent tampering with verification records
 *
 * Usage:
 * - Frontend must include X-API-Key header in all requests
 * - API key stored in environment variable API_SECRET_KEY
 * - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

function authenticateRequest(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.API_SECRET_KEY;

  // In development without API key configured, allow requests but warn
  if (config.env === 'development' && !expectedKey) {
    logger.warn({
      event: 'auth_bypassed_dev',
      ip: req.ip,
      path: req.path
    }, 'Authentication bypassed in development mode - NO API_SECRET_KEY set');
    return next();
  }

  // Check if API key is provided
  if (!apiKey) {
    logger.logSecurity('missing_api_key', {
      ip: req.ip,
      path: req.path,
      origin: req.get('origin'),
      userAgent: req.get('user-agent')
    });

    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing API key. Include X-API-Key header in your request.'
    });
  }

  // Validate API key
  if (apiKey !== expectedKey) {
    logger.logSecurity('invalid_api_key', {
      ip: req.ip,
      path: req.path,
      providedKey: apiKey.substring(0, 8) + '...', // Log prefix only for security
      origin: req.get('origin')
    });

    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid API key.'
    });
  }

  // Success - log and continue
  logger.debug({
    event: 'auth_success',
    ip: req.ip,
    path: req.path
  }, 'Request authenticated successfully');

  next();
}

/**
 * Optional authentication - allows request to proceed but logs if no auth
 * Useful for transitioning to authenticated system
 */
function optionalAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.API_SECRET_KEY;

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn({
      event: 'unauthenticated_request',
      ip: req.ip,
      path: req.path
    }, 'Request proceeding without authentication');
  }

  next();
}

module.exports = {
  authenticateRequest,
  optionalAuth
};
