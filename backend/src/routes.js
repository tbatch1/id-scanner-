const express = require('express');
const config = require('./config');
const lightspeed = require('./lightspeedClient');
const logger = require('./logger');
const db = require('./db');
const complianceStore = require('./complianceStore');
const saleVerificationStore = require('./saleVerificationStore');
const { validateVerification, validateCompletion, validateBannedCreate, validateBannedId, validateOverride, validateSaleId, sanitizeString } = require('./validation');
const lightspeedWebhookQueue = require('./lightspeedWebhookQueue');
const customerReconcileQueue = require('./customerReconcileQueue');
const customerFillQueue = require('./customerFillQueue');

const { buildCustomerUpdatePayload } = require('./lightspeedCustomerFields');

const router = express.Router();

// Note: admin routes are intentionally not token-gated in this deployment.

const millisecondsPerMinute = 60 * 1000;
const lightspeedMode = process.env.LIGHTSPEED_USE_MOCK === 'true' ? 'mock' : 'live';

// Client Error Reporting Endpoint
const recentClientDiagnostics = [];
const maxRecentClientDiagnostics = 250;

function sanitizeDiagnosticDetails(details) {
  try {
    if (!details) return null;
    if (typeof details !== 'object') return { value: String(details).slice(0, 500) };

    const output = {};
    for (const [key, value] of Object.entries(details)) {
      const lowerKey = String(key || '').toLowerCase();
      if (lowerKey.includes('barcode') || lowerKey.includes('payload') || lowerKey.includes('raw')) {
        output[key] = '[redacted]';
        continue;
      }

      if (typeof value === 'string') {
        output[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
        continue;
      }

      output[key] = value;
    }

    return output;
  } catch {
    return null;
  }
}

function recordClientDiagnostic(entry) {
  try {
    recentClientDiagnostics.push(entry);
    while (recentClientDiagnostics.length > maxRecentClientDiagnostics) {
      recentClientDiagnostics.shift();
    }
  } catch {
    // ignore
  }
}

router.post('/debug/client-errors', async (req, res) => {
  const nowIso = new Date().toISOString();
  const { type, error, details, userAgent, saleId } = req.body || {};
  const allowedTypes = new Set(['CLIENT_ERROR', 'CLIENT_LOG']);
  const normalizedType = allowedTypes.has(type) ? type : 'CLIENT_ERROR';
  const safeDetails = sanitizeDiagnosticDetails(details);

  recordClientDiagnostic({
    at: nowIso,
    type: normalizedType,
    saleId: saleId || null,
    error: error || null,
    details: safeDetails,
    userAgent: userAgent || null
  });

  // Always emit to runtime logs so we can tail it even when DB logging is disabled/misconfigured.
  logger.info(
    {
      event: 'client_diagnostic',
      type: normalizedType,
      saleId: saleId || null,
      error: error || null,
      details: safeDetails
    },
    'Client diagnostic'
  );

  let dbStored = false;
  try {
    await complianceStore.logDiagnostic({
      type: normalizedType,
      saleId,
      userAgent,
      error,
      details: safeDetails
    });
    dbStored = true;
  } catch (err) {
    logger.warn({ event: 'client_diagnostic_db_failed', error: err.message }, 'Failed to persist client diagnostic');
  }

  // Always return success so the frontend never blocks on diagnostics.
  res.json({ success: true, dbStored });
});

// Best-effort short-term "history" for debugging without a log drain.
// Note: serverless instances are ephemeral; this is meant for immediate diagnosis only.
router.get('/debug/client-errors/recent', (req, res) => {
  const adminToken = req.get('x-admin-token');
  if (process.env.ADMIN_TOKEN && adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const limit = Math.max(1, Math.min(250, Number(req.query.limit) || 100));
  const items = recentClientDiagnostics.slice(-limit);
  res.json({ success: true, count: items.length, items });
});

// Ping Endpoint for connectivity testing
router.get('/debug/ping', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    db: db.pool ? 'connected' : 'none'
  });
});

function isVerificationExpired(verification) {
  if (!verification) {
    return true;
  }

  const expiryWindow = config.verificationExpiryMinutes * millisecondsPerMinute;
  const verifiedAt = new Date(verification.createdAt).getTime();
  const now = Date.now();

  return now - verifiedAt > expiryWindow;
}

function mapDbVerification(row) {
  if (!row) {
    return null;
  }

  return {
    verificationId: row.verification_id,
    saleId: row.sale_id,
    clerkId: row.clerk_id,
    status: row.status || row.verification_status,
    reason: row.reason || row.rejection_reason,
    firstName: row.first_name,
    lastName: row.last_name,
    middleName: row.middle_name,
    dob: row.date_of_birth,
    age: row.age,
    documentType: row.document_type,
    documentNumber: row.document_number,
    issuingCountry: row.issuing_country,
    documentExpiry: row.document_expiry
      ? new Date(row.document_expiry).toISOString().split('T')[0]
      : null,
    nationality: row.nationality,
    sex: row.sex,
    source: row.source,
    createdAt: row.created_at || row.verified_at,
    updatedAt: row.updated_at || row.completed_at || row.verified_at
  };
}

function normalizeDateInput(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (digitsOnly.length === 8) {
    const year = digitsOnly.substring(0, 4);
    const month = digitsOnly.substring(4, 6);
    const day = digitsOnly.substring(6, 8);
    const monthNum = Number(month);
    const dayNum = Number(day);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

function normalizeCountry(value) {
  if (!value) return null;
  const sanitized = sanitizeString(value);
  return sanitized ? sanitized.toUpperCase().substring(0, 120) : null;
}

function normalizeDocumentNumber(value) {
  if (!value) return null;
  const sanitized = sanitizeString(value).replace(/\s+/g, '');
  return sanitized ? sanitized.toUpperCase().substring(0, 150) : null;
}

function normalizeSex(value) {
  if (!value) return null;
  const upper = sanitizeString(value).toUpperCase();
  if (upper.startsWith('M')) return 'M';
  if (upper.startsWith('F')) return 'F';
  if (upper.startsWith('X') || upper.startsWith('N')) return 'X';
  return null;
}

function normalizeSource(value) {
  const sanitized = sanitizeString(value || '');
  const lower = sanitized ? sanitized.toLowerCase() : '';
  if (lower === 'mrz' || lower === 'pdf417') {
    return lower;
  }
  return 'pdf417';
}

function normalizeDocumentType(value) {
  const sanitized = sanitizeString(value || '');
  const lower = sanitized.toLowerCase();
  const allowed = ['drivers_license', 'passport', 'mrz_id', 'id_card', 'routed_id', 'name_dob'];
  if (allowed.includes(lower)) {
    return lower;
  }
  return 'drivers_license';
}

function normalizeEmail(value) {
  const sanitized = sanitizeString(value || '').trim().toLowerCase();
  if (!sanitized) return null;
  if (sanitized.length > 254) return sanitized.substring(0, 254);
  return sanitized;
}

function normalizePhone(value) {
  const sanitized = sanitizeString(value || '').trim().replace(/\s+/g, ' ');
  if (!sanitized) return null;
  return sanitized.substring(0, 30);
}

function getOutletDescriptor(outletId, saleOutlet) {
  if (!outletId && saleOutlet && saleOutlet.id) {
    return {
      id: saleOutlet.id,
      code: saleOutlet.code || null,
      label: saleOutlet.label || null
    };
  }

  if (!outletId) {
    return null;
  }

  const outletsById = config.lightspeed?.outletsById || {};
  const descriptor =
    (saleOutlet && saleOutlet.id === outletId ? saleOutlet : null) ||
    outletsById[outletId] ||
    null;

  if (descriptor) {
    return {
      id: descriptor.id || outletId,
      code: descriptor.code || null,
      label: descriptor.label || null
    };
  }

  return {
    id: outletId,
    code: null,
    label: null
  };
}

function determineLocationId(req, sale) {
  const header = req.get('x-location-id');
  if (header) {
    return sanitizeString(header);
  }

  if (req.query && req.query.locationId) {
    return sanitizeString(req.query.locationId);
  }

  if (sale && sale.outletId) {
    return sale.outletId;
  }

  return config.lightspeed?.defaultOutletId || null;
}

function toNullableString(value, max = 500) {
  const sanitized = sanitizeString(value);
  if (!sanitized) return null;
  return sanitized.substring(0, max);
}

function normalizeScanInput(rawScan = {}) {
  const normalized = {
    approved: Boolean(rawScan.approved),
    reason: toNullableString(rawScan.reason),
    firstName: toNullableString(rawScan.firstName, 100),
    lastName: toNullableString(rawScan.lastName, 100),
    middleName: toNullableString(rawScan.middleName, 100),
    dob: normalizeDateInput(rawScan.dob),
    age: Number.isFinite(Number(rawScan.age)) ? Number(rawScan.age) : null,
    documentType: normalizeDocumentType(rawScan.documentType),
    documentNumber: normalizeDocumentNumber(rawScan.documentNumber),
    issuingCountry: normalizeCountry(rawScan.issuingCountry),
    nationality: normalizeCountry(rawScan.nationality),
    documentExpiry: normalizeDateInput(rawScan.documentExpiry),
    sex: normalizeSex(rawScan.sex),
    source: normalizeSource(rawScan.source)
  };

  if (!normalized.nationality && normalized.issuingCountry) {
    normalized.nationality = normalized.issuingCountry;
  }

  return normalized;
}

async function resolveLatestVerification(saleId, existingVerification) {
  if (existingVerification) {
    return existingVerification;
  }

  if (!db.pool) {
    return null;
  }

  const record = await complianceStore.getLatestVerificationForSale(saleId);
  return mapDbVerification(record);
}

router.get('/health', async (req, res) => {
  let databaseStatus = 'not_configured';

  if (db.pool) {
    databaseStatus = (await db.testConnection()) ? 'ok' : 'error';
  }

  const lightspeedHealth = {
    mode: lightspeedMode,
    writesEnabled: Boolean(config.lightspeed?.enableWrites)
  };
  if (typeof lightspeed.getAuthState === 'function') {
    const state = lightspeed.getAuthState();
    if (state && typeof state === 'object') {
      Object.assign(lightspeedHealth, state);
    }
  }

  res.json({
    status: 'ok',
    environment: config.env,
    timestamp: new Date().toISOString(),
    database: databaseStatus,
    lightspeed: lightspeedHealth
  });
});

// Debug endpoint for troubleshooting (shows env config without secrets)
router.get('/debug/config', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  let dbTest = { connected: false, error: null };

  if (db.pool) {
    try {
      const result = await db.testConnection();
      dbTest.connected = result;
    } catch (e) {
      dbTest.error = e.message;
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'not set',
      DATABASE_URL: dbUrl ? `configured (${dbUrl.substring(0, 20)}...)` : 'NOT CONFIGURED',
      OVERRIDE_PIN: process.env.OVERRIDE_PIN ? 'configured' : 'using default 1417'
    },
    database: {
      poolExists: Boolean(db.pool),
      ...dbTest
    },
    lightspeed: {
      mode: lightspeedMode,
      configured: Boolean(config.lightspeed?.enableWrites)
    }
  });
});

// Global dev logs (uncorrelated)
router.post('/logs', (req, res) => {
  const { timestamp, level, message, meta } = req.body || {};

  const logEntry = {
    timestamp: timestamp || new Date().toISOString(),
    level: level || 'info',
    message: message || '',
    meta: meta || {}
  };

  req.log.info({ frontendLog: logEntry }, `Frontend log: ${level} - ${message}`);

  res.status(202).json({ received: true });
});

// Sale-specific "Friendship" heartbeat (from handheld scanner)
router.post('/sales/:saleId/heartbeat', (req, res) => {
  const { saleId } = req.params;
  const verification = saleVerificationStore.updateHeartbeat(saleId);

  if (!verification) {
    return res.status(404).json({ success: false, error: 'SALE_NOT_FOUND' });
  }

  res.json({ success: true, status: verification.status });
});

// Sale-specific "Friendship" logs (for dev troubleshooting trace)
router.post('/sales/:saleId/logs', (req, res) => {
  const { saleId } = req.params;
  const { message, type } = req.body || {};

  if (!message) return res.status(400).json({ error: 'Message required' });

  saleVerificationStore.addSessionLog(saleId, message, type || 'info');
  res.json({ success: true });
});

router.get('/sales', async (req, res, next) => {
  try {
    const sales = await lightspeed.listSales();
    res.json({ data: sales });
  } catch (error) {
    next(error);
  }
});

router.get('/sales/:saleId', async (req, res, next) => {
  try {
    const sale = await lightspeed.getSaleById(req.params.saleId);
    if (!sale) {
      return res.status(404).json({
        error: 'SALE_NOT_FOUND',
        message: 'Sale not found in mock store. Seed new sales in mockLightspeedClient.js'
      });
    }

    const verification = await resolveLatestVerification(sale.saleId, sale.verification);
    const expired = isVerificationExpired(verification);

    res.json({
      data: {
        ...sale,
        verification,
        verificationExpired: expired
      }
    });
  } catch (error) {
    next(error);
  }
});


// Helper to parse AAMVA (Driver's License) Barcodes
function parseAAMVA(data) {
  if (!data || typeof data !== 'string') return null;

  // Normalize common barcode control characters so parsing works across scanners.
  // Many PDF417/AAMVA payloads use FS/GS/RS/US separators instead of CR/LF.
  const normalizedData = data
    .replace(/\r\n/g, '\n')
    .replace(/[\r\n]/g, '\n')
    .replace(/[\x1c-\x1f]/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1b]/g, '');

  // Basic AAMVA parsing logic
  // Looks for subfile designators like "DAA", "DBB", etc.

  const extract = (key) => {
    // Regex to find the key followed by data, ending at a terminator or new field
    // AAMVA fields are often separated by LF (0x0A) or CR (0x0D)
    const regex = new RegExp(`${key}([^\\n\\r]+)`, 'i');
    const match = normalizedData.match(regex);
    return match ? match[1].trim() : null;
  };

  const firstName = extract('DAC') || extract('DCT'); // DCT is sometimes used
  const lastName = extract('DCS') || extract('DCP'); // DCP is sometimes used
  const fullName = extract('DAA'); // Full name sometimes in one field

  let finalFirstName = firstName;
  let finalLastName = lastName;

  if (!finalFirstName && !finalLastName && fullName) {
    const parts = fullName.split(',');
    if (parts.length > 0) finalLastName = parts[0].trim();
    if (parts.length > 1) finalFirstName = parts[1].trim();
  }

  const dobRaw = extract('DBB');
  // DOB fallback: some scanners remove separators, causing extract() to capture extra fields.
  // Try to find a DBB date anywhere in the payload.
  const dobFallback = (() => {
    if (dobRaw) return dobRaw;
    const candidates = [
      /DBB\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
      /DBB\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i,
      /DBB\s*([0-9]{8})/i,
      /DBB[^0-9]*([0-9]{8})/i
    ];
    for (const re of candidates) {
      const m = normalizedData.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  })();
  const docNumber = extract('DAQ');
  const expiryRaw = extract('DBA');
  const sex = extract('DBC');
  const country = extract('DCG') || 'USA';
  const postalCode = extract('DAK');
  const address1 = extract('DAG');
  const address2 = extract('DAH');
  const city = extract('DAI');
  const state = extract('DAJ');
  const suburb = extract('DAI'); // Lightspeed has a suburb field; for US IDs this maps closest to city.

  // Parse DOB (YYYYMMDD or MMDDYYYY)
  let dob = null;
  let age = null;
  if (dobFallback) {
    const digits = (dobFallback.match(/\d/g) || []).join('');
    // Prefer 8 digit format if present.
    const raw8 = digits.length >= 8 ? digits.substring(0, 8) : null;
    if (raw8 && raw8.match(/^\d{8}$/)) {
      // YYYYMMDD if it starts with a plausible year, otherwise MMDDYYYY if the last 4 is a plausible year.
      const startsWithYear = raw8.startsWith('19') || raw8.startsWith('20');
      const endsWithYear = raw8.substring(4, 8).startsWith('19') || raw8.substring(4, 8).startsWith('20');
      if (startsWithYear) {
        const y = parseInt(raw8.substring(0, 4), 10);
        const m = parseInt(raw8.substring(4, 6), 10) - 1;
        const d = parseInt(raw8.substring(6, 8), 10);
        dob = new Date(y, m, d);
      } else if (endsWithYear) {
        const m = parseInt(raw8.substring(0, 2), 10) - 1;
        const d = parseInt(raw8.substring(2, 4), 10);
        const y = parseInt(raw8.substring(4, 8), 10);
        dob = new Date(y, m, d);
      }
    }

    // YYYY-MM-DD
    if (!dob || isNaN(dob.getTime())) {
      const m = dobFallback.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) dob = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }

    // MM/DD/YYYY
    if (!dob || isNaN(dob.getTime())) {
      const m = dobFallback.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) dob = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    }
  }

  if (dob && !isNaN(dob.getTime())) {
    try {
      const diff = Date.now() - dob.getTime();
      const ageDate = new Date(diff);
      age = Math.abs(ageDate.getUTCFullYear() - 1970);
    } catch (e) {
      age = null;
    }
  }

  return {
    firstName: finalFirstName,
    lastName: finalLastName,
    dob,
    age,
    documentNumber: docNumber,
    documentExpiry: expiryRaw, // Keep raw for now, normalization happens later
    sex: sex === '1' ? 'M' : (sex === '2' ? 'F' : sex),
    issuingCountry: country,
    postalCode,
    address1,
    address2,
    suburb,
    city,
    state
  };
}

// ========== TEST ENDPOINT FOR SCANNER DEBUGGING ==========
router.post('/test-scan', (req, res) => {
  console.log('======================================');
  console.log('🧪 TEST SCAN ENDPOINT HIT');
  console.log('======================================');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  console.log('Body Keys:', Object.keys(req.body || {}));
  if (req.body.barcodeData) {
    console.log('Barcode Length:', req.body.barcodeData.length);
    console.log('Barcode First 100:', req.body.barcodeData.substring(0, 100));
    console.log('Has @ANSI:', req.body.barcodeData.includes('@ANSI'));
    console.log('Has ]L:', req.body.barcodeData.includes(']L'));
  }
  console.log('======================================\n');

  res.json({
    received: true,
    timestamp: new Date().toISOString(),
    bodyLength: JSON.stringify(req.body).length,
    barcodeLength: req.body.barcodeData ? req.body.barcodeData.length : 0
  });
});

router.post('/sales/:saleId/verify-bluetooth', async (req, res) => {
  const requestedSaleId = (req.params.saleId || '').trim();
  let effectiveSaleId = requestedSaleId;
  const barcodeData = (req.body.barcodeData || '').trim();
  const registerId = (req.body.registerId || '').trim();
  const clerkId = (req.body.clerkId || '').trim();

  if (requestedSaleId && !saleVerificationStore.getVerification(requestedSaleId)) {
    try {
      saleVerificationStore.createVerification(requestedSaleId, { registerId: registerId || null });
    } catch { }
  }

  // 0. Kick off parallel diagnostic and sale retrieval
  // Fire-and-forget diagnostic so it never blocks or crashes the main flow
  complianceStore.logDiagnostic({
    type: 'SCAN_ATTEMPT',
    saleId: requestedSaleId,
    details: { registerId, clerkId, barcodeLength: barcodeData.length }
  }).catch(err => logger.error({ err }, 'Fire-and-forget logDiagnostic failed'));

  console.log('===========================================');
  console.log('🔫 BLUETOOTH SCANNER SCAN RECEIVED');
  console.log('===========================================');
  console.log('Sale ID:', requestedSaleId);
  console.log('Barcode Length:', barcodeData.length);
  console.log('===========================================');

  if (!barcodeData) {
    return res.status(400).json({ success: false, error: 'Barcode data is required.' });
  }

  try {
    // FAST VERIFY PATH:
    // Keep scanning snappy by doing only: parse -> underage -> banned -> persist -> respond.
    // Customer profile population is handled asynchronously via customer reconcile jobs (cron) so it never blocks the scan UI.
    const fastVerifyStartedAt = Date.now();
    const timing = {
      parseMs: null,
      bannedMs: null,
      dbSaveMs: null,
      totalMs: null
    };
    const locationIdFast = determineLocationId(req, null);
    const saleTotalFast =
      req.body.saleTotal !== undefined
        ? Number(req.body.saleTotal)
        : req.body.amount !== undefined
          ? Number(req.body.amount)
          : req.body.saleAmount !== undefined
            ? Number(req.body.saleAmount)
            : null;

    saleVerificationStore.addSessionLog(requestedSaleId, `FAST_VERIFY: starting (register: ${registerId || 'MISSING'})`, 'info');

    const parseStartedAt = Date.now();
    let parsedFast = parseAAMVA(barcodeData);
    timing.parseMs = Date.now() - parseStartedAt;
    console.log('📊 PARSE RESULT (FAST):', JSON.stringify(parsedFast, null, 2));

    if (!parsedFast || !parsedFast.age) {
      parsedFast = {
        firstName: 'Unknown',
        lastName: 'Customer',
        age: null,
        documentNumber: 'RAW-' + barcodeData.substring(0, 10),
        issuingCountry: 'Unknown'
      };
    }

    let approvedFast = false;
    let reasonFast = null;

    if (parsedFast.age !== null) {
      if (parsedFast.age >= 21) {
        approvedFast = true;
      } else {
        approvedFast = false;
        reasonFast = `Underage (${parsedFast.age})`;
      }
    } else {
      approvedFast = false;
      reasonFast = 'Could not read DOB';
    }

    if (approvedFast && db.pool && (parsedFast.documentNumber || (parsedFast.firstName && parsedFast.lastName && parsedFast.dob))) {
      try {
        const bannedStartedAt = Date.now();
        const bannedRecord = await complianceStore.findBannedCustomer({
          documentType: 'drivers_license',
          documentNumber: parsedFast.documentNumber,
          issuingCountry: parsedFast.issuingCountry,
          firstName: parsedFast.firstName,
          lastName: parsedFast.lastName,
          dateOfBirth: parsedFast.dob ? parsedFast.dob : null
        });
        timing.bannedMs = Date.now() - bannedStartedAt;
        if (bannedRecord) {
          approvedFast = false;
          reasonFast = bannedRecord.notes || 'BANNED_CUSTOMER';
          logger.logSecurity('banned_customer_attempt_bluetooth', {
            saleId: requestedSaleId,
            documentNumber: parsedFast.documentNumber,
            bannedId: bannedRecord.id
          });
        }
      } catch (e) {
        logger.error('Banned check failed', e);
      }
    }

    const verificationIdFast = `V-${requestedSaleId || 'SCAN'}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let dbSavedFast = false;

    if (db.pool) {
      try {
        const safeIso = (d) => (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString() : null;
        const dbSaveStartedAt = Date.now();
        await complianceStore.saveVerification(
          {
            verificationId: verificationIdFast,
            saleId: requestedSaleId,
            clerkId: clerkId || 'BLUETOOTH_DEVICE',
            status: approvedFast ? 'approved' : 'rejected',
            reason: reasonFast,
            firstName: parsedFast.firstName,
            lastName: parsedFast.lastName,
            dob: safeIso(parsedFast.dob),
            age: parsedFast.age,
            documentType: 'drivers_license',
            documentNumber: parsedFast.documentNumber,
            issuingCountry: parsedFast.issuingCountry,
            nationality: parsedFast.issuingCountry,
            sex: parsedFast.sex,
            source: 'bluetooth_gun'
          },
          {
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            locationId: locationIdFast
          }
        );
        timing.dbSaveMs = Date.now() - dbSaveStartedAt;
        dbSavedFast = true;
      } catch (dbError) {
        saleVerificationStore.addSessionLog(requestedSaleId, `DB save failed: ${dbError.message}`, 'warn');
        logger.error({ event: 'bluetooth_db_save_failed', saleId: requestedSaleId }, 'Failed to save bluetooth verification to DB');
      }
    }

    let customerReconcileQueuedFast = false;
    let customerReconcileReasonFast = null;
    let customerFillQueuedFast = false;
    let fieldsFast = null;
    if (approvedFast) {
      try {
        fieldsFast = buildCustomerUpdatePayload(parsedFast);
      } catch (e) {
        fieldsFast = null;
      }

      if (fieldsFast) {
        const queued = customerFillQueue.enqueueCustomerFill({ saleId: requestedSaleId, fields: fieldsFast });
        customerFillQueuedFast = Boolean(queued?.queued);
        saleVerificationStore.addSessionLog(
          requestedSaleId,
          customerFillQueuedFast ? 'LOADER: Waiting for loyalty customer attach (in-memory)' : `LOADER: Not queued (${queued?.reason || 'unknown'})`,
          customerFillQueuedFast ? 'info' : 'warn'
        );
      }

      // Sale notes are intentionally disabled (compliance is tracked via DB + manager audit endpoints instead).

      if (fieldsFast && db.pool && typeof lightspeed.updateCustomerById === 'function') {
        customerReconcileReasonFast = 'populate_customer_fields_async';
        try {
          await customerReconcileQueue.enqueueJob({
            saleId: requestedSaleId,
            verificationId: verificationIdFast,
            fields: fieldsFast,
            delayMs: 0,
            registerId: registerId || null,
            outletId: locationIdFast || null,
            saleTotal: Number.isFinite(saleTotalFast) ? saleTotalFast : null
          });
          customerReconcileQueuedFast = true;
        } catch (e) {
          logger.warn({ event: 'customer_reconcile_enqueue_failed', saleId: requestedSaleId, error: e.message }, 'Failed to enqueue customer reconcile job');
        }
      }
    }

    try {
      saleVerificationStore.updateVerification(requestedSaleId, {
        approved: approvedFast,
        customerId: parsedFast.documentNumber,
        customerName: `${parsedFast.firstName || ''} ${parsedFast.lastName || ''}`.trim() || 'Customer',
        age: parsedFast.age,
        reason: reasonFast,
        registerId: registerId || 'BLUETOOTH-SCANNER',
        saleId: requestedSaleId
      });
    } catch (e) {
      // ignore
    }

    timing.totalMs = Date.now() - fastVerifyStartedAt;
    logger.info(
      {
        event: 'verify_bluetooth_timing',
        saleId: requestedSaleId,
        approved: approvedFast,
        reason: reasonFast || null,
        dbEnabled: Boolean(db.pool),
        parseMs: timing.parseMs,
        bannedMs: timing.bannedMs,
        dbSaveMs: timing.dbSaveMs,
        totalMs: timing.totalMs
      },
      'Bluetooth verify timing'
    );

    return res.json({
      success: true,
      approved: approvedFast,
      verificationId: verificationIdFast,
      requestedSaleId,
      saleId: requestedSaleId,
      resolvedSaleId: null,
      customerName: `${parsedFast.firstName || ''} ${parsedFast.lastName || ''}`.trim() || 'Customer',
      age: parsedFast.age,
      dob: parsedFast.dob && !isNaN(parsedFast.dob.getTime()) ? parsedFast.dob.toISOString().slice(0, 10) : null,
      reason: reasonFast,
      dbSaved: dbSavedFast,
      customerReconcileQueued: customerReconcileQueuedFast,
      customerReconcileReason: customerReconcileReasonFast,
      processingMs: Date.now() - fastVerifyStartedAt,
      timing
    });

    // 1. Get Sale Context
    saleVerificationStore.addSessionLog(requestedSaleId, `Starting Bluetooth scan (register: ${registerId})`, 'info');

    let sale = null;
    let locationId = determineLocationId(req, null);
    let saleFetchAttempts = 0;
    let saleFetchError = null;
    let resolvedSaleId = null;

    async function resolveSaleViaRegisterId() {
      const rid = String(registerId || '').trim();
      if (!rid || typeof lightspeed.listSales !== 'function') return null;
      try {
        const candidates = await lightspeed.listSales({ status: 'OPEN', limit: 25, registerId: rid });
        const list = Array.isArray(candidates) ? candidates : [];
        if (!list.length) return null;
        list.sort((a, b) => {
          const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
        });
        return list[0] || null;
      } catch (e) {
        saleFetchError = saleFetchError || e?.message || 'resolve_failed';
        return null;
      }
    }
    try {
      saleVerificationStore.addSessionLog(requestedSaleId, 'Checking Lightspeed sale context...', 'info');
      saleFetchAttempts += 1;
      sale = await lightspeed.getSaleById(effectiveSaleId);
      locationId = determineLocationId(req, sale);
      saleVerificationStore.addSessionLog(requestedSaleId, `Sale context OK (${sale.items.length} items)`, 'info');
    } catch (e) {
      saleFetchError = e.message;
      saleVerificationStore.addSessionLog(requestedSaleId, `Sale context failed: ${e.message}`, 'warn');

      if (String(e.message || '').toUpperCase() === 'SALE_NOT_FOUND') {
        const resolved = await resolveSaleViaRegisterId();
        if (resolved?.saleId) {
          resolvedSaleId = String(resolved.saleId).trim();
          effectiveSaleId = resolvedSaleId;
          sale = resolved;
          locationId = determineLocationId(req, sale);
          saleVerificationStore.addSessionLog(requestedSaleId, `Resolved Retail sale id: ${resolvedSaleId}`, 'info');
        } else {
          console.warn('Sale lookup failed during bluetooth scan (unresolved), proceeding with defaults');
        }
      } else {
        console.warn('Sale lookup failed during bluetooth scan, proceeding with defaults');
      }
    }

    // 2. Parse the Barcode
    saleVerificationStore.addSessionLog(requestedSaleId, `Parsing barcode (${barcodeData.length} chars)...`, 'info');
    let parsed = parseAAMVA(barcodeData);

    if (parsed) {
      saleVerificationStore.addSessionLog(requestedSaleId, `Parsed ID: ${parsed.firstName} ${parsed.lastName}`, 'info');
    }

    // Log parse result
    console.log('📊 PARSE RESULT:', JSON.stringify(parsed, null, 2));

    // Fallback if parsing failed (or not AAMVA)
    if (!parsed || !parsed.age) {
      // If it's just a raw string and not AAMVA, we might fail or treat as manual entry
      // For this specific "Gun" implementation, we really expect AAMVA.
      // But let's be graceful.
      parsed = {
        firstName: 'Unknown',
        lastName: 'Customer',
        age: null, // Will trigger manual check if null
        documentNumber: 'RAW-' + barcodeData.substring(0, 10),
        issuingCountry: 'Unknown'
      };
    }

    // 2. Determine Approval
    let approved = false;
    let reason = null;

    if (parsed.age !== null) {
      if (parsed.age >= 21) {
        approved = true;
      } else {
        approved = false;
        reason = `Underage (${parsed.age})`;
      }
    } else {
      approved = false;
      reason = 'Could not read DOB';
    }

    // If the clerk attached a loyalty customer right before scanning, the sale->customer link can lag briefly.
    // Re-fetch the sale a few times (fast) so customer profile sync is reliable.
    if (approved && (!sale || !sale.customerId) && typeof lightspeed.getSaleById === 'function') {
      const delays = [250, 500, 750, 1000];
      for (const delayMs of delays) {
        if (sale?.customerId) break;
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          saleFetchAttempts += 1;
          const refreshed = await lightspeed.getSaleById(effectiveSaleId);
          if (refreshed) {
            sale = refreshed;
            locationId = determineLocationId(req, sale);
          }
          if (sale?.customerId) {
            saleVerificationStore.addSessionLog(requestedSaleId, `Customer attached detected after ${saleFetchAttempts} sale fetch(es)`, 'info');
            break;
          }
        } catch (e) {
          saleFetchError = e?.message || saleFetchError;
        }
      }
    }

    // 3. Check Banned List (Database)
    let bannedRecord = null;
    if (db.pool && (parsed.documentNumber || (parsed.firstName && parsed.lastName && parsed.dob))) {
      try {
        saleVerificationStore.addSessionLog(requestedSaleId, 'Checking banned customers...', 'info');
        bannedRecord = await complianceStore.findBannedCustomer({
          documentType: 'drivers_license',
          documentNumber: parsed.documentNumber,
          issuingCountry: parsed.issuingCountry,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          dateOfBirth: parsed.dob ? parsed.dob : null
        });
        saleVerificationStore.addSessionLog(requestedSaleId, `Banned list check finished (banned: ${!!bannedRecord})`, 'info');

        if (bannedRecord) {
          approved = false;
          reason = bannedRecord.notes || 'BANNED_CUSTOMER';
          logger.logSecurity('banned_customer_attempt_bluetooth', {
            saleId: effectiveSaleId,
            documentNumber: parsed.documentNumber,
            bannedId: bannedRecord.id
          });
        }
      } catch (e) {
        logger.error('Banned check failed', e);
      }
    }

    // 4. Prepare verification result
    const verificationResult = {
      approved,
      customerId: parsed.documentNumber,
      customerName: `${parsed.firstName || ''} ${parsed.lastName || ''}`.trim() || 'Customer',
      age: parsed.age,
      reason,
      registerId: registerId || 'BLUETOOTH-SCANNER',
      saleId: effectiveSaleId
    };

    // 4.25 "Seen before" signal (helps when customer isn't in rewards).
    let seenBefore = false;
    let priorVerificationCount = null;
    let lastSeenAt = null;
    if (db.pool && parsed.documentNumber && !String(parsed.documentNumber).startsWith('RAW-')) {
      try {
        const docType = 'drivers_license';
        const issuing = parsed.issuingCountry || 'USA';
        const { rows } = await db.pool.query(
          `
            SELECT
              COUNT(*)::int as count,
              MAX(created_at) as last_seen_at
            FROM verifications
            WHERE document_type = $1
              AND document_number = $2
              AND issuing_country = $3
          `,
          [docType, String(parsed.documentNumber), String(issuing)]
        );
        priorVerificationCount = rows?.[0]?.count ?? null;
        lastSeenAt = rows?.[0]?.last_seen_at ?? null;
        seenBefore = Number(priorVerificationCount || 0) > 0;
        saleVerificationStore.addSessionLog(
          requestedSaleId,
          seenBefore ? `Seen before (${priorVerificationCount})` : 'First-time ID (no prior verifications)',
          'info'
        );
      } catch (e) {
        logger.warn({ event: 'seen_before_query_failed', saleId: effectiveSaleId }, 'Seen-before lookup failed');
      }
    }

    // Sale notes are intentionally disabled (compliance is tracked via DB + manager audit endpoints instead).
    const noteUpdated = false;

    // 4.6 Optionally update the Lightspeed customer profile (when a customer was selected via phone/loyalty)
    let customerUpdated = false;
    let customerUpdatedFields = [];
    let customerUpdateSkipped = null;
    let customerUpdateStatus = null;
    let customerUpdatesPayload = null;
    let customerFillQueued = false;
    if (approved && sale?.customerId && typeof lightspeed.updateCustomerById === 'function') {
      try {
        saleVerificationStore.addSessionLog(requestedSaleId, `Updating customer profile (${sale.customerId})...`, 'info');

        const updates = buildCustomerUpdatePayload(parsed);
        customerUpdatesPayload = updates;

        try {
          const queued = customerFillQueue.enqueueCustomerFill({ saleId: effectiveSaleId, fields: updates });
          customerFillQueued = Boolean(queued?.queued);
          saleVerificationStore.addSessionLog(
            requestedSaleId,
            customerFillQueued ? 'LOADER: Started customer profile fill (in-memory)' : `LOADER: Not queued (${queued?.reason || 'unknown'})`,
            customerFillQueued ? 'info' : 'warn'
          );
        } catch { }

        const result = await lightspeed.updateCustomerById(sale.customerId, updates, { fillBlanksOnly: true });
        customerUpdated = Boolean(result?.updated);
        customerUpdatedFields = Array.isArray(result?.fields) ? result.fields : [];
        customerUpdateSkipped = result?.skipped || null;
        customerUpdateStatus = result?.status || null;
        saleVerificationStore.addSessionLog(
          requestedSaleId,
          customerUpdated ? `Customer updated (${customerUpdatedFields.length} fields)` : `Customer update skipped (${customerUpdateSkipped || 'no_changes'})`,
          customerUpdated ? 'info' : 'warn'
        );
      } catch (e) {
        customerUpdateSkipped = e?.message || 'update_failed';
        saleVerificationStore.addSessionLog(requestedSaleId, `Customer update failed: ${customerUpdateSkipped}`, 'warn');
        logger.warn({ event: 'customer_update_failed_from_scan', saleId: effectiveSaleId, customerId: sale.customerId }, 'Failed to update customer from scan');
      }
    } else if (approved && !sale?.customerId) {
      customerUpdateSkipped = 'no_customer_on_sale';
      try {
        customerUpdatesPayload = buildCustomerUpdatePayload(parsed);
      } catch (e) {
        customerUpdatesPayload = null;
      }

      if (customerUpdatesPayload) {
        try {
          const queued = customerFillQueue.enqueueCustomerFill({ saleId: effectiveSaleId, fields: customerUpdatesPayload });
          customerFillQueued = Boolean(queued?.queued);
          saleVerificationStore.addSessionLog(
            requestedSaleId,
            customerFillQueued ? 'LOADER: Waiting for loyalty customer attach (in-memory)' : `LOADER: Not queued (${queued?.reason || 'unknown'})`,
            customerFillQueued ? 'info' : 'warn'
          );
        } catch { }
      }
    }

    // 5. Persist to Database FIRST (Dashboard Integration - CRITICAL)
    // Database save must succeed before in-memory update to ensure data integrity
    const verificationId = `V-${effectiveSaleId || 'SCAN'}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let dbSaved = false;
    if (db.pool) {
      try {
        saleVerificationStore.addSessionLog(requestedSaleId, 'Saving to compliance database...', 'info');
        // Construct verification object for DB
        const safeIso = (d) => (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString() : null;

        const dbVerification = {
          verificationId,
          saleId: effectiveSaleId,
          clerkId: clerkId || 'BLUETOOTH_DEVICE',
          status: approved ? 'approved' : 'rejected',
          reason,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          dob: safeIso(parsed.dob),
          age: parsed.age,
          documentType: 'drivers_license',
          documentNumber: parsed.documentNumber,
          issuingCountry: parsed.issuingCountry,
          nationality: parsed.issuingCountry,
          sex: parsed.sex,
          source: 'bluetooth_gun'
        };

        await complianceStore.saveVerification(dbVerification, {
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          locationId
        });
        dbSaved = true;
        saleVerificationStore.addSessionLog(requestedSaleId, 'Compliance database OK', 'info');
      } catch (dbError) {
        saleVerificationStore.addSessionLog(requestedSaleId, `DB save failed: ${dbError.message}`, 'warn');
        logger.error({ event: 'bluetooth_db_save_failed', saleId: effectiveSaleId }, 'Failed to save bluetooth verification to DB');
      }
    }

    // 6. Update In-Memory Store (for Polling) - ONLY after DB save succeeds
    saleVerificationStore.updateVerification(requestedSaleId, verificationResult);
    if (effectiveSaleId && effectiveSaleId !== requestedSaleId) {
      try {
        saleVerificationStore.updateVerification(effectiveSaleId, { ...verificationResult, saleId: effectiveSaleId });
        saleVerificationStore.addSessionLog(requestedSaleId, `Mirrored verification under Retail sale id: ${effectiveSaleId}`, 'info');
      } catch (e) {
        // Best-effort only; never block checkout
      }
    }

    // 6.5 Queue a customer reconcile job so fields get filled even if loyalty customer attaches a few seconds later.
    let customerReconcileQueued = false;
    let customerReconcileReason = null;
    try {
      const canReconcile = approved && Boolean(db.pool) && typeof lightspeed.updateCustomerById === 'function' && customerUpdatesPayload;
      const missingCustomer = canReconcile && (!sale || !sale.customerId);
      const transientUpdateFailure =
        canReconcile &&
        Boolean(sale?.customerId) &&
        !customerUpdated &&
        !customerUpdateSkipped &&
        [429, 500, 502, 503, 504].includes(Number(customerUpdateStatus || 0));

      if (missingCustomer || transientUpdateFailure) {
        const queued = await customerReconcileQueue.enqueueJob({
          saleId: effectiveSaleId,
          verificationId,
          fields: customerUpdatesPayload,
          delayMs: 5000
        });
        customerReconcileQueued = Boolean(queued?.queued);
        customerReconcileReason = missingCustomer ? 'no_customer_on_sale' : 'transient_customer_update_failure';
        saleVerificationStore.addSessionLog(
          requestedSaleId,
          customerReconcileQueued ? 'Queued customer reconcile job' : `Customer reconcile not queued (${queued?.reason || 'unknown'})`,
          customerReconcileQueued ? 'info' : 'warn'
        );
      }
    } catch (e) {
      logger.warn({ event: 'customer_reconcile_enqueue_failed', saleId: effectiveSaleId, error: e.message }, 'Failed to enqueue customer reconcile job');
    }

    // Final success logging
    console.log('===========================================');
    console.log('✅ SCAN PROCESSED SUCCESSFULLY');
    console.log('Approved:', approved);
    console.log('Customer:', verificationResult.customerName);
    console.log('Age:', parsed.age);
    console.log('Reason:', reason || 'N/A');
    console.log('===========================================\n');

    res.json({
      success: true,
      approved,
      verificationId,
      requestedSaleId,
      saleId: effectiveSaleId,
      resolvedSaleId: resolvedSaleId && resolvedSaleId !== requestedSaleId ? resolvedSaleId : null,
      customerName: verificationResult.customerName,
      age: parsed.age,
      dob: parsed.dob && !isNaN(parsed.dob.getTime()) ? parsed.dob.toISOString().slice(0, 10) : null,
      reason,
      dbSaved,
      noteUpdated,
      saleFetchOk: Boolean(sale && sale.saleId),
      saleFetchAttempts,
      saleFetchError,
      saleCustomerId: sale?.customerId || null,
      seenBefore,
      priorVerificationCount,
      lastSeenAt,
      customerUpdated,
      customerUpdatedFields,
      customerUpdateSkipped,
      customerUpdateStatus,
      customerFillQueued,
      customerReconcileQueued,
      customerReconcileReason
    });

  } catch (error) {
    saleVerificationStore.addSessionLog(requestedSaleId, `FATAL BACKEND ERROR: ${error.message}`, 'error');
    console.error('===========================================');
    console.error('❌ ERROR PROCESSING BLUETOOTH SCAN');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('===========================================\n');
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: error.message,
      technical: error.message,
      details: 'Internal error during scan parsing or persistence.'
    });
  }
});

router.post('/sales/:saleId/verify', validateVerification, async (req, res) => {
  const { clerkId, scan } = req.body || {};
  const { saleId } = req.params;

  if (!clerkId) {
    logger.logSecurity('missing_clerk_id', { saleId });
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'clerkId is required.'
    });
  }

  if (!scan || typeof scan.approved !== 'boolean') {
    logger.logSecurity('invalid_scan_data', { saleId, clerkId });
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'scan.approved boolean flag is required.'
    });
  }

  if (scan.documentNumber && typeof scan.documentNumber === 'string') {
    scan.documentNumber = scan.documentNumber.trim();
    if (!scan.documentNumber.length) {
      scan.documentNumber = null;
    }
  }

  let normalizedScan = normalizeScanInput({
    ...scan,
    documentType: scan?.documentType || 'drivers_license'
  });
  let sale = null;
  try {
    sale = await lightspeed.getSaleById(saleId);
    if (!sale) {
      logger.warn({ event: 'sale_not_found', saleId }, `Sale ${saleId} not found`);
      return res.status(404).json({
        error: 'SALE_NOT_FOUND',
        message: 'Sale not found.'
      });
    }
  } catch (saleError) {
    logger.logAPIError('get_sale_for_verification', saleError, { saleId, clerkId });
    const status = saleError.status === 404 ? 404 : 502;
    return res.status(status).json({
      error: status === 404 ? 'SALE_NOT_FOUND' : 'SALE_LOOKUP_FAILED',
      message: status === 404 ? 'Sale not found.' : 'Unable to retrieve sale from Lightspeed.'
    });
  }

  const locationId = determineLocationId(req, sale);
  const outletDescriptor = getOutletDescriptor(locationId, sale?.outlet);

  let bannedRecord = null;

  if (db.pool && (normalizedScan.documentNumber || (normalizedScan.firstName && normalizedScan.lastName && normalizedScan.dob))) {
    try {
      bannedRecord = await complianceStore.findBannedCustomer({
        documentType: normalizedScan.documentType,
        documentNumber: normalizedScan.documentNumber,
        issuingCountry: normalizedScan.issuingCountry || null,
        firstName: normalizedScan.firstName || null,
        lastName: normalizedScan.lastName || null,
        dateOfBirth: normalizedScan.dob || null
      });

      if (bannedRecord) {
        normalizedScan.approved = false;
        normalizedScan.reason = sanitizeString(bannedRecord.notes) || 'BANNED_CUSTOMER';
        logger.logSecurity('banned_customer_attempt', {
          saleId,
          clerkId,
          documentType: normalizedScan.documentType,
          documentNumber: normalizedScan.documentNumber,
          issuingCountry: normalizedScan.issuingCountry || null,
          locationId,
          outletCode: outletDescriptor?.code || null,
          bannedId: bannedRecord.id
        });
      }
    } catch (banError) {
      logger.logAPIError('find_banned_customer', banError, {
        saleId,
        clerkId,
        documentType: normalizedScan.documentType,
        documentNumber: normalizedScan.documentNumber
      });
    }
  }

  try {
    const startTime = Date.now();

    const verification = await lightspeed.recordVerification({
      saleId,
      clerkId,
      verificationData: normalizedScan,
      sale,
      locationId
    });

    logger.logVerification(saleId, clerkId, normalizedScan.approved, normalizedScan.age, {
      documentType: normalizedScan.documentType,
      issuingCountry: normalizedScan.issuingCountry,
      source: normalizedScan.source,
      locationId,
      outletCode: outletDescriptor?.code || null,
      registerId: sale?.registerId || null
    });
    logger.logPerformance('recordVerification', Date.now() - startTime, true);

    let persisted = null;

    if (db.pool) {
      const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const userAgent = req.get('user-agent');

      try {
        persisted = await complianceStore.saveVerification(verification, {
          ipAddress,
          userAgent,
          locationId
        });
      } catch (dbError) {
        logger.logAPIError('persist_verification', dbError, { saleId, clerkId });
      }
    }

    const responsePayload = {
      ...verification,
      complianceRecordId: persisted?.id || null,
      banned: Boolean(bannedRecord),
      bannedReason: bannedRecord?.notes ? sanitizeString(bannedRecord.notes) : null,
      locationId: locationId || null,
      outlet: outletDescriptor,
      registerId: sale?.registerId || null
    };

    res.status(201).json({
      data: responsePayload
    });
  } catch (error) {
    logger.logAPIError('recordVerification', error, { saleId, clerkId });
    const status = error.message === 'SALE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({
      error: error.message,
      message: status === 404 ? 'Sale not found.' : 'Unable to record verification.'
    });
  }
});

router.post('/sales/:saleId/complete', validateCompletion, async (req, res) => {
  const { verificationId, paymentType } = req.body || {};
  const { saleId } = req.params;

  if (!verificationId) {
    logger.logSecurity('missing_verification_id', { saleId });
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'verificationId is required.'
    });
  }

  if (!paymentType || !['cash', 'card'].includes(paymentType)) {
    logger.logSecurity('invalid_payment_type', { saleId, paymentType });
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'paymentType is required and must be either "cash" or "card".'
    });
  }

  try {
    const startTime = Date.now();

    const shouldWriteLightspeed = Boolean(config.lightspeed?.enableWrites);
    const requestAmount = Number.parseFloat(req.body?.saleTotal ?? req.body?.amount ?? req.body?.paymentAmount);

    let sale = null;
    try {
      sale = await lightspeed.getSaleById(saleId);
      if (!sale) {
        throw new Error('SALE_NOT_FOUND');
      }
    } catch (saleLookupError) {
      logger.logAPIError('getSaleForCompletion', saleLookupError, { saleId, paymentType, shouldWriteLightspeed });
      if (shouldWriteLightspeed) {
        return res.status(502).json({
          error: 'SALE_LOOKUP_FAILED',
          message: 'Unable to retrieve sale from Lightspeed.'
        });
      }
    }

    const locationId = determineLocationId(req, sale);
    const outletDescriptor = getOutletDescriptor(locationId, sale?.outlet);

    const latestVerification = await resolveLatestVerification(saleId, sale?.verification);

    if (!latestVerification || latestVerification.verificationId !== verificationId) {
      logger.logSecurity('verification_mismatch', {
        saleId,
        verificationId,
        actualId: latestVerification?.verificationId
      });
      return res.status(409).json({
        error: 'VERIFICATION_MISMATCH',
        message: 'Verification ID does not match the latest verification for this sale.'
      });
    }

    if (isVerificationExpired(latestVerification)) {
      logger.warn({ event: 'verification_expired', saleId, verificationId }, `Verification expired for sale ${saleId}`);
      return res.status(409).json({
        error: 'VERIFICATION_EXPIRED',
        message: 'Verification expired. Please rescan the ID.'
      });
    }

    if (!['approved', 'approved_override'].includes(latestVerification.status)) {
      logger.logSecurity('verification_not_approved', {
        saleId,
        verificationId,
        status: latestVerification.status
      });
      return res.status(409).json({
        error: 'VERIFICATION_NOT_APPROVED',
        message: 'Latest verification is not approved.'
      });
    }

    const amountToRecord =
      Number.isFinite(requestAmount)
        ? requestAmount
        : (Number.isFinite(sale?.total) ? sale.total : 0);

    let completion = null;
    if (!shouldWriteLightspeed) {
      completion = {
        saleId,
        completedAt: new Date().toISOString(),
        paymentType,
        amount: Number.isFinite(amountToRecord) ? Math.round(amountToRecord * 100) / 100 : 0,
        verificationId,
        skippedLightspeed: true
      };
      logger.info({ event: 'sale_complete_skipped_lightspeed', saleId, paymentType }, 'Skipping Lightspeed completion (writes disabled)');
    } else {
      completion = await lightspeed.completeSale({
        saleId,
        verificationId,
        paymentType,
        sale,
        locationId
      });
    }

    if (db.pool) {
      try {
        await complianceStore.recordSaleCompletion({
          saleId,
          verificationId,
          paymentType,
          amount: completion?.amount ?? sale?.total ?? amountToRecord ?? 0
        });
      } catch (dbError) {
        logger.logAPIError('persist_sale_completion', dbError, { saleId, verificationId });
      }
    }

    logger.logSaleComplete(saleId, paymentType, completion?.amount ?? sale?.total ?? amountToRecord ?? 0);
    logger.logPerformance('completeSale', Date.now() - startTime, true);

    res.status(200).json({
      data: {
        ...(completion || {}),
        locationId: locationId || null,
        outlet: outletDescriptor,
        registerId: sale?.registerId || null
      }
    });
  } catch (error) {
    logger.logAPIError('completeSale', error, { saleId, verificationId, paymentType });
    let status = 500;
    if (error.message === 'SALE_NOT_FOUND') {
      status = 404;
    }
    if (error.message === 'VERIFICATION_NOT_APPROVED' || error.message === 'VERIFICATION_NOT_FOUND') {
      status = 409;
    }
    if (error.message === 'SALE_ALREADY_COMPLETED') {
      status = 409;
    }

    res.status(status).json({
      error: error.message,
      message: 'Unable to complete sale.'
    });
  }
});

router.get('/reports/compliance', async (req, res, next) => {
  if (!db.pool) {
    return res.status(200).json({
      success: false,
      dbAvailable: false,
      data: []
    });
  }

  const days = parseInt(req.query.days || '30', 10);
  const limit = parseInt(req.query.limit || '50', 10);

  try {
    const report = await complianceStore.summarizeCompliance({
      days: Number.isNaN(days) ? 30 : days,
      limit: Number.isNaN(limit) ? 50 : limit
    });

    res.json({ data: report });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/overrides', async (req, res) => {
  if (!db.pool) {
    return res.status(200).json({
      success: false,
      dbAvailable: false,
      data: []
    });
  }

  const rawDays = parseInt(req.query.days || '30', 10);
  const rawLimit = parseInt(req.query.limit || '200', 10);
  const days = Number.isNaN(rawDays) ? 30 : Math.max(1, Math.min(rawDays, 3650));
  const limit = Number.isNaN(rawLimit) ? 200 : Math.max(1, Math.min(rawLimit, 1000));

  try {
    const overrides = await complianceStore.listRecentOverrides({ days, limit });
    res.json({ data: overrides });
  } catch (error) {
    next(error);
  }
});

const emailService = require('./emailService');

router.post('/sales/:saleId/override', validateOverride, async (req, res) => {
  const { saleId } = req.params;
  const { verificationId, managerPin, note, clerkId, registerId } = req.body;

  // 1. Validate PIN (Simple check for now, can be DB backed later)
  // Hardcoded for demo/pilot. In production, check against a manager table.
  const VALID_PINS = [process.env.OVERRIDE_PIN || '1417', '9999'];

  if (!VALID_PINS.includes(managerPin)) {
    logger.logSecurity('invalid_override_pin', { saleId, verificationId });
    return res.status(401).json({
      success: false,
      error: 'INVALID_PIN',
      message: 'Invalid Manager PIN.'
    });
  }

  try {
    // 2. Record Override (only if database is available)
    let result = null;
    if (db.pool) {
      result = await complianceStore.markVerificationOverride({
        verificationId,
        saleId,
        managerId: 'Manager-' + managerPin.slice(-2),
        note,
        clerkId,
        registerId
      });
    } else {
      logger.info({ event: 'override_no_db', saleId }, 'Override processed without database');
      result = { verification: null, override: { saleId, note: 'No database mode' } };
    }

    // 3. Update In-Memory Store (so polling picks it up) - ALWAYS do this
    saleVerificationStore.updateVerification(saleId, {
      approved: true,
      reason: 'Manual ID Override: ' + (note || 'No reason provided'),
      status: 'approved_override'
    });

    // 4. Abuse Detection (only if database is available)
    if (db.pool) {
      const verification = await complianceStore.getLatestVerificationForSale(saleId);
      const locationId = verification?.location_id;

      const recentCount = await complianceStore.countRecentOverrides({
        locationId,
        minutes: 10
      });

      const ABUSE_THRESHOLD = 3;

      if (recentCount >= ABUSE_THRESHOLD) {
        logger.warn({ event: 'override_abuse_detected', count: recentCount, locationId }, 'Override abuse threshold exceeded');

        const alertHtml = `
          <h2>⚠️ High Override Volume Detected</h2>
          <p><strong>Location:</strong> ${locationId || 'Unknown'}</p>
          <p><strong>Count:</strong> ${recentCount} overrides in the last 10 minutes.</p>
          <p><strong>Latest Override:</strong></p>
          <ul>
            <li><strong>Sale ID:</strong> ${saleId}</li>
            <li><strong>Manager PIN Used:</strong> ****${managerPin.slice(-2)}</li>
            <li><strong>Note:</strong> ${note || 'None'}</li>
            <li><strong>Time:</strong> ${new Date().toLocaleString()}</li>
          </ul>
          <p>Please investigate immediately.</p>
        `;

        emailService.sendAlertEmail('High Override Volume Detected', alertHtml);
      }
    }

    // 5. Write an audit note back to Lightspeed (best-effort)
    try {
      await lightspeed.recordVerification({
        saleId,
        clerkId: clerkId || 'MANAGER_OVERRIDE',
        verificationData: {
          approved: true,
          reason: note ? `MANUAL_OVERRIDE: ${note}` : 'MANUAL_OVERRIDE',
          firstName: null,
          lastName: null,
          dob: null,
          age: null,
          documentType: 'manual',
          documentNumber: 'no-scan',
          issuingCountry: null,
          nationality: null,
          sex: null,
          source: 'manual_override',
          documentExpiry: null
        }
      });
    } catch (noteError) {
      logger.warn({ event: 'override_note_update_failed', saleId, error: noteError.message }, 'Failed to update Lightspeed note for override');
    }

    res.json({
      success: true,
      message: 'Override successful',
      data: result
    });

  } catch (error) {
    logger.error('Override failed', { error: error.message, stack: error.stack });

    const isDbError = error.message && (error.message.includes('DATABASE_URL') || error.message.includes('pool'));

    res.status(500).json({
      success: false,
      error: isDbError ? 'DATABASE_NOT_CONFIGURED' : 'OVERRIDE_FAILED',
      message: isDbError
        ? 'Database not configured. Contact administrator.'
        : `Override failed: ${error.message}`,
      debug: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
});

router.post('/banned', validateBannedCreate, async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      success: false,
      dbAvailable: false,
      error: 'DATABASE_NOT_CONFIGURED',
      message: 'Database not configured. Unable to persist banned customers.',
      data: null
    });
  }

  const makePlaceholderBannedDocNumber = () =>
    `BANNED-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  const payload = {
    documentType: normalizeDocumentType(req.body.documentType),
    documentNumber: normalizeDocumentNumber(req.body.documentNumber),
    issuingCountry: normalizeCountry(req.body.issuingCountry),
    bannedLocationId: req.body.bannedLocationId ? sanitizeString(req.body.bannedLocationId) : null,
    dateOfBirth: normalizeDateInput(req.body.dateOfBirth) || null,
    firstName: req.body.firstName ? sanitizeString(req.body.firstName).trim() : null,
    lastName: req.body.lastName ? sanitizeString(req.body.lastName).trim() : null,
    phone: normalizePhone(req.body.phone),
    email: normalizeEmail(req.body.email),
    notes: req.body.notes ? sanitizeString(req.body.notes) : null
  };

  // If the UI bans by name+DOB (no DL#), store a placeholder docNumber so the DB constraint is satisfied.
  if (!payload.documentNumber) {
    payload.documentType = 'name_dob';
    payload.documentNumber = makePlaceholderBannedDocNumber();
    payload.issuingCountry = null;
  }

  try {
    const record = await complianceStore.addBannedCustomer(payload);
    res.status(201).json({ data: record });
  } catch (error) {
    logger.logAPIError('add_banned_customer', error, { payload });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to save banned customer.'
    });
  }
});

router.get('/banned', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      success: false,
      dbAvailable: false,
      error: 'DATABASE_NOT_CONFIGURED',
      count: 0,
      data: []
    });
  }

  try {
    const q = req.query?.q ? sanitizeString(req.query.q) : null;
    const limit = req.query?.limit ? req.query.limit : undefined;
    const offset = req.query?.offset ? req.query.offset : undefined;

    const banned = await complianceStore.listBannedCustomers({
      query: q,
      limit,
      offset
    });

    res.status(200).json({
      success: true,
      count: banned.length,
      data: banned
    });
  } catch (error) {
    logger.logAPIError('list_banned_customers', error, {
      q: req.query?.q || null
    });

    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to load banned customers.'
    });
  }
});

router.get('/locations', async (req, res) => {
  const outlets = Object.values(config?.lightspeed?.outlets || {});
  const data = outlets
    .slice()
    .sort((a, b) => String(a?.label || '').localeCompare(String(b?.label || '')))
    .map((o) => ({
      id: o.id,
      code: o.code,
      slug: o.slug || String(o.code || '').toLowerCase(),
      label: o.label
    }));

  res.status(200).json({ success: true, count: data.length, data });
});

router.delete('/banned/:id', validateBannedId, async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      success: false,
      dbAvailable: false,
      error: 'DATABASE_NOT_CONFIGURED',
      message: 'Database not configured. Unable to remove banned customers.'
    });
  }

  try {
    const removed = await complianceStore.removeBannedCustomer(req.params.id);
    if (!removed) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Banned customer not found.'
      });
    }

    res.status(204).send();
  } catch (error) {
    logger.logAPIError('remove_banned_customer', error, { id: req.params.id });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to remove banned customer.'
    });
  }
});
router.get('/sales/:saleId/overrides', validateSaleId, async (req, res) => {
  if (!db.pool) {
    return res.status(200).json({
      success: false,
      dbAvailable: false,
      data: []
    });
  }

  try {
    const overrides = await complianceStore.listOverridesForSale(req.params.saleId);
    res.json({ data: overrides });
  } catch (error) {
    logger.logAPIError('list_overrides', error, { saleId: req.params.saleId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to fetch overrides for this sale.'
    });
  }
});




// Lightspeed Custom Button Webhook - Called when clerk clicks CASH/CARD button
router.post('/lightspeed/payment-action', async (req, res) => {
  const { saleId, outletId, registerId, employeeId, paymentType } = req.body;

  logger.info({
    event: 'custom_button_clicked',
    saleId,
    outletId,
    paymentType
  }, 'Payment button clicked in Lightspeed POS');

  if (!saleId) {
    return res.status(400).json({
      error: 'MISSING_SALE_ID',
      message: 'saleId is required'
    });
  }

  try {
    // Check if already verified in database
    if (db.pool) {
      const verification = await complianceStore.getLatestVerificationForSale(saleId);

      if (verification && !isVerificationExpired({ createdAt: verification.verified_at, status: verification.verification_status })) {
        if (verification.verification_status === 'approved' || verification.verification_status === 'approved_override') {
          logger.info({ event: 'already_verified', saleId }, 'Sale already verified - allowing payment');

          return res.json({
            action: 'proceed',
            approved: true,
            verificationId: verification.verification_id
          });
        }
      }
    }

    // Need verification
    logger.info({ event: 'verification_required', saleId }, 'ID scan required');

    res.json({
      action: 'require_scan',
      approved: false,
      message: 'ID verification required before payment'
    });

  } catch (error) {
    logger.logAPIError('payment_action', error, { saleId });

    res.json({
      action: 'require_scan',
      approved: false,
      message: 'ID verification required'
    });
  }
});

// Dynamix Webhook - Receives scanned ID data
router.post('/dynamix/webhook', async (req, res) => {
  const { saleId, scan, clerkId } = req.body || {};

  logger.info({ event: 'dynamix_webhook_received', saleId }, 'Received scan from Dynamix');

  if (!saleId || !scan) {
    return res.status(400).json({
      error: 'INVALID_WEBHOOK',
      message: 'saleId and scan data required'
    });
  }

  try {
    // Auto-verify using the scan data
    const normalizedScan = normalizeScanInput(scan);

    const verification = await lightspeed.recordVerification({
      saleId,
      clerkId: clerkId || 'dynamix-auto',
      verificationData: normalizedScan,
      sale: await lightspeed.getSaleById(saleId),
      locationId: req.body.outletId || null
    });

    if (db.pool) {
      const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      await complianceStore.saveVerification(verification, {
        ipAddress,
        userAgent: 'Dynamix Photo Scanner',
        locationId: req.body.outletId || null
      });
    }

    logger.logVerification(saleId, clerkId || 'dynamix-auto', normalizedScan.approved, normalizedScan.age, {
      source: 'dynamix',
      documentType: normalizedScan.documentType
    });

    res.status(200).json({
      success: true,
      verification
    });
  } catch (error) {
    logger.logAPIError('dynamix_webhook', error, { saleId });
    res.status(500).json({
      error: 'WEBHOOK_FAILED',
      message: 'Failed to process scan'
    });
  }
});

// Fallback for iPad embedded flows where HID keystrokes never reach the iframe:
// scan the PDF417 into the Lightspeed sale note field, then call this endpoint to verify.
router.post('/sales/:saleId/verify-from-note', validateSaleId, async (req, res) => {
  const { saleId } = req.params;
  const { clerkId, registerId } = req.body || {};

  if (!process.env.LIGHTSPEED_API_KEY) {
    return res.status(503).json({
      error: 'LIGHTSPEED_UNAVAILABLE',
      message: 'Lightspeed credentials are not configured.'
    });
  }

  let sale = null;
  try {
    sale = await lightspeed.getSaleById(saleId);
    if (!sale) {
      return res.status(404).json({
        error: 'SALE_NOT_FOUND',
        message: 'Sale not found.'
      });
    }
  } catch (saleError) {
    logger.logAPIError('get_sale_for_note_verification', saleError, { saleId });
    return res.status(502).json({
      error: 'SALE_LOOKUP_FAILED',
      message: 'Unable to retrieve sale from Lightspeed.'
    });
  }

  const noteRaw = (sale.note || '').toString();
  const note = noteRaw.replace(/\\r\\n/g, '\n').replace(/\\r/g, '\n');
  const ansiIndex = note.indexOf('@ANSI');
  const aimIndex = note.indexOf(']L');
  const markerIndex =
    ansiIndex >= 0 ? ansiIndex : (aimIndex >= 0 ? aimIndex : -1);

  if (markerIndex < 0 || note.length - markerIndex < 20) {
    return res.status(409).json({
      error: 'NO_SCAN_IN_NOTE',
      message: 'No scan data found in sale note. Scan the ID into the Notes field first.'
    });
  }

  const payload = note.substring(markerIndex);

  try {
    const parsed = parseAAMVA(payload);

    if (!parsed) {
      return res.status(409).json({
        error: 'SCAN_NOT_PARSEABLE',
        message: 'Found note content but could not parse an AAMVA barcode.'
      });
    }

    let approved = false;
    let reason = null;

    if (parsed.age !== null && parsed.age !== undefined) {
      if (parsed.age >= 21) {
        approved = true;
      } else {
        approved = false;
        reason = `Underage (${parsed.age})`;
      }
    } else {
      approved = false;
      reason = 'Could not read DOB';
    }

    // Check banned list if configured.
    if (db.pool && (parsed.documentNumber || (parsed.firstName && parsed.lastName && parsed.dob))) {
      try {
        const bannedRecord = await complianceStore.findBannedCustomer({
          documentType: 'drivers_license',
          documentNumber: parsed.documentNumber,
          issuingCountry: parsed.issuingCountry,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          dateOfBirth: parsed.dob ? parsed.dob : null
        });

        if (bannedRecord) {
          approved = false;
          reason = bannedRecord.notes || 'BANNED_CUSTOMER';
          logger.logSecurity('banned_customer_attempt_note', {
            saleId,
            documentNumber: parsed.documentNumber,
            bannedId: bannedRecord.id
          });
        }
      } catch (banError) {
        logger.logAPIError('find_banned_customer_note', banError, { saleId });
      }
    }

    // Ensure a pending in-memory verification exists so polling UIs can update.
    if (!saleVerificationStore.getVerification(saleId)) {
      saleVerificationStore.createVerification(saleId, { registerId: registerId || null });
    }

    const customerName =
      `${parsed.firstName || ''} ${parsed.lastName || ''}`.trim() || 'Customer';

    const verificationResult = {
      approved,
      customerId: parsed.documentNumber || null,
      customerName,
      age: parsed.age || null,
      reason,
      registerId: registerId || sale.registerId || null
    };

    if (db.pool) {
      const locationId = determineLocationId(req, sale);
      const dbVerification = {
        verificationId: require('crypto').randomUUID(),
        saleId,
        clerkId: clerkId || 'POS_NOTE',
        status: approved ? 'approved' : 'rejected',
        reason,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        dob: parsed.dob ? parsed.dob.toISOString() : null,
        age: parsed.age,
        documentType: 'drivers_license',
        documentNumber: parsed.documentNumber,
        issuingCountry: parsed.issuingCountry,
        nationality: parsed.issuingCountry,
        sex: parsed.sex,
        source: 'pos_note'
      };

      await complianceStore.saveVerification(dbVerification, {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        locationId
      });
    }

    // Overwrite the sale note with a clean audit message (removes the raw AAMVA blob).
    try {
      await lightspeed.recordVerification({
        saleId,
        clerkId: clerkId || 'POS_NOTE',
        verificationData: {
          approved,
          firstName: parsed.firstName || null,
          lastName: parsed.lastName || null,
          age: parsed.age || null,
          dob: parsed.dob ? parsed.dob.toISOString().split('T')[0] : null,
          documentNumber: parsed.documentNumber || null,
          documentType: 'drivers_license',
          issuingCountry: parsed.issuingCountry || null,
          source: 'pos_note',
          reason
        }
      });
    } catch (noteError) {
      logger.warn({ event: 'lightspeed_note_update_failed', saleId, error: noteError.message });
    }

    saleVerificationStore.updateVerification(saleId, verificationResult);

    return res.status(200).json({
      success: true,
      approved,
      customerName,
      age: parsed.age,
      dob: parsed.dob ? parsed.dob.toISOString().slice(0, 10) : null,
      reason
    });
  } catch (error) {
    logger.logAPIError('verify_from_note', error, { saleId });
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to verify scan from sale note.'
    });
  }
});

/**
 * Cron job endpoint for scheduled maintenance (retention + BI snapshots + customer profile sync)
 * Called periodically by Vercel Cron; heavy tasks are gated to run once per local day.
 *
 * TABC requires 2-year retention (730 days)
 * This endpoint is protected by Vercel's internal cron authentication
 */
async function runRetentionCron(req, res) {
  if (!verifyCronRequest(req)) {
    logger.logSecurity('unauthorized_cron_attempt', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid cron secret'
    });
  }

  if (!db.pool) {
    logger.warn({
      event: 'retention_skipped',
      reason: 'no_database'
    }, 'Retention enforcement skipped - no database configured');
    return res.status(200).json({
      success: true,
      message: 'Retention skipped - no database configured'
    });
  }

  try {
    const timeZone = (process.env.CRON_DAILY_TIMEZONE || 'America/Chicago').trim() || 'America/Chicago';
    const dailyHour = Math.max(0, Math.min(23, Number.parseInt(process.env.CRON_DAILY_HOUR || '23', 10) || 23));
    const dailyMinute = Math.max(0, Math.min(59, Number.parseInt(process.env.CRON_DAILY_MINUTE || '30', 10) || 30));
    const daily = await shouldRunDailyMaintenance(db.pool, { timeZone, hour: dailyHour, minute: dailyMinute });

    logger.info(
      { event: 'cron_tick', timeZone, dailyHour, dailyMinute, daily },
      'Cron tick received'
    );

    let retentionResult = null;
    let retentionSkipped = null;
    let snapshotResult = null;

    if (daily.shouldRun) {
      logger.info({ event: 'retention_started', ymd: daily.ymd, timeZone }, 'Starting daily retention enforcement');
      retentionResult = await complianceStore.enforceRetention({
        verificationDays: 730 // TABC 2-year requirement
      });

      if (String(process.env.CRON_RUN_SNAPSHOTS || '').trim().toLowerCase() === 'true') {
        try {
          const snapshots = require('../../api/cron/snapshots.js');
          const mode = process.env.CRON_SNAPSHOT_MODE || 'all';
          snapshotResult = await snapshots.runSnapshotJob({ mode });
        } catch (snapshotError) {
          logger.logAPIError('cron_snapshots_from_retention', snapshotError);
        }
      }
    } else {
      retentionSkipped = daily.lastRunYmd === daily.ymd ? 'already_ran_today' : 'not_due_yet';
    }

    let customerSyncResult = null;
    if (String(process.env.CRON_RUN_CUSTOMER_SYNC || '').trim().toLowerCase() === 'true') {
      try {
        const marketingService = require('./marketingService');
        const maxDurationMs = Math.max(1000, Math.min(Number.parseInt(process.env.CRON_CUSTOMER_SYNC_MAX_DURATION_MS || '8000', 10) || 8000, 60000));
        customerSyncResult = await marketingService.syncCustomerProfiles(db.pool, { maxDurationMs });
      } catch (customerError) {
        logger.logAPIError('cron_customer_sync_from_retention', customerError);
      }
    }

    // Cleanup short-lived customer reconcile jobs (keeps PII from lingering unnecessarily).
    let customerReconcileCleanup = null;
    try {
      const doneDays = Number.parseInt(process.env.CUSTOMER_RECONCILE_DONE_RETENTION_DAYS || '3', 10) || 3;
      const pendingDays = Number.parseInt(process.env.CUSTOMER_RECONCILE_PENDING_RETENTION_DAYS || '2', 10) || 2;
      customerReconcileCleanup = await customerReconcileQueue.cleanup({ doneDays, pendingDays });
    } catch (cleanupError) {
      logger.logAPIError('customer_reconcile_cleanup', cleanupError);
    }

    res.status(200).json({
      success: true,
      daily: {
        shouldRun: daily.shouldRun,
        ymd: daily.ymd,
        timeZone,
        localHour: daily.localHour,
        localMinute: daily.localMinute,
        lastRunYmd: daily.lastRunYmd || null
      },
      retention: retentionResult,
      retentionSkipped,
      customerSync: customerSyncResult,
      snapshots: snapshotResult,
      customerReconcileCleanup
    });
  } catch (error) {
    logger.logAPIError('retention_enforcement', error);
    res.status(500).json({
      error: 'RETENTION_FAILED',
      message: 'Failed to enforce data retention'
    });
  }
}

router.get('/cron/retention', runRetentionCron);
router.post('/cron/retention', runRetentionCron);

function verifyCronRequest(req) {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'production') {
    return true;
  }

  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const authHeader = String(req.headers.authorization || '').trim();
  const headerSecret = String(req.headers['x-cron-secret'] || '').trim();
  const querySecret = String((req.query?.cron_secret || req.query?.cronSecret || req.query?.secret || '')).trim();

  const vercelCronHeader = req.headers['x-vercel-cron'];
  const isVercelCron = Boolean(vercelCronHeader) && String(vercelCronHeader) !== '0' && String(vercelCronHeader).toLowerCase() !== 'false';

  if (cronSecret) {
    if (authHeader === `Bearer ${cronSecret}`) return true;
    if (headerSecret && headerSecret === cronSecret) return true;
    if (querySecret && querySecret === cronSecret) return true;
  }

  // Vercel Cron requests include `x-vercel-cron: 1` (cannot set custom headers), so we accept that.
  // This header can be spoofed by external callers; for manual triggering, prefer Authorization: Bearer CRON_SECRET.
  return isVercelCron;
}

function timePartsInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);

    const map = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }

    return {
      ymd: `${map.year}-${map.month}-${map.day}`,
      hour: Number.parseInt(map.hour, 10),
      minute: Number.parseInt(map.minute, 10)
    };
  } catch {
    const iso = date.toISOString();
    return { ymd: iso.slice(0, 10), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}

async function ensureCronStateTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function getCronState(pool, key) {
  const { rows } = await pool.query('SELECT value FROM cron_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setCronState(pool, key, value) {
  await pool.query(
    `
      INSERT INTO cron_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, value === null || value === undefined ? null : String(value)]
  );
}

async function shouldRunDailyMaintenance(pool, { timeZone, hour, minute }) {
  await ensureCronStateTable(pool);
  const now = new Date();
  const parts = timePartsInZone(now, timeZone);
  const key = `daily_maintenance_last_run_${timeZone}`;
  const lastRunYmd = await getCronState(pool, key);

  const reached = (Number.isFinite(parts.hour) && Number.isFinite(parts.minute))
    ? (parts.hour > hour || (parts.hour === hour && parts.minute >= minute))
    : false;

  if (!reached) {
    return { shouldRun: false, ymd: parts.ymd, localHour: parts.hour, localMinute: parts.minute, lastRunYmd };
  }

  if (lastRunYmd === parts.ymd) {
    return { shouldRun: false, ymd: parts.ymd, localHour: parts.hour, localMinute: parts.minute, lastRunYmd };
  }

  await setCronState(pool, key, parts.ymd);
  return { shouldRun: true, ymd: parts.ymd, localHour: parts.hour, localMinute: parts.minute, lastRunYmd };
}

async function runSnapshotsCron(req, res) {
  if (!verifyCronRequest(req)) {
    logger.logSecurity('unauthorized_cron_attempt', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid cron secret'
    });
  }

  try {
    const snapshots = require('../../api/cron/snapshots.js');
    const mode = req.params?.mode || req.query?.mode || req.body?.mode || 'all';
    const date = req.query?.date || req.body?.date || null;
    const results = await snapshots.runSnapshotJob({ mode, date });
    return res.status(200).json({ success: true, mode, ...results });
  } catch (error) {
    logger.logAPIError('cron_snapshots', error, { mode: req.query?.mode || null });
    return res.status(500).json({
      error: 'SNAPSHOT_FAILED',
      message: error.message
    });
  }
}

router.get('/cron/snapshots', runSnapshotsCron);
router.post('/cron/snapshots', runSnapshotsCron);
router.get('/cron/snapshots/:mode', runSnapshotsCron);
router.post('/cron/snapshots/:mode', runSnapshotsCron);

async function runCustomerProfilesCron(req, res) {
  if (!verifyCronRequest(req)) {
    logger.logSecurity('unauthorized_cron_attempt', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid cron secret'
    });
  }

  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  try {
    const marketingService = require('./marketingService');
    const resetCursor = ['1', 'true', 'yes', 'on'].includes(String(req.query?.reset || req.body?.reset || '').toLowerCase());
    const pageSize = Math.max(1, Math.min(Number.parseInt(req.query?.pageSize || req.body?.pageSize || '200', 10) || 200, 200));
    const maxPages = Math.max(1, Math.min(Number.parseInt(req.query?.maxPages || req.body?.maxPages || '50', 10) || 50, 500));
    const maxDurationMs = Math.max(1000, Math.min(Number.parseInt(req.query?.maxDurationMs || req.body?.maxDurationMs || '8000', 10) || 8000, 60000));

    const result = await marketingService.syncCustomerProfiles(db.pool, { resetCursor, pageSize, maxPages, maxDurationMs });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.logAPIError('cron_customers', error);
    return res.status(500).json({
      error: 'CUSTOMER_SYNC_FAILED',
      message: error.message
    });
  }
}

router.get('/cron/customers', runCustomerProfilesCron);
router.post('/cron/customers', runCustomerProfilesCron);

async function runWebhooksCron(req, res) {
  if (!verifyCronRequest(req)) {
    logger.logSecurity('unauthorized_cron_attempt', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid cron secret'
    });
  }

  try {
    const limit = Math.max(1, Math.min(Number.parseInt(req.query?.limit || req.body?.limit || '100', 10) || 100, 500));
    const maxDurationMs = Math.max(
      1000,
      Math.min(Number.parseInt(req.query?.maxDurationMs || req.body?.maxDurationMs || '8000', 10) || 8000, 60000)
    );

    const result = await lightspeedWebhookQueue.processPendingWebhookEvents({ limit, maxDurationMs });
    const health = await lightspeedWebhookQueue.getWebhookQueueHealth();

    // Also run the customer reconcile queue here so webhook delivery can make customer autofill feel "instant".
    // This is best-effort and will never fail the webhook processor response.
    let customerReconcile = null;
    try {
      customerReconcile = await customerReconcileQueue.processDueJobs({
        limit: Math.max(1, Math.min(limit, 200)),
        maxDurationMs: Math.max(1000, Math.min(maxDurationMs, 8000))
      });
    } catch (e) {
      logger.warn({ event: 'cron_customer_reconcile_failed', error: e.message }, 'Customer reconcile run failed');
    }

    return res.status(200).json({ success: true, ...result, health, customerReconcile });
  } catch (error) {
    logger.logAPIError('cron_webhooks', error);
    return res.status(500).json({
      error: 'WEBHOOK_PROCESS_FAILED',
      message: error.message
    });
  }
}

router.get('/cron/webhooks', runWebhooksCron);
router.post('/cron/webhooks', runWebhooksCron);

async function runCustomerReconcileCron(req, res) {
  if (!verifyCronRequest(req)) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid cron secret'
    });
  }

  try {
    const limit = Math.max(1, Math.min(Number.parseInt(req.query?.limit || req.body?.limit || '150', 10) || 150, 500));
    const maxDurationMs = Math.max(
      1000,
      Math.min(Number.parseInt(req.query?.maxDurationMs || req.body?.maxDurationMs || '8000', 10) || 8000, 60000)
    );

    const result = await customerReconcileQueue.processDueJobs({ limit, maxDurationMs });
    const health = await customerReconcileQueue.getHealth();
    return res.status(200).json({ success: true, ...result, health });
  } catch (error) {
    logger.logAPIError('cron_customer_reconcile', error);
    return res.status(500).json({
      error: 'CUSTOMER_RECONCILE_FAILED',
      message: error.message
    });
  }
}

router.get('/cron/customer-reconcile', runCustomerReconcileCron);
router.post('/cron/customer-reconcile', runCustomerReconcileCron);

/**
 * POST /api/sales/:saleId/verify
 *
 * Submit ID verification result from scanner.html
 * Called by scanner PWA app after successful ID scan
 *
 * Request body:
 * {
 *   approved: boolean,
 *   customerId: string (optional),
 *   customerName: string (optional),
 *   age: number (optional),
 *   reason: string (optional - rejection reason),
 *   registerId: string (optional)
 * }
 */
router.post('/sales/:saleId/verify', async (req, res) => {
  const { saleId } = req.params;
  const { approved, customerId, customerName, age, reason, registerId } = req.body;

  // Validate required fields
  if (typeof approved !== 'boolean') {
    logger.warn({
      event: 'sale_verify_invalid',
      saleId,
      error: 'approved field required'
    }, 'Sale verification missing approved field');

    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'approved field is required and must be a boolean'
    });
  }

  try {
    // Update verification in store
    const verification = saleVerificationStore.updateVerification(saleId, {
      approved,
      customerId,
      customerName,
      age,
      reason,
      registerId
    });

    if (!verification) {
      logger.warn({
        event: 'sale_verify_not_found',
        saleId
      }, `Sale verification not found or expired: ${saleId}`);

      return res.status(404).json({
        error: 'VERIFICATION_NOT_FOUND',
        message: 'Sale verification not found or has expired'
      });
    }

    logger.info({
      event: 'sale_verified',
      saleId,
      approved,
      age,
      registerId
    }, `Sale ${saleId} verified: ${approved ? 'approved' : 'rejected'}`);

    res.json({
      success: true,
      saleId,
      status: verification.status
    });
  } catch (error) {
    logger.logAPIError('sale_verify', error, { saleId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to process verification'
    });
  }
});

/**
 * GET /api/sales/:saleId/status
 *
 * Get current verification status for a sale
 * Called by payment-gateway.html (polling every 2 seconds)
 *
 * Response:
 * {
 *   saleId: string,
 *   status: 'pending' | 'approved' | 'rejected',
 *   age: number (optional),
 *   reason: string (optional),
 *   customerName: string (optional)
 * }
 */
router.get('/sales/:saleId/status', async (req, res) => {
  const { saleId } = req.params;

  try {
    let verification = saleVerificationStore.getVerification(saleId);

    // If not in memory, check database as fallback (single row only) and then create a live session so logs work.
    if (!verification && db.pool) {
      try {
        const result = await db.pool.query(
          'SELECT * FROM verifications WHERE sale_id = $1 ORDER BY created_at DESC LIMIT 1',
          [saleId]
        );

        if (result.rows.length > 0) {
          const row = result.rows[0];
          verification = saleVerificationStore.createVerification(saleId);
          saleVerificationStore.updateVerification(saleId, {
            approved: String(row.status || '').startsWith('approved'),
            status: row.status,
            age: row.age,
            reason: row.reason,
            customerName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
            updatedAt: row.created_at || null
          });
          saleVerificationStore.addSessionLog(saleId, 'Loaded latest verification from DB fallback', 'info');
          verification = saleVerificationStore.getVerification(saleId);
        }
      } catch (dbError) {
        logger.error('Failed to query database for verification', dbError);
      }
    }

    if (!verification) {
      verification = saleVerificationStore.createVerification(saleId);
    }

    res.json({
      saleId: verification.saleId,
      verificationId: verification.verificationId || null,
      status: verification.status,
      age: verification.age ?? null,
      reason: verification.reason ?? null,
      customerName: verification.customerName ?? null,
      updatedAt: verification.updatedAt ? new Date(verification.updatedAt).toISOString() : null,
      updatedAtMs: verification.updatedAt ? new Date(verification.updatedAt).getTime() : null,
      remoteScannerActive: verification.remoteScannerActive,
      lastHeartbeat: verification.lastHeartbeat,
      logs: verification.logs || [],
      expiresAt: verification.expiresAt
    });
  } catch (error) {
    logger.logAPIError('sale_status', error, { saleId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get verification status'
    });
  }
});

/**
 * POST /api/sales/:saleId/complete
 *
 * Complete the verification flow and send unlock to Lightspeed
 * Called by payment-gateway.html after displaying result
 *
 * Request body:
 * {
 *   approved: boolean,
 *   paymentAmount: number (optional)
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   lightspeedResponse: object (optional)
 * }
 */
router.post('/sales/:saleId/complete', async (req, res) => {
  const { saleId } = req.params;
  const { approved, paymentAmount } = req.body;

  try {
    const verification = saleVerificationStore.getVerification(saleId);

    if (!verification) {
      logger.warn({
        event: 'sale_complete_not_found',
        saleId
      }, `Attempted to complete non-existent verification: ${saleId}`);

      return res.status(404).json({
        error: 'VERIFICATION_NOT_FOUND',
        message: 'Sale verification not found'
      });
    }

    // Send unlock/complete to Lightspeed Payments API
    let lightspeedResponse = null;

    if (lightspeedMode === 'live' && process.env.LIGHTSPEED_API_KEY) {
      try {
        // TODO: Implement actual Lightspeed Payments API call
        // This will depend on Lightspeed's custom payment integration documentation
        //
        // Example structure:
        // lightspeedResponse = await lightspeed.completePayment({
        //   saleId,
        //   approved,
        //   amount: paymentAmount,
        //   paymentMethod: 'ID_VERIFICATION'
        // });

        logger.info({
          event: 'lightspeed_complete',
          saleId,
          approved
        }, `Lightspeed payment completion called for sale ${saleId}`);
      } catch (lightspeedError) {
        logger.error({
          event: 'lightspeed_complete_error',
          saleId,
          error: lightspeedError.message
        }, `Failed to complete Lightspeed payment: ${lightspeedError.message}`);

        // Continue anyway - don't block on Lightspeed API failure
      }
    } else {
      logger.info({
        event: 'lightspeed_complete_mock',
        saleId,
        approved
      }, `Mock: Would complete Lightspeed payment for sale ${saleId}`);
    }

    // Mark verification as complete and remove from store
    saleVerificationStore.completeVerification(saleId);

    logger.info({
      event: 'sale_complete',
      saleId,
      approved,
      hasLightspeedResponse: !!lightspeedResponse
    }, `Sale ${saleId} completed successfully`);

    res.json({
      success: true,
      lightspeedResponse
    });
  } catch (error) {
    logger.logAPIError('sale_complete', error, { saleId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to complete verification'
    });
  }
});

module.exports = router;
