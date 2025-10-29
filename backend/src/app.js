const path = require('path');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const config = require('./config');
const apiRoutes = require('./routes');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard'
          }
        }
      : undefined
});

const app = express();

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

app.use('/api', apiRoutes);

const frontendDir = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));

app.get('/demo/checkout', (req, res) => {
  res.sendFile(path.join(frontendDir, 'checkout.html'));
});

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
