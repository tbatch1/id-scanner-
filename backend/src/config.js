const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env')
});

const outletPrefix = 'LIGHTSPEED_OUTLET_ID_';

const outletEntries = Object.entries(process.env)
  .filter(([key, value]) => key.startsWith(outletPrefix) && value)
  .map(([key, value]) => {
    const code = key.substring(outletPrefix.length);
    const slug = code.toLowerCase();
    const label = code
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return [
      slug,
      {
        id: value,
        code,
        label
      }
    ];
  });

const lightspeedOutlets = outletEntries.reduce((acc, [slug, descriptor]) => {
  acc[slug] = descriptor;
  return acc;
}, {});

const lightspeedOutletsById = outletEntries.reduce((acc, [, descriptor]) => {
  acc[descriptor.id] = descriptor;
  return acc;
}, {});

const defaultOutletId =
  process.env.LIGHTSPEED_DEFAULT_OUTLET_ID ||
  (lightspeedOutlets.warehouse ? lightspeedOutlets.warehouse.id : null) ||
  (outletEntries.length > 0 ? outletEntries[0][1].id : null);

const paymentTypes = {
  cash: process.env.LIGHTSPEED_PAYMENT_TYPE_ID_CASH || '',
  card: process.env.LIGHTSPEED_PAYMENT_TYPE_ID_CARD || ''
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  verificationExpiryMinutes: parseInt(process.env.VERIFICATION_EXPIRY_MINUTES || '15', 10),
  lightspeed: {
    apiKey: process.env.LIGHTSPEED_API_KEY || '',
    accountId: process.env.LIGHTSPEED_ACCOUNT_ID || '',
    clientId: process.env.LIGHTSPEED_CLIENT_ID || '',
    clientSecret: process.env.LIGHTSPEED_CLIENT_SECRET || '',
    redirectUri: process.env.LIGHTSPEED_REDIRECT_URI || '',
    refreshToken: process.env.LIGHTSPEED_REFRESH_TOKEN || '',
    domainPrefix: process.env.LIGHTSPEED_DOMAIN_PREFIX || '',
    apiBaseUrl: process.env.LIGHTSPEED_API_BASE_URL || '',
    authBaseUrl: process.env.LIGHTSPEED_AUTH_BASE_URL || '',
    tokenUrl: process.env.LIGHTSPEED_TOKEN_URL || '',
    outlets: lightspeedOutlets,
    outletsById: lightspeedOutletsById,
    defaultOutletId,
    paymentTypes,
    enableWrites: process.env.LIGHTSPEED_ENABLE_WRITE === 'true'
  }
};

module.exports = config;
