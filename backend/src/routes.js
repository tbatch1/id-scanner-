const express = require('express');
const config = require('./config');
const lightspeed = require('./lightspeedClient');
const logger = require('./logger');
const db = require('./db');
const complianceStore = require('./complianceStore');
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
    logger.logAPIError('list_recent_overrides', error, { days, limit });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to fetch override history.'
    });
  }
});

router.get('/banned', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      error: 'BANNED_LIST_UNAVAILABLE',
      message: 'Banned customer management requires DATABASE_URL to be configured.'
    });
  }

  try {
    const entries = await complianceStore.listBannedCustomers();
    res.json({ data: entries });
  } catch (error) {
    logger.logAPIError('list_banned_customers', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unable to fetch banned customers.'
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


router.post('/sales/:saleId/override', validateOverride, async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      error: 'OVERRIDE_UNAVAILABLE',
      message: 'Override flow requires DATABASE_URL to be configured.'
    });
  }

  if (!process.env.OVERRIDE_PIN) {
    return res.status(503).json({
      error: 'OVERRIDE_DISABLED',
      message: 'Set OVERRIDE_PIN in the environment to allow overrides.'
    });
  }

  const { saleId } = req.params;
  const { verificationId, managerPin, managerId, note } = req.body || {};

  if (managerPin !== process.env.OVERRIDE_PIN) {
    logger.logSecurity('override_pin_mismatch', { saleId, managerId: managerId || 'unknown' });
    return res.status(403).json({
      error: 'INVALID_PIN',
      message: 'Manager PIN is incorrect.'
    });
  }

  try {
    const latest = await complianceStore.getLatestVerificationForSale(saleId);

    if (!latest || latest.verification_id !== verificationId) {
      logger.logSecurity('override_verification_mismatch', {
        saleId,
        providedVerificationId: verificationId,
        actualVerificationId: latest?.verification_id
      });
      return res.status(409).json({
        error: 'VERIFICATION_MISMATCH',
        message: 'Verification ID does not match the latest verification for this sale.'
      });
    }

    const result = await complianceStore.markVerificationOverride({
      verificationId,
      saleId,
      managerId: sanitizeString(managerId) || 'manager',
      note
    });

    const mappedVerification = mapDbVerification(result.verification);
    const overrideRecord = result.override
      ? {
          id: result.override.id,
          verificationId: result.override.verification_id,
          saleId: result.override.sale_id,
          managerId: result.override.manager_id,
          note: result.override.note,
          createdAt: result.override.created_at
        }
      : null;

    logger.logSecurity('override_success', { saleId, verificationId, managerId: managerId || null });

    res.status(200).json({ data: { verification: mappedVerification, override: overrideRecord } });
  } catch (error) {
    logger.logAPIError('override_verification', error, { saleId, verificationId });
    const status = error.message === 'VERIFICATION_NOT_FOUND' ? 404 : 500;
    res.status(status).json({
      error: error.message || 'INTERNAL_ERROR',
      message: 'Unable to process override request.'
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

module.exports = router;
