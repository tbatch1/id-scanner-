const express = require('express');
const lightspeed = require('./lightspeedClient');
const config = require('./config');
const db = require('./db');
const logger = require('./logger');

const router = express.Router();

function parseIdCheckNote(note) {
  const raw = (note || '').toString();
  if (!raw.trim()) return { hasIdNote: false };

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mostRecent = [...lines].reverse().find((line) => /^(ID Check|ID Verified)/i.test(line)) || null;
  if (!mostRecent) return { hasIdNote: false };

  const statusMatch = mostRecent.match(/ID\s+(?:Check|Verified)\s+(APPROVED|REJECTED)/i);
  const status = statusMatch ? statusMatch[1].toUpperCase() : null;

  const ageMatch = mostRecent.match(/\bAge\s+(\d{1,3})\b/i);
  const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

  const dobYearMatch = mostRecent.match(/\bDOB\s+(\d{4})\b/i);
  const dobYear = dobYearMatch ? dobYearMatch[1] : null;

  return {
    hasIdNote: true,
    noteLine: mostRecent,
    noteStatus: status,
    noteAge: Number.isFinite(age) ? age : null,
    noteDobYear: dobYear
  };
}

function buildAuthStatus() {
  const baseState =
    typeof lightspeed.getAuthState === 'function'
      ? lightspeed.getAuthState()
      : { status: 'unknown' };

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

router.get('/status', (req, res) => {
  res.json(buildAuthStatus());
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
    res.status(200).json(buildAuthStatus());
  } catch (error) {
    res.status(500).json({
      error: 'REFRESH_FAILED',
      message: error.message
    });
  }
});

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
  if (!db.pool) {
    if (typeof lightspeed.listVerifications === 'function') {
      const { location, status, limit = 100, offset = 0 } = req.query;
      const scans = lightspeed.listVerifications({
        location: location || undefined,
        status: status || undefined,
        limit,
        offset
      });

      return res.status(200).json({
        success: true,
        count: scans.length,
        scans
      });
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

    res.status(200).json({
      success: true,
      count: result.rows.length,
      scans: result.rows
    });
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
  const { status = 'ALL', limit = 50 } = req.query || {};
  const normalizedStatus = String(status || 'ALL').toUpperCase();
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));

  try {
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

          if (normalizedStatus !== 'ALL' && sale?.status && sale.status !== normalizedStatus) {
            continue;
          }

          const saleFetchOk = Boolean(sale);
          const noteInfo = saleFetchOk ? parseIdCheckNote(sale.note) : { hasIdNote: false };
          const verifiedApproved = String(row.verification_status || '').startsWith('approved');
          enriched.push({
            sale_id: row.sale_id,
            verification_id: row.verification_id,
            total: sale?.total ?? null,
            status: sale?.status ?? null,
            outlet_id: sale?.outletId ?? null,
            register_id: sale?.registerId ?? null,
            user_id: sale?.userId ?? null,
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
          });
        }
      }

      const missingNotes = enriched.filter((t) => t.missingNote === true);
      const saleFetchErrorCount = enriched.filter((t) => t.saleFetchOk === false).length;
      return res.status(200).json({
        success: true,
        status: normalizedStatus,
        limit: normalizedLimit,
        count: enriched.length,
        missingNoteCount: missingNotes.length,
        missingVerificationCount: 0,
        saleFetchErrorCount,
        transactions: enriched
      });
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
        register_id: sale?.registerId ?? null,
        user_id: sale?.userId ?? null,
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

    const missingNotes = enriched.filter((t) => t.missingNote === true);
    res.status(200).json({
      success: true,
      status: normalizedStatus,
      limit: normalizedLimit,
      count: enriched.length,
      missingNoteCount: missingNotes.length,
      missingVerificationCount: enriched.filter((t) => t.missingVerification).length,
      transactions: enriched
    });
  } catch (error) {
    logger.logAPIError('admin_transactions', error, { status });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve transactions'
    });
  }
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

module.exports = router;
