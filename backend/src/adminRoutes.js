const express = require('express');
const lightspeed = require('./lightspeedClient');
const config = require('./config');
const db = require('./db');
const logger = require('./logger');

const router = express.Router();

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
      whereConditions.push(`outlet_id = $${paramIndex}`);
      params.push(location);
      paramIndex++;
    }

    if (status) {
      // Map status to approved field
      if (status === 'approved') {
        whereConditions.push(`approved = true`);
      } else if (status === 'rejected') {
        whereConditions.push(`approved = false`);
      } else if (status === 'pending') {
        whereConditions.push(`approved IS NULL`);
      }
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

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
        COALESCE(outlet_name, outlet_id) AS location_id,
        COALESCE(employee_name, 'Register ' || SUBSTRING(register_id, 1, 8)) AS clerk_id,
        completed_at AS created_at
      FROM scan_sessions
      ${whereClause}
      ORDER BY completed_at DESC
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

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Lightspeed OAuth Admin</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 24px;
      background: #111;
      color: #f5f5f5;
    }
    h1 {
      margin-bottom: 8px;
    }
    .banner {
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .banner.info { background: #1f2b3f; color: #d3e6ff; }
    .banner.success { background: #1f3f2b; color: #d3ffe6; }
    .banner.warn { background: #3f2a11; color: #ffe0b2; }
    .banner.error { background: #3f1417; color: #ffc7c9; }
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
