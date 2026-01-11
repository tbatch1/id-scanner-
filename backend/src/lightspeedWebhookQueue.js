const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');
const marketingService = require('./marketingService');

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeTopic(topic) {
  const raw = String(topic || '').trim();
  return raw ? raw.toLowerCase() : 'unknown';
}

function computeEventKey({ topic, rawBody }) {
  const hasher = crypto.createHash('sha256');
  hasher.update(String(topic || 'unknown'));
  hasher.update('\n');
  if (Buffer.isBuffer(rawBody)) hasher.update(rawBody);
  else hasher.update(String(rawBody || ''));
  return hasher.digest('hex');
}

function parseSignatureHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const out = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    out[key] = value;
  }
  const signature = out.signature || null;
  const algorithm = (out.algorithm || '').toUpperCase() || null;
  return signature ? { signature, algorithm } : null;
}

function timingSafeEqualStrings(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function computeHmacSha256Variants(rawBody, secret) {
  const key = Buffer.from(String(secret || ''), 'utf8');
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const h = crypto.createHmac('sha256', key).update(bodyBuf).digest();
  const hex = h.toString('hex');
  const b64 = h.toString('base64');
  const b64Url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return { hex, base64: b64, base64url: b64Url };
}

function verifyLightspeedSignature({ rawBody, xSignatureHeader, clientSecret }) {
  const parsed = parseSignatureHeader(xSignatureHeader);
  if (!parsed) {
    return { verified: false, reason: 'missing_signature_header' };
  }
  const algo = parsed.algorithm || 'HMAC-SHA256';
  if (algo !== 'HMAC-SHA256') {
    return { verified: false, reason: `unsupported_algorithm:${algo}` };
  }

  const secret = String(clientSecret || '').trim();
  if (!secret) {
    return { verified: false, reason: 'missing_client_secret' };
  }

  const variants = computeHmacSha256Variants(rawBody, secret);
  const received = String(parsed.signature || '').trim();
  const verified =
    timingSafeEqualStrings(received, variants.hex) ||
    timingSafeEqualStrings(received, variants.base64) ||
    timingSafeEqualStrings(received, variants.base64url);

  return { verified, reason: verified ? 'ok' : 'mismatch' };
}

async function ensureWebhookTables() {
  if (!db.pool) return false;
  await db.query(
    `
      CREATE TABLE IF NOT EXISTS lightspeed_webhook_events (
        id BIGSERIAL PRIMARY KEY,
        event_key TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        signature_reason TEXT,
        received_at TIMESTAMP NOT NULL DEFAULT NOW(),
        payload JSONB,
        headers JSONB,
        raw_body TEXT,
        body_bytes INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        processed_at TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        duplicate_count INTEGER NOT NULL DEFAULT 0
      )
    `
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_ls_webhooks_pending ON lightspeed_webhook_events (status, received_at)');
  return true;
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = String(key || '').toLowerCase();
    if (!k) continue;
    if (k === 'authorization' || k === 'cookie') continue;
    if (k.startsWith('x-admin') || k.startsWith('x-api')) continue;
    out[k] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return out;
}

async function enqueueWebhookEvent({
  topic,
  rawBody,
  payload,
  signatureVerified,
  signatureReason,
  headers
}) {
  if (!db.pool) return { stored: false, reason: 'db_disabled' };
  await ensureWebhookTables();

  const normalizedTopic = normalizeTopic(topic);
  const eventKey = computeEventKey({ topic: normalizedTopic, rawBody });
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const bodyBytes = bodyBuf.length;

  const shouldStoreRaw = String(process.env.LIGHTSPEED_WEBHOOK_STORE_RAW_BODY || '').trim() === 'true';
  const rawBodyText = shouldStoreRaw ? bodyBuf.toString('utf8').slice(0, DEFAULT_MAX_BODY_BYTES) : null;

  const sanitized = sanitizeHeaders(headers);

  await db.query(
    `
      INSERT INTO lightspeed_webhook_events (
        event_key, topic, signature_verified, signature_reason, payload, headers, raw_body, body_bytes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_key)
      DO UPDATE SET duplicate_count = lightspeed_webhook_events.duplicate_count + 1
    `,
    [
      eventKey,
      normalizedTopic,
      Boolean(signatureVerified),
      signatureReason || null,
      payload ? JSON.stringify(payload) : null,
      sanitized ? JSON.stringify(sanitized) : null,
      rawBodyText,
      bodyBytes
    ]
  );

  return { stored: true, eventKey };
}

async function getWebhookQueueHealth() {
  if (!db.pool) return null;
  await ensureWebhookTables();

  const { rows } = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'processing')::int as processing,
        COUNT(*) FILTER (WHERE status = 'processed')::int as processed,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
        MAX(received_at) as last_received_at,
        MAX(processed_at) as last_processed_at
      FROM lightspeed_webhook_events
    `
  );
  return rows[0] || null;
}

async function claimPendingEvents(limit = 100) {
  if (!db.pool) return [];
  await ensureWebhookTables();

  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
        SELECT id, topic, payload
        FROM lightspeed_webhook_events
        WHERE status = 'pending'
        ORDER BY received_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [normalizedLimit]
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await client.query(
        `
          UPDATE lightspeed_webhook_events
          SET status = 'processing', attempts = attempts + 1
          WHERE id = ANY($1::bigint[])
        `,
        [ids]
      );
    }
    await client.query('COMMIT');
    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      payload: r.payload || null
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markEventProcessed(id) {
  if (!db.pool) return;
  await db.query(
    `
      UPDATE lightspeed_webhook_events
      SET status = 'processed', processed_at = NOW(), last_error = NULL
      WHERE id = $1
    `,
    [id]
  );
}

async function markEventFailed(id, errorMessage) {
  if (!db.pool) return;
  await db.query(
    `
      UPDATE lightspeed_webhook_events
      SET status = 'failed', last_error = $2
      WHERE id = $1
    `,
    [id, String(errorMessage || 'unknown')]
  );
}

async function processPendingWebhookEvents({ limit = 100, maxDurationMs = 8000 } = {}) {
  if (!db.pool) {
    return { ok: false, reason: 'db_disabled', processed: 0, failed: 0 };
  }

  const start = Date.now();
  const claimed = await claimPendingEvents(limit);
  if (!claimed.length) {
    return { ok: true, processed: 0, failed: 0, didCustomerSync: false };
  }

  let processed = 0;
  let failed = 0;
  let customerUpdateCount = 0;

  for (const evt of claimed) {
    if (Date.now() - start > maxDurationMs - 750) break;
    try {
      const topic = normalizeTopic(evt.topic);
      if (topic === 'customer.update' || topic === 'customer.create') {
        customerUpdateCount += 1;
      }

      await markEventProcessed(evt.id);
      processed += 1;
    } catch (error) {
      failed += 1;
      await markEventFailed(evt.id, error.message);
    }
  }

  let didCustomerSync = false;
  if (customerUpdateCount > 0) {
    try {
      // Best-effort: keep the marketing table close to real-time without blocking webhook delivery.
      // This uses cursor-based polling under the hood and is safe to run repeatedly.
      await marketingService.syncCustomerProfiles(db.pool, { maxDurationMs: Math.max(2000, maxDurationMs - (Date.now() - start)) });
      didCustomerSync = true;
    } catch (error) {
      logger.warn({ event: 'webhook_customer_sync_failed', error: error.message }, 'Customer sync after webhook failed');
    }
  }

  return { ok: true, processed, failed, didCustomerSync };
}

module.exports = {
  safeJsonParse,
  normalizeTopic,
  verifyLightspeedSignature,
  enqueueWebhookEvent,
  ensureWebhookTables,
  getWebhookQueueHealth,
  processPendingWebhookEvents
};

