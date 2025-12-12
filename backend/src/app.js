const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./logger');
const { authenticateRequest, optionalAuth, adminAuth } = require('./auth');
const apiRoutes = require('./routes');
const adminRoutes = require('./adminRoutes');
const scanSessionRoutes = require('./scanSessionRoutes');
const terminalRoutes = require('./terminalRoutes');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

const corsWhitelist = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((entry) => entry.trim()).filter(Boolean)
  : ['http://localhost:4000', 'http://localhost:3000'];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.env === 'development') {
        return callback(null, true);
      }

      const isAllowed = corsWhitelist.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
          return regex.test(origin);
        }
        return pattern === origin;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        logger.logSecurity('cors_blocked', { origin, whitelist: corsWhitelist });
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    logger.logSecurity('rate_limit_exceeded', {
      ip: req.ip,
      path: req.path,
      type: 'general'
    });
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP, please try again later.'
    });
  }
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // Increased from 30 to 200 for 18 locations
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    logger.logSecurity('rate_limit_exceeded', {
      ip: req.ip,
      path: req.path,
      type: 'strict'
    });
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many verification attempts from this IP, please try again later.'
    });
  }
});

app.use(
  pinoHttp({
    logger,
    autoLogging: true,
    customLogLevel: function (req, res, err) {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    }
  })
);

app.use(express.json({ limit: '1mb' }));

// Scan sessions - Production ready for high volume (13 locations, 500+ scans/day)
// At peak: 50 scans/hour/location * 13 locations = 650 scans/hour = ~2600 per 15min
const scanSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // Allow 5000 scans per 15 minutes (20,000/hour capacity)
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    logger.logSecurity('rate_limit_exceeded', {
      ip: req.ip,
      path: req.path,
      type: 'scan_sessions'
    });
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many scan attempts from this IP, please try again later.'
    });
  }
});

app.use('/api/scan-sessions', scanSessionLimiter);
app.use('/api/sales/:saleId/verify', strictLimiter);
app.use('/api/sales/:saleId/complete', strictLimiter);
app.use('/api', generalLimiter);

// Admin routes - protected with admin token authentication
app.use('/admin', adminAuth, adminRoutes);

// API routes - enforce authentication when API_SECRET_KEY is configured
// Note: Sale verification routes (/api/sales/*) use optionalAuth to allow iframe access
app.use('/api/scan-sessions', authenticateRequest, scanSessionRoutes);
app.use('/api/terminal', optionalAuth, terminalRoutes);
app.use('/api', optionalAuth, apiRoutes);

const frontendDir = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));

const rootDir = path.resolve(__dirname, '..', '..');
app.use(express.static(rootDir));

app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'The requested resource was not found.'
  });
});

app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.'
  });
});

module.exports = {
  app,
  logger
};
