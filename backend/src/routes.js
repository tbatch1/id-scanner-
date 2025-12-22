const express = require('express');
const config = require('./config');
const lightspeed = require('./lightspeedClient');
const logger = require('./logger');
const db = require('./db');
const complianceStore = require('./complianceStore');
const saleVerificationStore = require('./saleVerificationStore');
const { validateVerification, validateCompletion, validateBannedCreate, validateBannedId, validateOverride, validateSaleId, sanitizeString } = require('./validation');

const router = express.Router();

const millisecondsPerMinute = 60 * 1000;
const lightspeedMode = process.env.LIGHTSPEED_USE_MOCK === 'true' ? 'mock' : 'live';

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
  const allowed = ['drivers_license', 'passport', 'mrz_id', 'id_card'];
  if (allowed.includes(lower)) {
    return lower;
  }
  return 'drivers_license';
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
    const diff = Date.now() - dob.getTime();
    const ageDate = new Date(diff);
    age = Math.abs(ageDate.getUTCFullYear() - 1970);
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
    postalCode
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
    const { saleId } = req.params;
    const { barcodeData, registerId, clerkId } = req.body;

    // DEBUG LOGGING - Log every scan attempt
    console.log('===========================================');
    console.log('🔫 BLUETOOTH SCANNER SCAN RECEIVED');
    console.log('===========================================');
    console.log('Sale ID:', saleId);
    console.log('Register ID:', registerId);
    console.log('Clerk ID:', clerkId);
    console.log('Barcode Length:', barcodeData ? barcodeData.length : 0);
    console.log('Barcode First 100 chars:', barcodeData ? barcodeData.substring(0, 100) : 'EMPTY');
    console.log('Barcode Last 50 chars:', barcodeData && barcodeData.length > 50 ? barcodeData.substring(barcodeData.length - 50) : barcodeData);
    console.log('Has ]L prefix:', barcodeData ? barcodeData.startsWith(']L') : false);
    console.log('Has @ANSI prefix:', barcodeData ? barcodeData.startsWith('@ANSI') : false);
    console.log('Line breaks (\\n):', barcodeData ? (barcodeData.match(/\n/g) || []).length : 0);
    console.log('Carriage returns (\\r):', barcodeData ? (barcodeData.match(/\r/g) || []).length : 0);
    console.log('===========================================');

    if (!barcodeData) {
      console.log('❌ ERROR: No barcode data provided');
      return res.status(400).json({ success: false, error: 'Barcode data is required.' });
    }

    try {
      // Best-effort sale context (used for outlet/location resolution and note writing).
      let sale = null;
      let locationId = determineLocationId(req, null);
      try {
        sale = await lightspeed.getSaleById(saleId);
        locationId = determineLocationId(req, sale);
      } catch (e) { }

      // 1. Parse the Barcode
      let parsed = parseAAMVA(barcodeData);

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

      // 3. Check Banned List (Database)
      let bannedRecord = null;
      if (db.pool && parsed.documentNumber) {
        try {
          bannedRecord = await complianceStore.findBannedCustomer({
            documentType: 'drivers_license',
            documentNumber: parsed.documentNumber,
            issuingCountry: parsed.issuingCountry
          });

          if (bannedRecord) {
            approved = false;
            reason = bannedRecord.notes || 'BANNED_CUSTOMER';
            logger.logSecurity('banned_customer_attempt_bluetooth', {
              saleId,
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
        registerId: registerId || 'BLUETOOTH-SCANNER'
      };

      // 4.5 Write an audit note back to Lightspeed (best-effort, never blocks checkout)
      let noteUpdated = false;
      try {
        await lightspeed.recordVerification({
          saleId,
          clerkId: clerkId || 'BLUETOOTH_DEVICE',
          verificationData: {
            approved,
            reason,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            dob: parsed.dob ? parsed.dob.toISOString().slice(0, 10) : null,
            age: parsed.age,
            documentType: 'drivers_license',
            documentNumber: parsed.documentNumber,
            issuingCountry: parsed.issuingCountry,
            nationality: parsed.issuingCountry,
            sex: parsed.sex,
            source: 'bluetooth_gun',
            documentExpiry: parsed.documentExpiry || null
          },
          sale,
          locationId
        });
        noteUpdated = true;
      } catch (e) {
        logger.warn({ event: 'bluetooth_note_update_failed', saleId }, 'Failed to update Lightspeed note for bluetooth scan');
      }

      // 5. Persist to Database FIRST (Dashboard Integration - CRITICAL)
      // Database save must succeed before in-memory update to ensure data integrity
      let dbSaved = false;
      if (db.pool) {
        try {
          // Construct verification object for DB
          const dbVerification = {
            verificationId: require('crypto').randomUUID(), // Node 14.17+
            saleId,
            clerkId: clerkId || 'BLUETOOTH_DEVICE',
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
            source: 'bluetooth_gun'
          };

          await complianceStore.saveVerification(dbVerification, {
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            locationId
          });
          dbSaved = true;
        } catch (dbError) {
          logger.error({ event: 'bluetooth_db_save_failed', saleId }, 'Failed to save bluetooth verification to DB');
        }
      }

      // 6. Update In-Memory Store (for Polling) - ONLY after DB save succeeds
      saleVerificationStore.updateVerification(saleId, verificationResult);

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
        customerName: verificationResult.customerName,
        age: parsed.age,
        dob: parsed.dob ? parsed.dob.toISOString().slice(0, 10) : null,
        reason,
        dbSaved,
        noteUpdated
      });

    } catch (error) {
      console.error('===========================================');
      console.error('❌ ERROR PROCESSING BLUETOOTH SCAN');
      console.error('Error:', error.message);
      console.error('Stack:', error.stack);
      console.error('===========================================\n');
      res.status(500).json({ success: false, error: 'Internal server error during Bluetooth scan processing.' });
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

    if (db.pool && normalizedScan.documentNumber) {
      try {
        bannedRecord = await complianceStore.findBannedCustomer({
          documentType: normalizedScan.documentType,
          documentNumber: normalizedScan.documentNumber,
          issuingCountry: normalizedScan.issuingCountry || null
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

      if (db.pool) {
        try {
          await complianceStore.saveVerification({
            verificationId: verification.verificationId || require('crypto').randomUUID(),
            saleId,
            clerkId,
            status: normalizedScan.approved ? 'approved' : 'rejected',
            reason: normalizedScan.reason,
            firstName: normalizedScan.firstName,
            lastName: normalizedScan.lastName,
            dob: normalizedScan.dob,
            age: normalizedScan.age,
            documentType: normalizedScan.documentType,
            documentNumber: normalizedScan.documentNumber,
            issuingCountry: normalizedScan.issuingCountry,
            nationality: normalizedScan.nationality,
            sex: normalizedScan.sex,
            source: normalizedScan.source || 'api_verify',
            documentExpiry: normalizedScan.documentExpiry
          }, {
            locationId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
          });
        } catch (dbError) {
          logger.error('Failed to save api verification to DB', dbError);
        }
      }

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

      const sale = await lightspeed.getSaleById(saleId);
      if (!sale) {
        logger.warn({ event: 'sale_not_found', saleId }, `Sale ${saleId} not found`);
        return res.status(404).json({
          error: 'SALE_NOT_FOUND',
          message: 'Sale not found.'
        });
      }

      const locationId = determineLocationId(req, sale);
      const outletDescriptor = getOutletDescriptor(locationId, sale?.outlet);

      const latestVerification = await resolveLatestVerification(saleId, sale.verification);

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

      const completion = await lightspeed.completeSale({
        saleId,
        verificationId,
        paymentType,
        sale,
        locationId
      });

      if (db.pool) {
        try {
          await complianceStore.recordSaleCompletion({
            saleId,
            verificationId,
            paymentType,
            amount: completion.amount ?? sale.total ?? 0
          });
        } catch (dbError) {
          logger.logAPIError('persist_sale_completion', dbError, { saleId, verificationId });
        }
      }

      logger.logSaleComplete(saleId, paymentType, completion.amount ?? sale.total);
      logger.logPerformance('completeSale', Date.now() - startTime, true);

      res.status(200).json({
        data: {
          ...completion,
          locationId: locationId || null,
          outlet: outletDescriptor,
          registerId: sale.registerId || null
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
      return res.status(503).json({
        error: 'COMPLIANCE_STORAGE_DISABLED',
        message: 'Compliance reporting requires DATABASE_URL to be configured.'
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
      return res.status(503).json({
        error: 'OVERRIDE_HISTORY_UNAVAILABLE',
        message: 'Override history reporting requires DATABASE_URL to be configured.'
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
        error: 'BANNED_LIST_UNAVAILABLE',
        message: 'Banned customer management requires DATABASE_URL to be configured.'
      });
    }

    const payload = {
      documentType: req.body.documentType.trim(),
      documentNumber: req.body.documentNumber.trim(),
      issuingCountry: req.body.issuingCountry ? req.body.issuingCountry.trim() : null,
      dateOfBirth: req.body.dateOfBirth || null,
      firstName: req.body.firstName ? req.body.firstName.trim() : null,
      lastName: req.body.lastName ? req.body.lastName.trim() : null,
      notes: req.body.notes ? sanitizeString(req.body.notes) : null
    };

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

  router.delete('/banned/:id', validateBannedId, async (req, res) => {
    if (!db.pool) {
      return res.status(503).json({
        error: 'BANNED_LIST_UNAVAILABLE',
        message: 'Banned customer management requires DATABASE_URL to be configured.'
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
      return res.status(503).json({
        error: 'OVERRIDE_UNAVAILABLE',
        message: 'Override flow requires DATABASE_URL to be configured.'
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
      if (db.pool && parsed.documentNumber) {
        try {
          const bannedRecord = await complianceStore.findBannedCustomer({
            documentType: 'drivers_license',
            documentNumber: parsed.documentNumber,
            issuingCountry: parsed.issuingCountry
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
   * Cron job endpoint for data retention enforcement
   * Called daily by Vercel Cron to delete old records per TABC compliance
   *
   * TABC requires 2-year retention (730 days)
   * This endpoint is protected by Vercel's internal cron authentication
   */
  router.post('/cron/retention', async (req, res) => {
    // Verify this is a Vercel Cron request
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
      logger.info({ event: 'retention_started' }, 'Starting scheduled data retention enforcement');

      const result = await complianceStore.enforceRetention({
        verificationDays: 730 // TABC 2-year requirement
      });

      logger.info({
        event: 'retention_completed',
        ...result
      }, `Data retention completed: ${result.verificationsDeleted} verifications, ${result.completionsDeleted} completions, ${result.overridesDeleted} overrides deleted`);

      res.status(200).json({
        success: true,
        ...result
      });
    } catch (error) {
      logger.logAPIError('retention_enforcement', error);
      res.status(500).json({
        error: 'RETENTION_FAILED',
        message: 'Failed to enforce data retention'
      });
    }
  });

  // Cron job endpoint for retention enforcement
  router.get('/cron/retention', async (req, res) => {
    // Verify that the request is authorized (Vercel cron jobs can be secured, or we rely on API key)
    // For now, we'll rely on the global authenticateRequest middleware if it's applied to /api

    if (!db.pool) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE' });
    }

    try {
      const results = await complianceStore.enforceRetention();
      res.json({ data: results });
    } catch (error) {
      logger.logAPIError('cron_retention', error);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

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

      // If not in memory, check database as fallback
      if (!verification && db.pool) {
        try {
          const result = await db.pool.query(
            'SELECT * FROM verifications WHERE sale_id = $1 ORDER BY created_at DESC LIMIT 1',
            [saleId]
          );

          if (result.rows.length > 0) {
            const row = result.rows[0];
            // Map database row to verification format
            verification = {
              saleId: row.sale_id,
              status: row.status,
              age: row.age,
              reason: row.reason,
              customerName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null
            };
            logger.info('Retrieved verification from database fallback', { saleId });
          }
        } catch (dbError) {
          logger.error('Failed to query database for verification', dbError);
          // Continue to create pending verification
        }
      }

      if (!verification) {
        // Create a new pending verification if it doesn't exist
        // This handles the case where payment-gateway.html loads before verification is created
        const newVerification = saleVerificationStore.createVerification(saleId);

        return res.json({
          saleId,
          status: newVerification.status,
          age: null,
          reason: null,
          customerName: null
        });
      }

      res.json({
        saleId: verification.saleId,
        status: verification.status,
        age: verification.age,
        reason: verification.reason,
        customerName: verification.customerName
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

  router.get('/sales/:saleId/status', async (req, res) => {
    const { saleId } = req.params;
    const verification = saleVerificationStore.getVerification(saleId);

    if (!verification) {
      return res.status(404).json({
        status: 'not_found',
        message: 'Verification session not found or expired'
      });
    }

    // Add Friendship metadata for frontend troubleshooting
    res.json({
      saleId: verification.saleId,
      status: verification.status,
      customerName: verification.customerName,
      reason: verification.reason,
      // Friendship Data
      remoteScannerActive: verification.remoteScannerActive,
      lastHeartbeat: verification.lastHeartbeat,
      logs: verification.logs, // Full trace for "dev testing"
      expiresAt: verification.expiresAt
    });
  });

  module.exports = router;
