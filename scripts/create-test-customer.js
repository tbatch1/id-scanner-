const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..');

dotenv.config({
  path: process.env.DOTENV_PATH || path.join(rootDir, '.env.production.local')
});

function env(name) {
  return String(process.env[name] || '').trim();
}

function assertEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function digitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

async function main() {
  const domainPrefix = env('LIGHTSPEED_DOMAIN_PREFIX') || env('LIGHTSPEED_ACCOUNT_ID');
  const token = env('LIGHTSPEED_API_KEY');
  if (!domainPrefix) throw new Error('Missing LIGHTSPEED_DOMAIN_PREFIX or LIGHTSPEED_ACCOUNT_ID');
  if (!token) throw new Error('Missing LIGHTSPEED_API_KEY');

  const baseURL = `https://${domainPrefix}.retail.lightspeed.app/api/2.0`;

  const phoneArg = process.argv[2] || '';
  const phoneDigits = digitsOnly(phoneArg);
  const randomSuffix = String(Math.floor(1000 + Math.random() * 9000));
  const phoneDigitsFinal = phoneDigits.length >= 7 ? phoneDigits : `713555${randomSuffix}`;

  const timestamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
  const customerCode = `TEST-IDSCAN-${timestamp}-${randomSuffix}`;

  const api = axios.create({
    baseURL,
    timeout: 10_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  // Leave DOB/gender/address blank so the scan autofill has something to populate.
  const payload = {
    first_name: 'TEST',
    last_name: `ID SCAN ${timestamp}`,
    phone: phoneDigitsFinal,
    mobile: phoneDigitsFinal,
    enable_loyalty: true,
    customer_code: customerCode,
    do_not_email: true,
    note: 'TEST customer created by id-scanner-project for scan autofill verification.'
  };

  const res = await api.post('/customers', payload);
  const customer = res?.data?.data || res?.data || null;

  const id = customer?.id || customer?.customer_id || null;
  if (!id) {
    throw new Error(`Customer created but id not found in response. status=${res?.status || 'unknown'}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        customer_id: String(id),
        phone: phoneDigitsFinal,
        customer_code: customerCode
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});

