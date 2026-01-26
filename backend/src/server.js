// Load local secrets before importing config/app (config reads process.env at require-time).
try {
  // eslint-disable-next-line global-require
  require('./localSecrets').loadLocalSecrets();
} catch {
  // optional
}

const config = require('./config');
const { app, logger } = require('./app');

app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env
    },
    'Mock Lightspeed enforcement backend started'
  );
});
