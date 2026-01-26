"use strict";

require('./loadEnv').loadEnv();

const wantsRealLightspeed = process.env.SMOKE_USE_REAL_LIGHTSPEED === 'true';
if (!wantsRealLightspeed) {
  // Ensure we run against the in-memory Lightspeed mock unless explicitly overridden.
  process.env.LIGHTSPEED_API_KEY = 'mock';
  process.env.LIGHTSPEED_CLIENT_ID = '';
  process.env.LIGHTSPEED_ACCOUNT_ID = '';
  process.env.LIGHTSPEED_USE_MOCK = 'true';
}

const wantsDatabase = process.env.SMOKE_USE_DATABASE === 'true';
if (!wantsDatabase) {
  process.env.DATABASE_URL = '';
}

const request = require('supertest');
const { app } = require('../backend/src/app');

const API_KEY = process.env.SMOKE_API_KEY || process.env.API_SECRET_KEY || null;
const SALE_ID = process.env.SMOKE_SALE_ID || 'SALE-1001';
const BANNED_SALE_ID = process.env.SMOKE_BANNED_SALE_ID || 'SALE-1002';
const OVERRIDE_PIN = process.env.SMOKE_OVERRIDE_PIN || process.env.OVERRIDE_PIN || null;
const SHOULD_SKIP_BANNED = process.env.SMOKE_SKIP_BANNED === 'true';
function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/\\r\\n/g, '')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .trim()
    .replace(/^"|"$/g, '');
}

const LOCATION_ID = sanitizeHeaderValue(process.env.SMOKE_LOCATION_ID || process.env.LIGHTSPEED_DEFAULT_OUTLET_ID);
const PAYMENT_TYPE = process.env.SMOKE_PAYMENT_TYPE || 'cash';

function withHeaders(req) {
  if (API_KEY) {
    req.set('X-API-Key', API_KEY);
  }
  if (LOCATION_ID) {
    req.set('X-Location-Id', LOCATION_ID);
  }
  return req;
}

async function get(path, query = '') {
  const url = query ? `${path}?${query}` : path;
  return withHeaders(request(app).get(url));
}

async function post(path, body) {
  return withHeaders(
    request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send(body)
  );
}

function assertOk(res, label) {
  if (res.status < 200 || res.status >= 300) {
    const details = typeof res.body === 'object' && res.body !== null ? JSON.stringify(res.body) : res.text;
    throw new Error(`${label} failed (${res.status}): ${details}`);
  }
}

async function runSmoke() {
  console.log(`>> Running smoke tests (${wantsRealLightspeed ? 'real Lightspeed' : 'mock mode'})`);

  // 1. Healthcheck
  const healthRes = await get('/api/health');
  assertOk(healthRes, 'Healthcheck');
  console.log('[OK] Healthcheck');

  // 2. Happy path verification
  const verifyPayload = {
    clerkId: 'smoke-clerk',
    scan: {
      approved: true,
      firstName: 'Smoke',
      lastName: 'Test',
      dob: '1990-01-01',
      age: 34,
      documentType: 'drivers_license',
      documentNumber: `SMOKE-${Date.now()}`,
      issuingCountry: 'USA'
    }
  };

  const verifyRes = await post(`/api/sales/${SALE_ID}/verify`, verifyPayload);
  assertOk(verifyRes, 'Verification');
  const verificationId = verifyRes.body?.data?.verificationId;
  if (!verificationId) {
    throw new Error('Verification response missing verificationId');
  }
  const verificationLocation = verifyRes.body?.data?.locationId || null;
  if (LOCATION_ID && verificationLocation !== LOCATION_ID) {
    throw new Error(
      `Expected verification to use location ${LOCATION_ID}, received ${verificationLocation || 'none'}`
    );
  }
  console.log(`[OK] Verification (${verificationId})`);
  if (verificationLocation) {
    const outletLabel = verifyRes.body?.data?.outlet?.label || 'unmapped outlet';
    console.log(`    ↳ location: ${verificationLocation} (${outletLabel})`);
  }

  // 3. Override workflow (optional)
  if (OVERRIDE_PIN) {
    const overrideRes = await post(`/api/sales/${SALE_ID}/override`, {
      verificationId,
      managerPin: OVERRIDE_PIN,
      managerId: 'smoke-manager',
      note: 'Smoke test auto-override'
    });
    assertOk(overrideRes, 'Override');
    console.log('[OK] Override');
  } else {
    console.log('-- Override step skipped (no OVERRIDE_PIN set)');
  }

  const completionRes = await post(`/api/sales/${SALE_ID}/complete`, {
    verificationId,
    paymentType: PAYMENT_TYPE
  });
  assertOk(completionRes, 'Sale completion');
  const completionLocation = completionRes.body?.data?.locationId || null;
  if (LOCATION_ID && completionLocation !== LOCATION_ID) {
    throw new Error(
      `Expected completion to use location ${LOCATION_ID}, received ${completionLocation || 'none'}`
    );
  }
  console.log(`[OK] Sale completion (${PAYMENT_TYPE})`);
  if (completionLocation) {
    const outletLabel = completionRes.body?.data?.outlet?.label || 'unmapped outlet';
    console.log(`    ↳ location: ${completionLocation} (${outletLabel})`);
  }

  // 4. Banned flow (optional)
  if (!SHOULD_SKIP_BANNED) {
    let bannedSkipped = false;
    try {
      const bannedDoc = `SMOKE-BANNED-${Date.now()}`;
      const addBannedRes = await post('/api/banned', {
        documentType: 'passport',
        documentNumber: bannedDoc,
        issuingCountry: 'USA',
        notes: 'Smoke test banned record'
      });
      if (addBannedRes.status === 503) {
        bannedSkipped = true;
        console.log('-- Compliance DB unavailable; skipping banned ID step');
      } else {
        assertOk(addBannedRes, 'Add banned record');
        const bannedVerifyRes = await post(`/api/sales/${BANNED_SALE_ID}/verify`, {
          clerkId: 'smoke-clerk',
          scan: {
            approved: true,
            firstName: 'Banned',
            lastName: 'Test',
            dob: '1989-02-02',
            age: 35,
            documentType: 'passport',
            documentNumber: bannedDoc,
            issuingCountry: 'USA'
          }
        });
        assertOk(bannedVerifyRes, 'Banned verification');
        const flagged = bannedVerifyRes.body?.data?.banned;
        if (!flagged) {
          throw new Error('Banned verification did not return banned=true');
        }
        console.log('[OK] Banned ID rejection');
      }
    } catch (error) {
      if (!bannedSkipped) {
        throw error;
      }
    }
  } else {
    console.log('-- Banned flow skipped (SMOKE_SKIP_BANNED=true)');
  }

  // 5. Compliance report
  const complianceRes = await get('/api/reports/compliance', 'days=1&limit=5');
  if (complianceRes.status === 503) {
    console.log('-- Compliance report unavailable (storage disabled)');
  } else {
    assertOk(complianceRes, 'Compliance report');
    console.log('[OK] Compliance report');
  }

  // 6. Overrides report
  const overridesRes = await get('/api/reports/overrides', 'days=30&limit=20');
  if (overridesRes.status === 503) {
    console.log('-- Override report unavailable (no DB connection)');
  } else {
    assertOk(overridesRes, 'Overrides report');
    console.log('[OK] Overrides report');
  }

  console.log('>> Smoke tests completed successfully');
}

runSmoke()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Smoke tests failed:', error.message);
    process.exit(1);
  });
