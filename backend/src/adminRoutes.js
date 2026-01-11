const express = require('express');
const lightspeed = require('./lightspeedClient');
const config = require('./config');
const db = require('./db');
const logger = require('./logger');
const chatService = require('./chatService');
const marketingService = require('./marketingService');
const lightspeedWebhookQueue = require('./lightspeedWebhookQueue');

const router = express.Router();

const scansCache = new Map();
const SCAN_CACHE_TTL_MS = 60 * 1000;

const OUTLETS_CACHE_TTL_MS = 5 * 60 * 1000;
let outletsCache = { expiresAt: 0, outlets: null };

async function listOutletsForAdmin() {
  if (outletsCache.outlets && outletsCache.expiresAt > Date.now()) {
    return outletsCache.outlets;
  }

  const envOutletsById = config?.lightspeed?.outletsById || {};
  const envOutlets = Object.values(envOutletsById).map((outlet) => ({
    outletId: outlet.id,
    code: outlet.code || null,
    label: outlet.label || outlet.code || outlet.id
  }));

  let liveOutlets = [];
  if (typeof lightspeed.listOutlets === 'function') {
    try {
      liveOutlets = await lightspeed.listOutlets();
    } catch (error) {
      logger.logAPIError('admin_outlets_live_failed', error);
    }
  }

  const merged = new Map();
  for (const outlet of liveOutlets || []) {
    if (!outlet?.outletId) continue;
    merged.set(String(outlet.outletId), {
      outletId: String(outlet.outletId),
      code: outlet.code || null,
      label: outlet.label || outlet.name || outlet.code || outlet.outletId
    });
  }
  for (const outlet of envOutlets) {
    if (!outlet?.outletId) continue;
    const key = String(outlet.outletId);
    if (!merged.has(key)) merged.set(key, outlet);
  }

  const outlets = Array.from(merged.values()).sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  outletsCache = { outlets, expiresAt: Date.now() + OUTLETS_CACHE_TTL_MS };
  return outlets;
}

function normalizeInteger(value, { fallback, min, max } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(Math.max(normalized, min ?? normalized), max ?? normalized);
}

async function getLatestSnapshotDate(tableName) {
  const { rows } = await db.pool.query(`SELECT MAX(snapshot_date) as latest_date FROM ${tableName}`);
  return rows[0]?.latest_date || null;
}

async function snapshotTablesPresent() {
  const { rows } = await db.pool.query(
    `
      SELECT
        to_regclass('public.daily_sales_snapshots') as sales,
        to_regclass('public.daily_inventory_snapshots') as inventory,
        to_regclass('public.daily_customer_snapshots') as customers,
        to_regclass('public.daily_outlet_snapshots') as outlets
    `
  );
  const row = rows[0] || {};
  return {
    sales: Boolean(row.sales),
    inventory: Boolean(row.inventory),
    customers: Boolean(row.customers),
    outlets: Boolean(row.outlets)
  };
}

function isoDateOnly(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function getScanCacheKey(query) {
  const location = query?.location ? String(query.location) : '';
  const status = query?.status ? String(query.status) : '';
  const limit = query?.limit ? String(query.limit) : '';
  const offset = query?.offset ? String(query.offset) : '';
  return `${location}::${status}::${limit}::${offset}`;
}

function getCachedScans(key) {
  const entry = scansCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    scansCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedScans(key, payload) {
  scansCache.set(key, {
    expiresAt: Date.now() + SCAN_CACHE_TTL_MS,
    payload
  });
}

function parseIdCheckNote(note) {
  const raw = (note || '').toString();
  if (!raw.trim()) return { hasIdNote: false };

  const { parseAgeNote } = require('./ageNote');
  const ageInfo = parseAgeNote(raw);
  if (ageInfo.hasAgeNote) {
    return {
      hasIdNote: true,
      noteLine: ageInfo.line,
      noteStatus: 'AGE',
      noteAge: ageInfo.age,
      noteDobYear: null
    };
  }

  // Backwards compatible: older format `ID Verified APPROVED: Age 31 ...`
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const mostRecentLegacy = [...lines].reverse().find((line) => /^(ID Check|ID Verified)/i.test(line)) || null;
  if (!mostRecentLegacy) return { hasIdNote: false };

  const statusMatch = mostRecentLegacy.match(/ID\s+(?:Check|Verified)\s+(APPROVED|REJECTED)/i);
  const status = statusMatch ? statusMatch[1].toUpperCase() : null;

  const ageMatch = mostRecentLegacy.match(/\bAge\s+(\d{1,3})\b/i);
  const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

  const dobYearMatch = mostRecentLegacy.match(/\bDOB\s+(\d{4})\b/i);
  const dobYear = dobYearMatch ? dobYearMatch[1] : null;

  return {
    hasIdNote: true,
    noteLine: mostRecentLegacy,
    noteStatus: status,
    noteAge: Number.isFinite(age) ? age : null,
    noteDobYear: dobYear
  };
}

async function buildAuthStatus() {
  let baseState = { status: 'unknown' };
  if (typeof lightspeed.getAuthState === 'function') {
    try {
      baseState = await lightspeed.getAuthState();
    } catch (error) {
      baseState = { status: 'unknown', lastError: error.message };
    }
  }

  return {
    environment: config.env,
    lightspeedMode: process.env.LIGHTSPEED_USE_MOCK === 'true' ? 'mock' : 'live',
    enableWrites: Boolean(config.lightspeed.enableWrites),
    accountId: config.lightspeed.accountId || null,
    hasClientId: Boolean(config.lightspeed.clientId),
    hasClientSecret: Boolean(config.lightspeed.clientSecret),
    defaultOutletId: config.lightspeed.defaultOutletId || null,
    timestamp: new Date().toISOString(),
    ...baseState
  };
}

router.get('/status', async (req, res) => {
  res.json(await buildAuthStatus());
});

// GET /admin/outlets - configured outlets for dashboard filtering
router.get('/outlets', async (req, res) => {
  try {
    const outlets = await listOutletsForAdmin();
    const defaultOutletId = config?.lightspeed?.defaultOutletId || null;
    const payload = outlets.slice();

    if (payload.length === 0 && defaultOutletId) {
      payload.push({ outletId: defaultOutletId, code: 'DEFAULT', label: 'Default Outlet' });
    }

    res.status(200).json({
      success: true,
      count: payload.length,
      outlets: payload
    });
  } catch (error) {
    logger.logAPIError('admin_outlets', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load outlets.' });
  }
});

router.post('/refresh', async (req, res) => {
  if (typeof lightspeed.refreshAccessToken !== 'function') {
    return res.status(503).json({
      error: 'NOT_SUPPORTED',
      message: 'Lightspeed client is not initialized.'
    });
  }

  try {
    await lightspeed.refreshAccessToken(true);
    res.status(200).json(await buildAuthStatus());
  } catch (error) {
    res.status(500).json({
      error: 'REFRESH_FAILED',
      message: error.message
    });
  }
});

function normalizeBoolean(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return false;
}

async function buildSalesAudit({ status = 'ALL', limit = 50, outlet = null, missingOnly = false } = {}) {
  const normalizedStatus = String(status || 'ALL').toUpperCase();
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const normalizedOutlet = outlet ? String(outlet).trim() : null;
  const normalizedMissingOnly = normalizeBoolean(missingOnly);

  // Prefer DB-driven audit: every flow should produce a verification record.
  // Then we fetch the sale note from Lightspeed to ensure the audit note actually got written.
  if (db.pool) {
    const baseCte = `
      WITH latest AS (
        SELECT
          v.sale_id,
          v.verification_id,
          v.status AS verification_status,
          v.age AS verification_age,
          v.date_of_birth AS verification_dob,
          v.location_id,
          v.clerk_id,
          v.created_at AS verification_created_at,
          ROW_NUMBER() OVER (PARTITION BY v.sale_id ORDER BY v.created_at DESC) AS rn
        FROM verifications v
      )
    `;

    const queryWithCompletions = `
      ${baseCte}
      SELECT
        l.sale_id,
        l.verification_id,
        l.verification_status,
        l.verification_age,
        l.verification_dob,
        l.location_id,
        l.clerk_id,
        l.verification_created_at,
        sc.payment_type,
        sc.amount,
        sc.completed_at
      FROM latest l
      LEFT JOIN sales_completions sc
        ON sc.sale_id = l.sale_id
      WHERE l.rn = 1
      ORDER BY l.verification_created_at DESC
      LIMIT $1
    `;

    const queryWithoutCompletions = `
      ${baseCte}
      SELECT
        l.sale_id,
        l.verification_id,
        l.verification_status,
        l.verification_age,
        l.verification_dob,
        l.location_id,
        l.clerk_id,
        l.verification_created_at,
        NULL::text AS payment_type,
        NULL::numeric AS amount,
        NULL::timestamp AS completed_at
      FROM latest l
      WHERE l.rn = 1
      ORDER BY l.verification_created_at DESC
      LIMIT $1
    `;

    let rows;
    try {
      ({ rows } = await db.pool.query(queryWithCompletions, [normalizedLimit]));
    } catch (error) {
      if (error?.code === '42P01' && /sales_completions/i.test(String(error?.message || ''))) {
        ({ rows } = await db.pool.query(queryWithoutCompletions, [normalizedLimit]));
      } else {
        throw error;
      }
    }

    const concurrency = 5;
    const enriched = [];
    let saleFetchErrorCount = 0;
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      const sales = await Promise.allSettled(
        batch.map(async (row) => {
          return await lightspeed.getSaleById(row.sale_id);
        })
      );

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const saleResult = sales[j];
        const sale = saleResult.status === 'fulfilled' ? saleResult.value : null;
        if (!sale) {
          saleFetchErrorCount += 1;
        }

        if (normalizedStatus !== 'ALL' && sale?.status && sale.status !== normalizedStatus) {
          continue;
        }

        if (normalizedOutlet) {
          const outletId = sale?.outletId ?? row.location_id ?? null;
          if (String(outletId || '') !== normalizedOutlet) continue;
        }

        const saleFetchOk = Boolean(sale);
        const noteInfo = saleFetchOk ? parseIdCheckNote(sale.note) : { hasIdNote: false };
        const verifiedApproved = String(row.verification_status || '').startsWith('approved');

        const item = {
          sale_id: row.sale_id,
          verification_id: row.verification_id,
          total: sale?.total ?? null,
          status: sale?.status ?? null,
          outlet_id: sale?.outletId ?? null,
          outlet_name: sale?.outletName ?? null,
          register_id: sale?.registerId ?? null,
          user_id: sale?.userId ?? null,
          user_name: sale?.employeeName ?? null,
          customer_id: sale?.customerId ?? null,
          created_at: sale?.createdAt ?? null,
          updated_at: sale?.updatedAt ?? null,
          ...noteInfo,
          saleFetchOk,
          hasVerification: true,
          approved: verifiedApproved || noteInfo.noteStatus === 'APPROVED',
          verification_status: row.verification_status,
          verification_age: row.verification_age ?? null,
          verification_dob: row.verification_dob || null,
          verification_created_at: row.verification_created_at || null,
          payment_type: row.payment_type || null,
          amount: row.amount ?? null,
          completed_at: row.completed_at || null,
          missingNote: saleFetchOk ? !noteInfo.hasIdNote : null,
          missingVerification: false
        };

        const needsAttention = item.missingNote === true || item.missingVerification === true;
        if (normalizedMissingOnly && !needsAttention) {
          continue;
        }

        enriched.push(item);
      }
    }

    const missingNotes = enriched.filter((t) => t.missingNote === true);
    return {
      status: normalizedStatus,
      limit: normalizedLimit,
      items: enriched,
      missingNoteCount: missingNotes.length,
      missingVerificationCount: 0,
      saleFetchErrorCount
    };
  }

  // Fallback: without DB, use Lightspeed sales listing and note parsing.
  const sales = await lightspeed.listSales({
    status: normalizedStatus === 'ALL' ? null : normalizedStatus,
    limit: normalizedLimit
  });
  const enriched = (sales || []).map((sale) => {
    const noteInfo = parseIdCheckNote(sale?.note);
    return {
      sale_id: sale?.saleId || sale?.sale_id || sale?.id || null,
      total: sale?.total ?? null,
      status: sale?.status ?? null,
      outlet_id: sale?.outletId ?? null,
      outlet_name: sale?.outletName ?? null,
      register_id: sale?.registerId ?? null,
      user_id: sale?.userId ?? null,
      user_name: sale?.employeeName ?? null,
      customer_id: sale?.customerId ?? null,
      created_at: sale?.createdAt ?? null,
      updated_at: sale?.updatedAt ?? null,
      ...noteInfo,
      hasVerification: false,
      approved: noteInfo.noteStatus === 'APPROVED',
      verification_status: null,
      verification_age: null,
      verification_dob: null,
      verification_created_at: null,
      missingNote: !noteInfo.hasIdNote,
      missingVerification: true
    };
  }).filter((row) => row.sale_id);

  const filtered = normalizedOutlet
    ? enriched.filter((row) => String(row.outlet_id || '') === normalizedOutlet)
    : enriched;

  const finalItems = normalizedMissingOnly
    ? filtered.filter((row) => row.missingNote || row.missingVerification)
    : filtered;

  const missingNotes = finalItems.filter((t) => t.missingNote === true);
  return {
    status: normalizedStatus,
    limit: normalizedLimit,
    items: finalItems,
    missingNoteCount: missingNotes.length,
    missingVerificationCount: finalItems.filter((t) => t.missingVerification).length,
    saleFetchErrorCount: 0
  };
}

// GET /api/admin/pending/:locationId - Get pending/rejected sales for specific location
router.get('/pending/:locationId', async (req, res) => {
  if (!db.pool) {
    if (typeof lightspeed.listVerifications === 'function') {
      const { locationId } = req.params;
      const pending = lightspeed.listVerifications({
        location: locationId,
        status: 'rejected',
        limit: 50,
        offset: 0
      });

      const now = Date.now();
      const formatted = pending.map((entry) => ({
        verification_id: entry.verification_id,
        sale_id: entry.sale_id,
        first_name: entry.first_name,
        last_name: entry.last_name,
        age: entry.age,
        date_of_birth: entry.date_of_birth,
        status: entry.status,
        reason: entry.reason,
        document_type: entry.document_type,
        location_id: entry.location_id,
        clerk_id: entry.clerk_id,
        created_at: entry.created_at,
        seconds_ago: entry.created_at ? (now - new Date(entry.created_at).getTime()) / 1000 : null
      }));

      return res.status(200).json({
        success: true,
        location: locationId,
        count: formatted.length,
        pending: formatted
      });
    }

    return res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Database connection required'
    });
  }

  const { locationId } = req.params;

  try {
    // Query scan_sessions table for rejected scans at this location
    const query = `
      SELECT
        session_id AS verification_id,
        session_id AS sale_id,
        first_name,
        last_name,
        age,
        date_of_birth,
        CASE WHEN approved = true THEN 'approved'
             WHEN approved = false THEN 'rejected'
             ELSE 'pending' END AS status,
        reason,
        'drivers_license' AS document_type,
        outlet_id AS location_id,
        COALESCE(employee_name, 'Register ' || SUBSTRING(register_id, 1, 8)) AS clerk_id,
        completed_at AS created_at,
        EXTRACT(EPOCH FROM (NOW() - completed_at)) AS seconds_ago
      FROM scan_sessions
      WHERE outlet_id = $1
        AND approved = false
      ORDER BY completed_at DESC
      LIMIT 50
    `;

    const result = await db.pool.query(query, [locationId]);

    res.status(200).json({
      success: true,
      location: locationId,
      count: result.rows.length,
      pending: result.rows
    });
  } catch (error) {
    logger.logAPIError('get_pending_sales', error, { locationId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve pending sales'
    });
  }
});

// GET /api/admin/scans - Get all scans with optional filters
router.get('/scans', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const force = ['1', 'true', 'yes', 'on'].includes(String(req.query?.force || req.query?.refresh || '').toLowerCase());
  const cacheKey = getScanCacheKey(req.query);
  if (!force) {
    const cached = getCachedScans(cacheKey);
    if (cached) {
      return res.status(200).json({
        ...cached,
        cached: true
      });
    }
  }

  if (!db.pool) {
    if (typeof lightspeed.listVerifications === 'function') {
      const { location, status, limit = 100, offset = 0 } = req.query;
      const scans = lightspeed.listVerifications({
        location: location || undefined,
        status: status || undefined,
        limit,
        offset
      });

      const payload = {
        success: true,
        count: scans.length,
        scans,
        generatedAt: new Date().toISOString(),
        cached: false
      };
      setCachedScans(cacheKey, payload);
      return res.status(200).json(payload);
    }

    return res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Database connection required'
    });
  }

  const { location, status, limit = 100, offset = 0 } = req.query;

  try {
    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (location) {
      whereConditions.push(`location_id = $${paramIndex}`);
      params.push(location);
      paramIndex++;
    }

    if (status) {
      whereConditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const query = `
    SELECT
    verification_id,
      sale_id,
      first_name,
      last_name,
      age,
      date_of_birth,
      status,
      reason,
      document_type,
      location_id,
      clerk_id,
      created_at
      FROM verifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const result = await db.pool.query(query, params);

    const payload = {
      success: true,
      count: result.rows.length,
      scans: result.rows,
      generatedAt: new Date().toISOString(),
      cached: false
    };
    setCachedScans(cacheKey, payload);
    res.status(200).json(payload);
  } catch (error) {
    logger.logAPIError('get_scans', error, { location, status });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve scans'
    });
  }
});

// GET /admin/transactions - Recent sales with ID-note audit (notification center source)
router.get('/transactions', async (req, res) => {
  try {
    const audit = await buildSalesAudit(req.query || {});
    res.status(200).json({
      success: true,
      status: audit.status,
      limit: audit.limit,
      count: audit.items.length,
      missingNoteCount: audit.missingNoteCount,
      missingVerificationCount: audit.missingVerificationCount,
      saleFetchErrorCount: audit.saleFetchErrorCount,
      transactions: audit.items
    });
  } catch (error) {
    logger.logAPIError('admin_transactions', error, { query: req.query || {} });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve transactions'
    });
  }
});

// GET /admin/sales - Alias for the manager data-center dashboard (same audit data, different payload key)
router.get('/sales', async (req, res) => {
  try {
    const audit = await buildSalesAudit(req.query || {});
    res.status(200).json({
      success: true,
      status: audit.status,
      limit: audit.limit,
      count: audit.items.length,
      missingNoteCount: audit.missingNoteCount,
      missingVerificationCount: audit.missingVerificationCount,
      saleFetchErrorCount: audit.saleFetchErrorCount,
      sales: audit.items
    });
  } catch (error) {
    logger.logAPIError('admin_sales', error, { query: req.query || {} });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve sales audit'
    });
  }
});

// BI endpoints (Data Center) - DB-backed daily snapshots for fast dashboards
router.get('/bi/snapshot-health', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  try {
    const present = await snapshotTablesPresent();
    if (!present.sales && !present.inventory && !present.customers && !present.outlets) {
      return res.status(409).json({
        error: 'SNAPSHOT_TABLES_MISSING',
        message: 'Snapshot tables are not installed yet. Run the snapshots cron job (it will auto-create tables) and refresh.',
        present
      });
    }

    const [salesDate, inventoryDate, customersDate, outletsDate] = await Promise.all([
      present.sales ? getLatestSnapshotDate('daily_sales_snapshots') : Promise.resolve(null),
      present.inventory ? getLatestSnapshotDate('daily_inventory_snapshots') : Promise.resolve(null),
      present.customers ? getLatestSnapshotDate('daily_customer_snapshots') : Promise.resolve(null),
      present.outlets ? getLatestSnapshotDate('daily_outlet_snapshots') : Promise.resolve(null)
    ]);

    res.status(200).json({
      success: true,
      present,
      latest: {
        sales: isoDateOnly(salesDate),
        inventory: isoDateOnly(inventoryDate),
        customers: isoDateOnly(customersDate),
        outlets: isoDateOnly(outletsDate)
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.logAPIError('bi_snapshot_health', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read snapshot health.' });
  }
});

router.get('/bi/summary', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  const days = normalizeInteger(req.query?.days, { fallback: 7, min: 1, max: 365 });
  const outletId = req.query?.outletId ? String(req.query.outletId).trim() : null;

  try {
    const present = await snapshotTablesPresent();
    if (!present.outlets) {
      return res.status(409).json({
        error: 'SNAPSHOT_TABLES_MISSING',
        message: 'Outlet snapshot table is missing. Run the snapshots cron job to create/populate it.',
        present
      });
    }

    const latest = await getLatestSnapshotDate('daily_outlet_snapshots');
    if (!latest) {
      return res.status(409).json({
        error: 'NO_SNAPSHOTS',
        message: 'No snapshot data available yet. Run the snapshot cron job first.'
      });
    }

    const rangeEnd = isoDateOnly(latest);
    const rangeStart = isoDateOnly(new Date(new Date(rangeEnd).getTime() - (days - 1) * 24 * 60 * 60 * 1000));

    const outletRows = await db.pool.query(
      `
        SELECT
          outlet_id AS "outletId",
          MAX(outlet_name) AS "outletName",
          SUM(total_revenue)::float AS "totalRevenue",
          SUM(total_transactions)::int AS "totalTransactions",
          SUM(items_sold)::int AS "itemsSold"
        FROM daily_outlet_snapshots
        WHERE snapshot_date BETWEEN $1 AND $2
          AND ($3::text IS NULL OR outlet_id = $3)
        GROUP BY outlet_id
        ORDER BY "totalRevenue" DESC NULLS LAST
      `,
      [rangeStart, rangeEnd, outletId]
    );

    let uniqueByOutlet = new Map();
    if (present.customers) {
      const uniqueRows = await db.pool.query(
        `
          SELECT
            outlet_id AS "outletId",
            COUNT(DISTINCT customer_id)::int AS "uniqueCustomers"
          FROM daily_customer_snapshots
          WHERE snapshot_date BETWEEN $1 AND $2
            AND ($3::text IS NULL OR outlet_id = $3)
          GROUP BY outlet_id
        `,
        [rangeStart, rangeEnd, outletId]
      );
      uniqueByOutlet = new Map(uniqueRows.rows.map((r) => [r.outletId, r.uniqueCustomers]));
    }

    const byOutlet = outletRows.rows.map((r) => {
      const totalRevenue = Number(r.totalRevenue || 0);
      const totalTransactions = Number(r.totalTransactions || 0);
      return {
        ...r,
        uniqueCustomers: uniqueByOutlet.get(r.outletId) ?? null,
        avgTransactionValue: totalTransactions > 0 ? totalRevenue / totalTransactions : 0
      };
    });

    const totals = byOutlet.reduce(
      (acc, r) => {
        acc.totalRevenue += Number(r.totalRevenue || 0);
        acc.totalTransactions += Number(r.totalTransactions || 0);
        acc.itemsSold += Number(r.itemsSold || 0);
        return acc;
      },
      { totalRevenue: 0, totalTransactions: 0, itemsSold: 0 }
    );
    const avgTransactionValue = totals.totalTransactions > 0 ? totals.totalRevenue / totals.totalTransactions : 0;

    // Total unique customers across range (optionally filtered by outlet)
    const uniqueTotalRes = present.customers
      ? await db.pool.query(
        `
          SELECT COUNT(DISTINCT customer_id)::int AS "uniqueCustomers"
          FROM daily_customer_snapshots
          WHERE snapshot_date BETWEEN $1 AND $2
            AND ($3::text IS NULL OR outlet_id = $3)
        `,
        [rangeStart, rangeEnd, outletId]
      )
      : { rows: [{ uniqueCustomers: null }] };

    res.status(200).json({
      success: true,
      present,
      range: { start: rangeStart, end: rangeEnd, days },
      outletId,
      totals: {
        ...totals,
        uniqueCustomers: uniqueTotalRes.rows[0]?.uniqueCustomers ?? null,
        avgTransactionValue
      },
      outlets: byOutlet
    });
  } catch (error) {
    logger.logAPIError('bi_summary', error, { days, outletId });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load BI summary.' });
  }
});

router.get('/bi/top-products', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  const days = normalizeInteger(req.query?.days, { fallback: 7, min: 1, max: 365 });
  const limit = normalizeInteger(req.query?.limit, { fallback: 10, min: 1, max: 200 });
  const sortBy = String(req.query?.sortBy || 'revenue').toLowerCase() === 'quantity' ? 'quantity' : 'revenue';
  const outletId = req.query?.outletId ? String(req.query.outletId).trim() : null;

  try {
    const present = await snapshotTablesPresent();
    if (!present.sales) {
      return res.status(409).json({
        error: 'SNAPSHOT_TABLES_MISSING',
        message: 'Sales snapshot table is missing. Run the snapshots cron job to create/populate it.',
        present
      });
    }

    const latest = await getLatestSnapshotDate('daily_sales_snapshots');
    if (!latest) {
      return res.status(409).json({ error: 'NO_SNAPSHOTS', message: 'No sales snapshots available yet.' });
    }

    const rangeEnd = isoDateOnly(latest);
    const rangeStart = isoDateOnly(new Date(new Date(rangeEnd).getTime() - (days - 1) * 24 * 60 * 60 * 1000));

    const orderClause = sortBy === 'quantity' ? 'quantitySold DESC' : 'revenue DESC';
    const { rows } = await db.pool.query(
      `
        SELECT
          product_id AS "productId",
          COALESCE(MAX(NULLIF(product_name, 'Unknown Product')), MAX(product_name)) AS "productName",
          COALESCE(MAX(NULLIF(sku, '')), MAX(sku)) AS "sku",
          COALESCE(MAX(NULLIF(category_name, '')), MAX(category_name)) AS "categoryName",
          SUM(quantity_sold)::float AS "quantitySold",
          SUM(revenue)::float AS "revenue",
          SUM(transaction_count)::int AS "transactionCount"
        FROM daily_sales_snapshots
        WHERE snapshot_date BETWEEN $1 AND $2
          AND ($3::text IS NULL OR outlet_id = $3)
        GROUP BY product_id
        ORDER BY ${orderClause} NULLS LAST
        LIMIT $4
      `,
      [rangeStart, rangeEnd, outletId, limit]
    );

    // If snapshots don't have names/SKUs, resolve a few via Lightspeed and backfill the snapshot rows.
    const canLookup = typeof lightspeed.getProductById === 'function';
    if (canLookup && rows.length) {
      const needsLookup = rows
        .filter((r) => r.productId && (r.productName === null || r.productName === 'Unknown Product' || !r.sku))
        .slice(0, 50);

      const concurrency = 6;
      for (let i = 0; i < needsLookup.length; i += concurrency) {
        const batch = needsLookup.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (row) => {
            const product = await lightspeed.getProductById(row.productId);
            if (!product) return;

            const resolvedName = product.name || null;
            const resolvedSku = product.sku || null;
            const resolvedCategory = product.categoryName || null;

            if (resolvedName && (!row.productName || row.productName === 'Unknown Product')) row.productName = resolvedName;
            if (resolvedSku && !row.sku) row.sku = resolvedSku;
            if (resolvedCategory && !row.categoryName) row.categoryName = resolvedCategory;

            if (!resolvedName && !resolvedSku && !resolvedCategory) return;
            try {
              await db.pool.query(
                `
                  UPDATE daily_sales_snapshots
                  SET
                    product_name = COALESCE(NULLIF(product_name, 'Unknown Product'), $2),
                    sku = COALESCE(sku, $3),
                    category_name = COALESCE(category_name, $4)
                  WHERE product_id = $1
                    AND snapshot_date BETWEEN $5 AND $6
                    AND ($7::text IS NULL OR outlet_id = $7)
                `,
                [row.productId, resolvedName, resolvedSku, resolvedCategory, rangeStart, rangeEnd, outletId]
              );
            } catch (e) {
              logger.logAPIError('bi_top_products_backfill', e, { productId: row.productId });
            }
          })
        );
      }
    }

    res.status(200).json({
      success: true,
      present,
      range: { start: rangeStart, end: rangeEnd, days },
      outletId,
      sortBy,
      count: rows.length,
      products: rows
    });
  } catch (error) {
    logger.logAPIError('bi_top_products', error, { days, outletId });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load top products.' });
  }
});

router.get('/bi/top-customers', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  const days = normalizeInteger(req.query?.days, { fallback: 30, min: 1, max: 730 });
  const limit = normalizeInteger(req.query?.limit, { fallback: 10, min: 1, max: 200 });
  const outletId = req.query?.outletId ? String(req.query.outletId).trim() : null;

  try {
    const present = await snapshotTablesPresent();
    if (!present.customers) {
      return res.status(409).json({
        error: 'SNAPSHOT_TABLES_MISSING',
        message: 'Customer snapshot table is missing. Run the snapshots cron job to create/populate it.',
        present
      });
    }

    const latest = await getLatestSnapshotDate('daily_customer_snapshots');
    if (!latest) {
      return res.status(409).json({ error: 'NO_SNAPSHOTS', message: 'No customer snapshots available yet.' });
    }

    const rangeEnd = isoDateOnly(latest);
    const rangeStart = isoDateOnly(new Date(new Date(rangeEnd).getTime() - (days - 1) * 24 * 60 * 60 * 1000));

    const { rows } = await db.pool.query(
      `
        SELECT
          customer_id AS "customerId",
          MAX(customer_name) AS "customerName",
          MAX(customer_email) AS "customerEmail",
          SUM(transaction_count)::int AS "transactionCount",
          SUM(total_spend)::float AS "totalSpend",
          CASE WHEN SUM(transaction_count) > 0 THEN (SUM(total_spend) / SUM(transaction_count))::float ELSE 0 END AS "avgTransactionValue"
        FROM daily_customer_snapshots
        WHERE snapshot_date BETWEEN $1 AND $2
          AND ($3::text IS NULL OR outlet_id = $3)
        GROUP BY customer_id
        ORDER BY "totalSpend" DESC NULLS LAST
        LIMIT $4
      `,
      [rangeStart, rangeEnd, outletId, limit]
    );

    res.status(200).json({
      success: true,
      present,
      range: { start: rangeStart, end: rangeEnd, days },
      outletId,
      count: rows.length,
      customers: rows
    });
  } catch (error) {
    logger.logAPIError('bi_top_customers', error, { days, outletId });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load top customers.' });
  }
});

router.get('/bi/low-stock', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Database not configured.' });
  }

  const limit = normalizeInteger(req.query?.limit, { fallback: 25, min: 1, max: 500 });
  const outletId = req.query?.outletId ? String(req.query.outletId).trim() : null;
  const threshold = req.query?.threshold !== undefined ? normalizeInteger(req.query.threshold, { fallback: null, min: 0, max: 100000 }) : null;

  try {
    const present = await snapshotTablesPresent();
    if (!present.inventory) {
      return res.status(409).json({
        error: 'SNAPSHOT_TABLES_MISSING',
        message: 'Inventory snapshot table is missing. Run the snapshots cron job to create/populate it.',
        present
      });
    }

    const latest = await getLatestSnapshotDate('daily_inventory_snapshots');
    if (!latest) {
      // Fallback: allow outlet-scoped live lookup so managers can still see something on day 1.
      if (outletId && typeof lightspeed.listInventory === 'function') {
        try {
          const outlets = await listOutletsForAdmin();
          const outletLabel = outlets.find((o) => String(o.outletId) === String(outletId))?.label || outletId;
          const inventory = await lightspeed.listInventory({ outletId, limit: 200, allPages: false });

          const items = (inventory || [])
            .filter((item) => {
              const current = Number(item.currentAmount ?? 0);
              const reorder = item.reorderPoint === null || item.reorderPoint === undefined ? null : Number(item.reorderPoint);
              if (threshold === null) return reorder !== null && reorder > 0 && current <= reorder;
              return current <= threshold;
            })
            .map((item) => ({
              outletId: String(outletId),
              outletName: outletLabel,
              productId: item.productId,
              productName: item.productName || null,
              sku: item.sku || null,
              currentAmount: Number(item.currentAmount ?? 0),
              reorderPoint: item.reorderPoint === null || item.reorderPoint === undefined ? null : Number(item.reorderPoint),
              averageCost: Number(item.averageCost ?? 0),
              retailPrice: Number(item.retailPrice ?? 0),
              inventoryValue: Number(item.currentAmount ?? 0) * Number(item.averageCost ?? 0)
            }))
            .sort((a, b) => (Number(b.reorderPoint ?? 0) - Number(b.currentAmount ?? 0)) - (Number(a.reorderPoint ?? 0) - Number(a.currentAmount ?? 0)))
            .slice(0, limit);

          return res.status(200).json({
            success: true,
            present,
            snapshotDate: null,
            outletId,
            threshold,
            source: 'live',
            note: 'Using live Lightspeed inventory (no nightly inventory snapshots yet).',
            count: items.length,
            items
          });
        } catch (fallbackError) {
          logger.logAPIError('bi_low_stock_live_fallback', fallbackError, { outletId });
          // Fall through to the original NO_SNAPSHOTS response.
        }
      }

      return res.status(409).json({
        error: 'NO_SNAPSHOTS',
        message: outletId
          ? 'No inventory snapshots available yet (and live fallback failed).'
          : 'No inventory snapshots available yet. Select an outlet to use live inventory fallback, or run the nightly snapshot job.'
      });
    }

    const snapshotDate = isoDateOnly(latest);
    const params = [snapshotDate, outletId, limit];

    const where = threshold === null
      ? 'reorder_point IS NOT NULL AND current_amount <= reorder_point'
      : 'current_amount <= $4';

    if (threshold !== null) params.push(threshold);

    const { rows } = await db.pool.query(
      `
        SELECT
          outlet_id AS "outletId",
          outlet_name AS "outletName",
          product_id AS "productId",
          product_name AS "productName",
          sku AS "sku",
          current_amount::float AS "currentAmount",
          reorder_point::float AS "reorderPoint",
          average_cost::float AS "averageCost",
          retail_price::float AS "retailPrice",
          inventory_value::float AS "inventoryValue"
        FROM daily_inventory_snapshots
        WHERE snapshot_date = $1
          AND ($2::text IS NULL OR outlet_id = $2)
          AND ${where}
        ORDER BY (COALESCE(reorder_point, 0) - COALESCE(current_amount, 0)) DESC NULLS LAST
        LIMIT $3
      `,
      params
    );

    res.status(200).json({
      success: true,
      present,
      snapshotDate,
      outletId,
      threshold,
      count: rows.length,
      items: rows
    });
  } catch (error) {
    logger.logAPIError('bi_low_stock', error, { outletId });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load low stock.' });
  }
});

// Marketing Analytics (Customer profiles + segments)
router.get('/marketing/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!db.pool) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Database connection required' });
  }

  try {
    const health = await marketingService.getMarketingHealth(db.pool);
    res.status(200).json({ success: true, ...health, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.logAPIError('marketing_health', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load marketing health.' });
  }
});

router.post('/marketing/sync', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!db.pool) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Database connection required' });
  }

  try {
    const resetCursor = ['1', 'true', 'yes', 'on'].includes(String(req.query?.reset || '').toLowerCase());
    const pageSize = normalizeInteger(req.query?.pageSize, { fallback: 200, min: 1, max: 200 });
    const maxPages = normalizeInteger(req.query?.maxPages, { fallback: 50, min: 1, max: 500 });
    const maxDurationMs = normalizeInteger(req.query?.maxDurationMs, { fallback: 8000, min: 1000, max: 60000 });

    const result = await marketingService.syncCustomerProfiles(db.pool, { resetCursor, pageSize, maxPages, maxDurationMs });
    const health = await marketingService.getMarketingHealth(db.pool);
    res.status(200).json({ success: true, ...result, health, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.logAPIError('marketing_sync', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error.message || 'Failed to sync customer profiles.' });
  }
});

router.get('/marketing/summary', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!db.pool) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Database connection required' });
  }

  try {
    const days = normalizeInteger(req.query?.days, { fallback: 90, min: 1, max: 3650 });
    const payload = await marketingService.getMarketingSummary(db.pool, { days });
    res.status(200).json({ success: true, ...payload, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.logAPIError('marketing_summary', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error.message || 'Failed to load marketing summary.' });
  }
});

router.get('/marketing/segments', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!db.pool) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Database connection required' });
  }

  try {
    const days = normalizeInteger(req.query?.days, { fallback: 90, min: 1, max: 3650 });
    const segments = await marketingService.listSegments(db.pool, { days });
    res.status(200).json({ success: true, days, count: segments.length, segments, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.logAPIError('marketing_segments', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load marketing segments.' });
  }
});

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

router.get('/marketing/segments/:segmentId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!db.pool) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Database connection required' });
  }

  const segmentId = String(req.params.segmentId || '').trim();
  try {
    const days = normalizeInteger(req.query?.days, { fallback: 90, min: 1, max: 3650 });
    const limit = normalizeInteger(req.query?.limit, { fallback: 100, min: 1, max: 500 });
    const offset = normalizeInteger(req.query?.offset, { fallback: 0, min: 0, max: 500000 });
    const format = String(req.query?.format || '').toLowerCase();

    const result = await marketingService.listSegmentCustomers(db.pool, segmentId, { days, limit, offset });
    const customers = result.customers || [];

    if (format === 'csv') {
      const headers = Object.keys(customers[0] || { customer_id: '', name: '', email: '' });
      const lines = [
        headers.join(','),
        ...customers.map((row) => headers.map((key) => csvEscape(row[key])).join(','))
      ];
      res.type('text/csv').status(200).send(lines.join('\n'));
      return;
    }

    res.status(200).json({
      success: true,
      segmentId,
      days,
      limit,
      offset,
      count: customers.length,
      customers,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.logAPIError('marketing_segment_detail', error, { segmentId });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load segment customers.' });
  }
});

// POST /admin/chat - AI-powered business intelligence chat
router.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'Message is required'
    });
  }

  // Rate limiting - simple in-memory (for production, use Redis)
  const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  try {
    // Check if service is configured
    if (!chatService.isConfigured()) {
      return res.status(503).json({
        error: 'NOT_CONFIGURED',
        message: 'AI assistant is not configured. Set OPENAI_API_KEY environment variable.'
      });
    }

    // Log the request
    logger.info({
      event: 'chat_request',
      clientIp,
      messageLength: message.length,
      historyLength: history.length
    });

    // Process chat
    const result = await chatService.chat(message.trim(), history);

    if (!result.success) {
      return res.status(500).json({
        error: result.error,
        message: result.message
      });
    }

    res.status(200).json({
      success: true,
      response: result.message,
      toolsUsed: result.toolsUsed,
      usage: result.usage
    });

  } catch (error) {
    logger.logAPIError('admin_chat', error, { messageLength: message?.length });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to process chat request'
    });
  }
});

// GET /admin/chat/status - Check if chat is configured
router.get('/chat/status', (req, res) => {
  res.json({
    configured: chatService.isConfigured(),
    features: ['sales', 'inventory', 'customers', 'compliance']
  });
});

router.get('/', (req, res) => {
  const authStatusScript = `
    async function refreshStatus() {
      const banner = document.getElementById('status-banner');
      banner.textContent = 'Loading Lightspeed status...';
      banner.className = 'banner info';

      try {
        const response = await fetch('./status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to load status');
        const status = await response.json();

        document.getElementById('env').textContent = status.environment;
        document.getElementById('mode').textContent = status.lightspeedMode;
        document.getElementById('writes').textContent = status.enableWrites ? 'enabled' : 'disabled';
        document.getElementById('status').textContent = status.status;
        document.getElementById('expires').textContent = status.accessTokenExpiresAt
          ? new Date(status.accessTokenExpiresAt).toLocaleString()
          : 'n/a';
        document.getElementById('hasRefresh').textContent = status.hasRefreshToken ? 'yes' : 'no';
        document.getElementById('timestamp').textContent = new Date(status.timestamp).toLocaleString();

        const alerts = [];
        if (status.lightspeedMode === 'mock') {
          alerts.push('Running in MOCK mode – real OAuth not active.');
        }
        if (status.status === 'needs_login') {
          alerts.push('Lightspeed login required. Click "Launch OAuth Login".');
          banner.className = 'banner warn';
        } else if (status.status === 'expiring') {
          alerts.push('Access token expiring soon. Refresh now.');
          banner.className = 'banner warn';
        } else if (status.status === 'needs_configuration') {
          alerts.push('Client ID/Secret/Redirect URI incomplete.');
          banner.className = 'banner error';
        } else if (status.status === 'ready') {
          banner.className = 'banner success';
        }

        banner.textContent = alerts.length ? alerts.join(' ') : 'Lightspeed OAuth is configured.';
      } catch (error) {
        banner.className = 'banner error';
        banner.textContent = error.message;
      }
    }

    async function forceRefresh() {
      const response = await fetch('./refresh', { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        alert(payload.message || 'Unable to refresh token.');
      }
      refreshStatus();
    }

    function launchOAuth() {
      const redirect = encodeURIComponent(window.location.href);
      window.open('/api/auth/login?redirect=' + redirect, '_blank', 'noopener');
    }

    refreshStatus();
    `;

  res.type('html').send(`< !DOCTYPE html >
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Lightspeed OAuth Admin</title>
          <style>
            body {
              font - family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0;
            padding: 24px;
            background: #111;
            color: #f5f5f5;
    }
            h1 {
              margin - bottom: 8px;
    }
            .banner {
              padding: 12px;
            border-radius: 6px;
            margin-bottom: 16px;
    }
            .banner.info {background: #1f2b3f; color: #d3e6ff; }
            .banner.success {background: #1f3f2b; color: #d3ffe6; }
            .banner.warn {background: #3f2a11; color: #ffe0b2; }
            .banner.error {background: #3f1417; color: #ffc7c9; }
            table {
              width: 100%;
            max-width: 520px;
            border-collapse: collapse;
    }
            td {
              padding: 6px 8px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
    }
            .actions {
              display: flex;
            gap: 12px;
            margin-top: 20px;
    }
            button {
              padding: 8px 14px;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            background: #0d6efd;
            color: #fff;
    }
            button.secondary {
              background: #2d2d2d;
    }
            button:hover {
              opacity: 0.9;
    }
          </style>
        </head>
        <body>
          <h1>Lightspeed OAuth Admin</h1>
          <div id="status-banner" class="banner info">Loading Lightspeed status...</div>

          <table>
            <tbody>
              <tr><td>Environment</td><td id="env">--</td></tr>
              <tr><td>Mode</td><td id="mode">--</td></tr>
              <tr><td>Writes</td><td id="writes">--</td></tr>
              <tr><td>Status</td><td id="status">--</td></tr>
              <tr><td>Has Refresh Token</td><td id="hasRefresh">--</td></tr>
              <tr><td>Access Token Expires</td><td id="expires">--</td></tr>
              <tr><td>Last Updated</td><td id="timestamp">--</td></tr>
            </tbody>
          </table>

          <div class="actions">
            <button onclick="launchOAuth()">Launch OAuth Login</button>
            <button class="secondary" onclick="forceRefresh()">Force Refresh</button>
            <button class="secondary" onclick="refreshStatus()">Reload Status</button>
          </div>

          <script>${authStatusScript}</script>
        </body>
      </html>`);
});

// --- Lightspeed Webhook Queue (admin) ---
router.get('/webhooks/health', async (req, res) => {
  try {
    if (!db.pool) {
      return res.status(503).json({
        error: 'DB_DISABLED',
        message: 'DATABASE_URL is not configured'
      });
    }
    const health = await lightspeedWebhookQueue.getWebhookQueueHealth();
    return res.status(200).json({ success: true, health });
  } catch (error) {
    logger.logAPIError('admin_webhooks_health', error);
    return res.status(500).json({ error: 'WEBHOOK_HEALTH_FAILED', message: error.message });
  }
});

router.post('/webhooks/process', async (req, res) => {
  try {
    if (!db.pool) {
      return res.status(503).json({
        error: 'DB_DISABLED',
        message: 'DATABASE_URL is not configured'
      });
    }

    const limit = Math.max(1, Math.min(Number.parseInt(req.body?.limit || '100', 10) || 100, 500));
    const maxDurationMs = Math.max(1000, Math.min(Number.parseInt(req.body?.maxDurationMs || '8000', 10) || 8000, 60000));
    const result = await lightspeedWebhookQueue.processPendingWebhookEvents({ limit, maxDurationMs });
    const health = await lightspeedWebhookQueue.getWebhookQueueHealth();
    return res.status(200).json({ success: true, ...result, health });
  } catch (error) {
    logger.logAPIError('admin_webhooks_process', error);
    return res.status(500).json({ error: 'WEBHOOK_PROCESS_FAILED', message: error.message });
  }
});

module.exports = router;
