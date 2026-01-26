const logger = require('./logger');
const lightspeed = require('./lightspeedClient');
const saleVerificationStore = require('./saleVerificationStore');

const DEFAULT_MAX_WAIT_MS = Math.max(
  10_000,
  Math.min(5 * 60 * 1000, Number.parseInt(process.env.CUSTOMER_FILL_MAX_WAIT_MS || '60000', 10) || 60000)
);

const DEFAULT_POLL_INTERVAL_MS = Math.max(
  500,
  Math.min(10_000, Number.parseInt(process.env.CUSTOMER_FILL_POLL_INTERVAL_MS || '2000', 10) || 2000)
);

const DEFAULT_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(50, Number.parseInt(process.env.CUSTOMER_FILL_MAX_ATTEMPTS || '25', 10) || 25)
);

function nowMs() {
  return Date.now();
}

function shouldRetryStatus(status) {
  const n = Number(status || 0);
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(n);
}

function backoffMs(attempts) {
  const n = Math.max(1, Number.parseInt(attempts, 10) || 1);
  const base = DEFAULT_POLL_INTERVAL_MS;
  const factor = Math.min(8, Math.pow(1.35, n - 1));
  return Math.min(30_000, Math.round(base * factor));
}

function isLoyaltyEnabled(customer) {
  if (!customer) return false;
  if (customer.enable_loyalty === true) return true;
  if (customer.enableLoyalty === true) return true;
  if (customer.loyaltyEnabled === true) return true;
  if (Number.isFinite(Number(customer.loyaltyBalance))) return true;
  return false;
}

const jobs = new Map(); // key: saleId
let processorTimer = null;
let processing = false;

function getJob(saleId) {
  const key = String(saleId || '').trim();
  if (!key) return null;
  return jobs.get(key) || null;
}

function upsertJob(saleId, next) {
  const key = String(saleId || '').trim();
  if (!key) return null;
  jobs.set(key, next);
  return next;
}

function startProcessor() {
  if (processorTimer) return;
  processorTimer = setInterval(() => {
    void processDueJobs().catch(() => {});
  }, 750);
  processorTimer.unref?.();
}

async function processOne(job) {
  const saleId = job.saleId;
  const startedAt = nowMs();

  const nextAttempt = Number(job.attempts || 0) + 1;
  job.attempts = nextAttempt;
  job.updatedAt = new Date().toISOString();

  if (nextAttempt === 1) {
    saleVerificationStore.addSessionLog(saleId, 'LOADER: Queued customer profile fill', 'info');
  }

  // 1) Fetch sale until customer attaches.
  if (!job.customerId) {
    if (typeof lightspeed.getSaleById !== 'function') {
      job.status = 'failed';
      job.lastError = 'lightspeed_get_sale_not_supported';
      saleVerificationStore.addSessionLog(saleId, 'LOADER: Lightspeed getSaleById not available', 'error');
      return job;
    }

    try {
      const sale = await lightspeed.getSaleById(saleId);
      const customerId = sale?.customerId ? String(sale.customerId).trim() : '';
      if (customerId) {
        job.customerId = customerId;
        saleVerificationStore.addSessionLog(saleId, `LOADER: Loyalty customer attached (${customerId})`, 'info');
      } else {
        job.status = 'waiting_for_customer';
        saleVerificationStore.addSessionLog(saleId, 'LOADER: Waiting for loyalty customer attach...', 'warn');
      }
    } catch (error) {
      job.status = 'waiting_for_customer';
      job.lastError = error?.message || 'sale_fetch_failed';
      saleVerificationStore.addSessionLog(saleId, `LOADER: Sale fetch failed (${job.lastError})`, 'warn');
    }
  }

  // 2) Once customer attached, gate on loyalty flag.
  if (job.customerId && job.status !== 'done') {
    if (typeof lightspeed.getCustomerById !== 'function') {
      job.status = 'failed';
      job.lastError = 'lightspeed_get_customer_not_supported';
      saleVerificationStore.addSessionLog(saleId, 'LOADER: Lightspeed getCustomerById not available', 'error');
      return job;
    }

    let customer = null;
    try {
      customer = await lightspeed.getCustomerById(job.customerId);
    } catch (error) {
      customer = null;
      job.lastError = error?.message || 'customer_fetch_failed';
    }

    if (!isLoyaltyEnabled(customer)) {
      job.status = 'skipped_not_loyalty';
      job.lastError = null;
      job.completedAt = new Date().toISOString();
      job.fields = null;
      saleVerificationStore.addSessionLog(saleId, 'LOADER: Skipped (customer is not a loyalty member)', 'warn');
      return job;
    }

    // 3) Update customer fields (fill blanks only).
    if (typeof lightspeed.updateCustomerById !== 'function') {
      job.status = 'failed';
      job.lastError = 'lightspeed_update_customer_not_supported';
      saleVerificationStore.addSessionLog(saleId, 'LOADER: Lightspeed updateCustomerById not available', 'error');
      return job;
    }

    const payload = job.fields && typeof job.fields === 'object' ? job.fields : {};
    const filledKeys = Object.entries(payload)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim().length)
      .map(([key]) => key);
    saleVerificationStore.addSessionLog(
      saleId,
      `LOADER: Prepared ${filledKeys.length} field(s) for update`,
      filledKeys.length ? 'info' : 'warn'
    );

    saleVerificationStore.addSessionLog(saleId, `LOADER: Updating customer fields (${job.customerId})...`, 'info');
    const result = await lightspeed.updateCustomerById(job.customerId, payload, { fillBlanksOnly: true });
    if (result?.updated) {
      job.status = 'done';
      job.updatedFields = Array.isArray(result.fields) ? result.fields : [];
      job.lastError = null;
      job.completedAt = new Date().toISOString();
      job.fields = null;
      saleVerificationStore.addSessionLog(
        saleId,
        `LOADER: Customer updated (${job.updatedFields.length} field(s))`,
        'success'
      );
      return job;
    }

    const skipped = result?.skipped || 'no_changes';
    const status = result?.status || null;
    if (shouldRetryStatus(status)) {
      job.status = 'retrying';
      job.lastError = `retryable_status_${status}`;
      saleVerificationStore.addSessionLog(saleId, `LOADER: Retryable update failure (${status})`, 'warn');
      return job;
    }

    job.status = 'done';
    job.updatedFields = [];
    job.lastError = skipped;
    job.completedAt = new Date().toISOString();
    job.fields = null;
    saleVerificationStore.addSessionLog(saleId, `LOADER: Customer update skipped (${skipped})`, 'info');
  }

  job.lastRunMs = nowMs() - startedAt;
  return job;
}

async function processDueJobs() {
  if (processing) return;
  processing = true;
  try {
    const due = [];
    const now = nowMs();
    for (const job of jobs.values()) {
      if (!job) continue;
      if (job.status === 'done' || job.status === 'failed' || job.status === 'skipped_not_loyalty') continue;
      if (job.nextAttemptAtMs && job.nextAttemptAtMs > now) continue;
      due.push(job);
    }

    // Keep concurrency small.
    const batch = due.slice(0, 3);
    for (const job of batch) {
      const maxWaitMs = Number.isFinite(Number(job.maxWaitMs)) ? Number(job.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
      const ageMs = now - job.createdAtMs;
      if (ageMs > maxWaitMs || job.attempts >= DEFAULT_MAX_ATTEMPTS) {
        job.status = 'failed';
        job.lastError = ageMs > maxWaitMs ? 'timeout_waiting_for_customer' : 'max_attempts_reached';
        job.completedAt = new Date().toISOString();
        job.fields = null;
        saleVerificationStore.addSessionLog(job.saleId, `LOADER: Failed (${job.lastError})`, 'error');
        continue;
      }

      try {
        await processOne(job);
      } catch (error) {
        job.status = 'retrying';
        job.lastError = error?.message || 'loader_failed';
        saleVerificationStore.addSessionLog(job.saleId, `LOADER: Error (${job.lastError})`, 'warn');
      } finally {
        const delay = backoffMs(job.attempts);
        job.nextAttemptAtMs = nowMs() + delay;
        job.updatedAt = new Date().toISOString();
        upsertJob(job.saleId, job);
      }
    }

    // Cleanup finished jobs after a while (keeps memory bounded).
    const cleanupTtlMs = 15 * 60 * 1000;
    for (const [saleId, job] of jobs.entries()) {
      if (!job?.completedAt) continue;
      const doneMs = new Date(job.completedAt).getTime();
      if (Number.isFinite(doneMs) && now - doneMs > cleanupTtlMs) {
        jobs.delete(saleId);
      }
    }
  } finally {
    processing = false;
  }
}

function enqueueCustomerFill({
  saleId,
  fields,
  maxWaitMs = DEFAULT_MAX_WAIT_MS
} = {}) {
  const id = String(saleId || '').trim();
  if (!id) return { queued: false, reason: 'missing_sale_id' };
  if (!fields || typeof fields !== 'object') return { queued: false, reason: 'missing_fields' };

  const existing = getJob(id);
  const now = new Date().toISOString();
  const terminal = existing && ['done', 'failed', 'skipped_not_loyalty'].includes(String(existing.status || ''));
  const createdAtMs = terminal || !existing?.createdAtMs ? nowMs() : existing.createdAtMs;
  const createdAt = terminal || !existing?.createdAt ? now : existing.createdAt;

  const next = {
    saleId: id,
    status: !existing || terminal ? 'pending' : existing.status,
    attempts: terminal ? 0 : (existing?.attempts || 0),
    customerId: terminal ? null : (existing?.customerId || null),
    fields,
    updatedFields: [],
    lastError: null,
    createdAt,
    createdAtMs,
    updatedAt: now,
    completedAt: null,
    nextAttemptAtMs: nowMs(),
    maxWaitMs
  };

  upsertJob(id, next);
  startProcessor();

  logger.info({ event: 'customer_fill_enqueued', saleId: id }, 'Customer fill job queued');
  return { queued: true, saleId: id };
}

module.exports = {
  enqueueCustomerFill,
  getJob
};
