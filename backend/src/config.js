const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env')
});

function envTrim(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

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
        id: typeof value === 'string' ? value.trim() : value,
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
  envTrim('LIGHTSPEED_DEFAULT_OUTLET_ID') ||
  (lightspeedOutlets.warehouse ? lightspeedOutlets.warehouse.id : null) ||
  (outletEntries.length > 0 ? outletEntries[0][1].id : null);

const paymentTypes = {
  cash: envTrim('LIGHTSPEED_PAYMENT_TYPE_ID_CASH'),
  card: envTrim('LIGHTSPEED_PAYMENT_TYPE_ID_CARD')
};

const config = {
  env: envTrim('NODE_ENV', 'development'),
  port: parseInt(envTrim('PORT', '4000'), 10),
  verificationExpiryMinutes: parseInt(envTrim('VERIFICATION_EXPIRY_MINUTES', '15'), 10),
  lightspeed: {
    apiKey: envTrim('LIGHTSPEED_API_KEY'),
    accountId: envTrim('LIGHTSPEED_ACCOUNT_ID'),
    clientId: envTrim('LIGHTSPEED_CLIENT_ID'),
    clientSecret: envTrim('LIGHTSPEED_CLIENT_SECRET'),
    redirectUri: envTrim('LIGHTSPEED_REDIRECT_URI'),
    refreshToken: envTrim('LIGHTSPEED_REFRESH_TOKEN'),
    domainPrefix: envTrim('LIGHTSPEED_DOMAIN_PREFIX'),
    apiBaseUrl: envTrim('LIGHTSPEED_API_BASE_URL'),
    authBaseUrl: envTrim('LIGHTSPEED_AUTH_BASE_URL'),
    tokenUrl: envTrim('LIGHTSPEED_TOKEN_URL'),
    outlets: lightspeedOutlets,
    outletsById: lightspeedOutletsById,
    defaultOutletId,
    paymentTypes,
    enableWrites: envTrim('LIGHTSPEED_ENABLE_WRITE') === 'true'
  }
};

module.exports = config;
