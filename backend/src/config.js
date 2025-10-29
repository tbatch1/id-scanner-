const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env')
});

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  verificationExpiryMinutes: parseInt(process.env.VERIFICATION_EXPIRY_MINUTES || '15', 10),
  lightspeed: {
    clientId: process.env.LIGHTSPEED_CLIENT_ID || '',
    clientSecret: process.env.LIGHTSPEED_CLIENT_SECRET || '',
    redirectUri: process.env.LIGHTSPEED_REDIRECT_URI || '',
    refreshToken: process.env.LIGHTSPEED_REFRESH_TOKEN || ''
  }
};

module.exports = config;
