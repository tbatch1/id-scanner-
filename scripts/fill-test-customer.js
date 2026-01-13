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

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function randomDobIso({ minAge = 22, maxAge = 55 } = {}) {
  const now = new Date();
  const age = Math.floor(minAge + Math.random() * (maxAge - minAge + 1));
  const year = now.getUTCFullYear() - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

async function main() {
  const customerId = String(process.argv[2] || '').trim();
  if (!customerId) {
    throw new Error('Usage: node scripts/fill-test-customer.js <customer_id>');
  }

  const domainPrefix = env('LIGHTSPEED_DOMAIN_PREFIX') || env('LIGHTSPEED_ACCOUNT_ID');
  const token = assertEnv('LIGHTSPEED_API_KEY');
  if (!domainPrefix) throw new Error('Missing LIGHTSPEED_DOMAIN_PREFIX or LIGHTSPEED_ACCOUNT_ID');

  const baseURL = `https://${domainPrefix}.retail.lightspeed.app/api/2.0`;
  const api = axios.create({
    baseURL,
    timeout: 10_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const streets = ['Demo St', 'Test Ave', 'Mockingbird Ln', 'Sample Rd', 'Verification Blvd'];
  const cities = ['Houston', 'Katy', 'Cypress', 'Bellaire', 'Sugar Land'];
  const states = ['TX'];
  const zips = ['77008', '77024', '77056', '77079', '77494', '77429'];
  const genders = ['M', 'F', 'X'];

  const payload = {
    date_of_birth: randomDobIso(),
    gender: pick(genders),
    physical_address_1: `${100 + Math.floor(Math.random() * 900)} ${pick(streets)}`,
    physical_address_2: pick(['', '', '', 'Suite 200', 'Apt 4']).trim() || null,
    physical_city: pick(cities),
    physical_state: pick(states),
    physical_postcode: pick(zips),
    postal_address_1: null,
    postal_address_2: null,
    postal_city: null,
    postal_state: null,
    postal_postcode: null,
    note: 'TEST: fields populated to simulate a successful ID scan autofill (synthetic data).'
  };

  // Remove nulls to keep request minimal.
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined || v === '') delete payload[k];
  }

  await api.put(`/customers/${encodeURIComponent(customerId)}`, payload);

  console.log(
    JSON.stringify(
      {
        ok: true,
        customer_id: customerId,
        updated_fields: Object.keys(payload).sort(),
        payload
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
