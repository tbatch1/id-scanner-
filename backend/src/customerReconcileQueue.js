const db = require('./db');
const logger = require('./logger');
const lightspeed = require('./lightspeedClient');

async function ensureTables() {
  if (!db.pool) return false;

  await db.query(
    `
      CREATE TABLE IF NOT EXISTS customer_reconcile_jobs (
        id BIGSERIAL PRIMARY KEY,
        sale_id TEXT UNIQUE NOT NULL,
        resolved_sale_id TEXT,
        verification_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_error TEXT,
        fields JSONB,
        register_id TEXT,
        outlet_id TEXT,
        sale_total NUMERIC,
        last_customer_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `
  );
  // Backward-compatible: add columns if the table already existed.
  await db.query('ALTER TABLE customer_reconcile_jobs ADD COLUMN IF NOT EXISTS resolved_sale_id TEXT');
  await db.query('ALTER TABLE customer_reconcile_jobs ADD COLUMN IF NOT EXISTS register_id TEXT');
  await db.query('ALTER TABLE customer_reconcile_jobs ADD COLUMN IF NOT EXISTS outlet_id TEXT');
  await db.query('ALTER TABLE customer_reconcile_jobs ADD COLUMN IF NOT EXISTS sale_total NUMERIC');
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_customer_reconcile_due ON customer_reconcile_jobs (status, next_attempt_at)'
  );
  return true;
}

function computeBackoffMs(attempts) {
  const n = Math.max(1, Number.parseInt(attempts, 10) || 1);
  const scheduleSec = [5, 8, 15, 25, 45, 90, 180, 600, 1800, 7200];
  const idx = Math.min(scheduleSec.length - 1, n - 1);
  return scheduleSec[idx] * 1000;
}

async function enqueueJob({
  saleId,
  resolvedSaleId = null,
  verificationId = null,
  fields = null,
  registerId = null,
  outletId = null,
  saleTotal = null,
  delayMs = 5000
}) {
  if (!db.pool) return { queued: false, reason: 'db_disabled' };
  await ensureTables();

  const id = String(saleId || '').trim();
  if (!id) return { queued: false, reason: 'missing_sale_id' };

  const resolved = String(resolvedSaleId || '').trim() || null;
  const rid = String(registerId || '').trim() || null;
  const oid = String(outletId || '').trim() || null;
  const total = Number.isFinite(Number(saleTotal)) ? Math.round(Number(saleTotal) * 100) / 100 : null;

  const nextAttemptAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0));
  const payload = fields ? JSON.stringify(fields) : null;

  await db.query(
    `
      INSERT INTO customer_reconcile_jobs (sale_id, resolved_sale_id, verification_id, status, next_attempt_at, fields, register_id, outlet_id, sale_total)
      VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
      ON CONFLICT (sale_id)
      DO UPDATE SET
        resolved_sale_id = COALESCE(EXCLUDED.resolved_sale_id, customer_reconcile_jobs.resolved_sale_id),
        verification_id = COALESCE(EXCLUDED.verification_id, customer_reconcile_jobs.verification_id),
        status = CASE
          WHEN customer_reconcile_jobs.status = 'done' THEN 'pending'
          WHEN customer_reconcile_jobs.status = 'failed' THEN 'pending'
          ELSE customer_reconcile_jobs.status
        END,
        next_attempt_at = LEAST(EXCLUDED.next_attempt_at, customer_reconcile_jobs.next_attempt_at),
        fields = COALESCE(EXCLUDED.fields, customer_reconcile_jobs.fields),
        register_id = COALESCE(EXCLUDED.register_id, customer_reconcile_jobs.register_id),
        outlet_id = COALESCE(EXCLUDED.outlet_id, customer_reconcile_jobs.outlet_id),
        sale_total = COALESCE(EXCLUDED.sale_total, customer_reconcile_jobs.sale_total),
        updated_at = NOW()
    `,
    [id, resolved, verificationId, nextAttemptAt, payload, rid, oid, total]
  );

  return { queued: true, saleId: id, nextAttemptAt: nextAttemptAt.toISOString() };
}

async function claimDueJobs(limit = 100) {
  if (!db.pool) return [];
  await ensureTables();

  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
        SELECT id, sale_id, resolved_sale_id, verification_id, attempts, fields, register_id, outlet_id, sale_total
        FROM customer_reconcile_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [normalizedLimit]
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await client.query(
        `
          UPDATE customer_reconcile_jobs
          SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
          WHERE id = ANY($1::bigint[])
        `,
        [ids]
      );
    }
    await client.query('COMMIT');
    return rows.map((r) => ({
      id: r.id,
      saleId: r.sale_id,
      resolvedSaleId: r.resolved_sale_id || null,
      verificationId: r.verification_id || null,
      attempts: Number(r.attempts || 0),
      fields: r.fields || null,
      registerId: r.register_id || null,
      outletId: r.outlet_id || null,
      saleTotal: r.sale_total !== null && r.sale_total !== undefined ? Number(r.sale_total) : null
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rescheduleJob(id, attempts, errorMessage) {
  if (!db.pool) return;
  const backoffMs = computeBackoffMs(attempts);
  const nextAttemptAt = new Date(Date.now() + backoffMs);
  await db.query(
    `
      UPDATE customer_reconcile_jobs
      SET status = 'pending',
          next_attempt_at = $2,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, nextAttemptAt, String(errorMessage || 'pending')]
  );
}

async function setResolvedSaleId(id, resolvedSaleId) {
  if (!db.pool) return;
  const rid = String(resolvedSaleId || '').trim();
  if (!rid) return;
  await db.query(
    `
      UPDATE customer_reconcile_jobs
      SET resolved_sale_id = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [id, rid]
  );
}

async function markDone(id, { customerId = null } = {}) {
  if (!db.pool) return;
  await db.query(
    `
      UPDATE customer_reconcile_jobs
      SET status = 'done',
          completed_at = NOW(),
          last_error = NULL,
          last_customer_id = $2,
          fields = NULL,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, customerId]
  );
}

async function markFailed(id, errorMessage) {
  if (!db.pool) return;
  await db.query(
    `
      UPDATE customer_reconcile_jobs
      SET status = 'failed',
          last_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, String(errorMessage || 'failed')]
  );
}

function safeParseJson(value) {
  try {
    if (!value) return null;
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function chooseBestSaleCandidate(candidates, { saleTotal = null } = {}) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  if (!list.length) return null;

  const normalizedTotal = Number.isFinite(Number(saleTotal)) ? Math.round(Number(saleTotal) * 100) / 100 : null;

  let filtered = list;
  if (normalizedTotal !== null) {
    // Prefer candidates with matching totals (tolerance for rounding).
    const tolerance = 0.02;
    const matches = list.filter((s) => Number.isFinite(Number(s.total)) && Math.abs(Number(s.total) - normalizedTotal) <= tolerance);
    if (matches.length) filtered = matches;
  }

  filtered.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  return filtered[0] || null;
}

async function processDueJobs({ limit = 100, maxDurationMs = 8000 } = {}) {
  if (!db.pool) return { ok: false, reason: 'db_disabled', processed: 0, pending: 0, failed: 0 };

  const start = Date.now();
  const claimed = await claimDueJobs(limit);
  if (!claimed.length) {
    return { ok: true, processed: 0, pending: 0, failed: 0 };
  }

  let processed = 0;
  let pending = 0;
  let failed = 0;

  for (const job of claimed) {
    if (Date.now() - start > maxDurationMs - 750) break;

    const attempts = Number(job.attempts || 0) + 1;
    const fields = safeParseJson(job.fields) || null;

    try {
      if (!fields || typeof fields !== 'object') {
        await markFailed(job.id, 'missing_fields');
        failed += 1;
        continue;
      }

      const registerId = String(job.registerId || '').trim();
      const outletId = String(job.outletId || '').trim();
      const saleTotal = Number.isFinite(Number(job.saleTotal)) ? Number(job.saleTotal) : null;

      let sale = null;
      let effectiveSaleId = String(job.resolvedSaleId || job.saleId || '').trim();

      const tryFetchSaleById = async (id) => {
        const sid = String(id || '').trim();
        if (!sid) return null;
        try {
          const fetched = await lightspeed.getSaleById(sid);
          if (fetched?.saleId && fetched.saleId !== job.resolvedSaleId) {
            await setResolvedSaleId(job.id, fetched.saleId);
          }
          return fetched;
        } catch (e) {
          if (String(e?.message || '').toUpperCase() === 'SALE_NOT_FOUND') return null;
          throw e;
        }
      };

      // 1) If we already have a resolved Retail sale id, fetch it directly.
      if (job.resolvedSaleId) {
        sale = await tryFetchSaleById(job.resolvedSaleId);
      }

      // 2) Try fetching by the original id (sometimes it *is* a Retail sale id).
      if (!sale && job.saleId) {
        sale = await tryFetchSaleById(job.saleId);
      }

      // 3) Fallback: resolve via register_id (common when iframe provides a gateway/register_sale id).
      if (!sale && registerId && typeof lightspeed.listSales === 'function') {
        const candidates = await lightspeed.listSales({
          status: 'OPEN',
          limit: 50,
          registerId,
          outletId: outletId || null
        });
        const best = chooseBestSaleCandidate(candidates, { saleTotal });
        if (best?.saleId) {
          effectiveSaleId = String(best.saleId).trim();
          await setResolvedSaleId(job.id, effectiveSaleId);
          sale = best;
        }
      }

      if (!sale) {
        await rescheduleJob(job.id, attempts, 'sale_unresolved');
        pending += 1;
        continue;
      }

      const customerId = String(sale?.customerId || '').trim();
      if (!customerId) {
        await rescheduleJob(job.id, attempts, 'customer_not_attached_yet');
        pending += 1;
        continue;
      }

      const result = await lightspeed.updateCustomerById(customerId, fields, { fillBlanksOnly: true });
      if (result?.updated || result?.skipped === 'no_blank_fields') {
        await markDone(job.id, { customerId });
        processed += 1;
        continue;
      }

      if (result?.skipped === 'writes_disabled') {
        await markFailed(job.id, 'writes_disabled');
        failed += 1;
        continue;
      }

      const status = Number(result?.status || 0);
      if (status === 401 || status === 403) {
        await markFailed(job.id, `auth_failed:${status}`);
        failed += 1;
        continue;
      }

      await rescheduleJob(job.id, attempts, result?.error || `customer_update_failed:${status || 'unknown'}`);
      pending += 1;
    } catch (error) {
      logger.error(
        { event: 'customer_reconcile_job_failed', saleId: job.saleId, error: error.message },
        'Customer reconcile job failed'
      );
      await rescheduleJob(job.id, attempts, error.message);
      pending += 1;
    }
  }

  return { ok: true, processed, pending, failed };
}

async function getHealth() {
  if (!db.pool) return null;
  await ensureTables();
  const { rows } = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'processing')::int as processing,
        COUNT(*) FILTER (WHERE status = 'done')::int as done,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
        MIN(next_attempt_at) FILTER (WHERE status = 'pending') as next_due_at,
        MAX(updated_at) as last_updated_at
      FROM customer_reconcile_jobs
    `
  );
  return rows?.[0] || null;
}

async function cleanup({ doneDays = 3, pendingDays = 2 } = {}) {
  if (!db.pool) return { ok: false, reason: 'db_disabled' };
  await ensureTables();

  const done = Math.max(1, Math.min(Number.parseInt(doneDays, 10) || 3, 30));
  const pending = Math.max(1, Math.min(Number.parseInt(pendingDays, 10) || 2, 30));

  const { rows } = await db.query(
    `
      WITH deleted AS (
        DELETE FROM customer_reconcile_jobs
        WHERE
          (status = 'done' AND completed_at < NOW() - ($1 || ' days')::interval)
          OR (status IN ('pending','failed') AND created_at < NOW() - ($2 || ' days')::interval)
        RETURNING 1
      )
      SELECT COUNT(*)::int as deleted FROM deleted
    `,
    [done, pending]
  );
  return { ok: true, deleted: rows?.[0]?.deleted ?? 0, doneDays: done, pendingDays: pending };
}

module.exports = {
  enqueueJob,
  processDueJobs,
  getHealth,
  cleanup
};

