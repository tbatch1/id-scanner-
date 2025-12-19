const logger = require('./logger');

/**
 * In-memory store for sale verifications
 * Key: saleId (from Lightspeed)
 * Value: {
 *   saleId: string,
 *   status: 'pending' | 'approved' | 'rejected',
 *   customerId: string | null,
 *   customerName: string | null,
 *   age: number | null,
 *   reason: string | null,
 *   registerId: string | null,
 *   remoteScannerActive: boolean, // Friendship: Is the handheld scanner page open?
 *   lastHeartbeat: Date | null,   // Friendship: When did the handheld last check in?
 *   logs: Array,                 // Friendship Trace: Activity log for dev troubleshooting
 *   createdAt: Date,
 *   updatedAt: Date,
 *   expiresAt: Date (15 minutes from creation)
 * }
 */
const verifications = new Map();

// Auto-cleanup expired verifications every 5 minutes
setInterval(() => {
  const now = new Date();
  let expiredCount = 0;

  for (const [saleId, verification] of verifications.entries()) {
    if (verification.expiresAt < now) {
      verifications.delete(saleId);
      expiredCount++;

      logger.info({
        event: 'verification_expired',
        saleId,
        status: verification.status,
        age: Math.round((now - verification.createdAt) / 1000)
      }, `Sale verification expired: ${saleId}`);
    }
  }

  if (expiredCount > 0) {
    logger.info({
      event: 'verification_cleanup',
      expired: expiredCount,
      remaining: verifications.size
    }, `Cleaned up ${expiredCount} expired verifications`);
  }
}, 5 * 60 * 1000);

/**
 * Create a new pending verification
 */
function createVerification(saleId, { registerId = null } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

  const verification = {
    saleId,
    status: 'pending',
    customerId: null,
    customerName: null,
    age: null,
    reason: null,
    registerId,
    remoteScannerActive: false,
    lastHeartbeat: null,
    logs: [{ t: now, m: 'IDLE: Waiting for handheld connection...', type: 'info' }],
    createdAt: now,
    updatedAt: now,
    expiresAt
  };

  verifications.set(saleId, verification);

  logger.info({
    event: 'verification_created',
    saleId,
    registerId,
    expiresAt
  }, `Sale verification created: ${saleId}`);

  return verification;
}

/**
 * Update the handheld heartbeat / active state
 */
function updateHeartbeat(saleId) {
  const verification = verifications.get(saleId);
  if (!verification) return null;

  const now = new Date();
  if (!verification.remoteScannerActive) {
    verification.logs.push({ t: now, m: 'HANDSHAKE: Handheld scanner connected', type: 'success' });
  }

  verification.remoteScannerActive = true;
  verification.lastHeartbeat = now;
  verification.updatedAt = now;
  return verification;
}

/**
 * Add a log entry for dev troubleshooting
 */
function addSessionLog(saleId, message, type = 'info') {
  const verification = verifications.get(saleId);
  if (!verification) return;

  verification.logs.push({
    t: new Date(),
    m: message,
    type
  });

  // Keep logs manageable
  if (verification.logs.length > 50) {
    verification.logs.shift();
  }
}

/**
 * Update verification with scan result
 */
function updateVerification(saleId, {
  approved,
  customerId = null,
  customerName = null,
  age = null,
  reason = null,
  registerId = null,
  status = null
}) {

  const verification = verifications.get(saleId);

  if (!verification) {
    logger.warn({ event: 'verification_not_found', saleId }, `Attempted update non-existent: ${saleId}`);
    return null;
  }

  if (verification.expiresAt < new Date()) {
    verifications.delete(saleId);
    return null;
  }

  // Use explicit status if provided, otherwise derive from 'approved' boolean
  verification.status = status || (approved ? 'approved' : 'rejected');
  verification.customerId = customerId;
  verification.customerName = customerName;
  verification.age = age;
  verification.reason = reason;
  verification.registerId = registerId || verification.registerId;
  verification.updatedAt = new Date();

  addSessionLog(saleId, `RESULT: Scan ${approved ? 'Approved' : 'Rejected'} (${reason || 'OK'})`, approved ? 'success' : 'error');

  logger.info({
    event: 'verification_updated',
    saleId,
    status: verification.status,
    customerId,
    age
  }, `Sale verification updated: ${saleId} - ${verification.status}`);

  return verification;
}

/**
 * Get verification status (includes friendship metadata)
 */
function getVerification(saleId) {
  const verification = verifications.get(saleId);
  if (!verification) return null;

  if (verification.expiresAt < new Date()) {
    verifications.delete(saleId);
    return null;
  }

  // Auto-detect if handheld dropped offline (no heartbeat for 10s)
  if (verification.remoteScannerActive && verification.lastHeartbeat) {
    const elapsed = new Date() - verification.lastHeartbeat;
    if (elapsed > 10000) {
      verification.remoteScannerActive = false;
      addSessionLog(saleId, 'DISCONNECT: Handheld scanner timed out', 'error');
    }
  }

  return verification;
}

/**
 * Mark verification as completed
 */
function completeVerification(saleId) {
  const verification = verifications.get(saleId);
  if (!verification) return false;

  verifications.delete(saleId);

  logger.info({
    event: 'verification_completed',
    saleId,
    status: verification.status
  }, `Sale verification completed/removed: ${saleId}`);

  return true;
}

/**
 * Get statistics for monitoring
 */
function getStats() {
  const now = new Date();
  const stats = {
    total: verifications.size,
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    activeRemoteScanners: 0
  };

  for (const verification of verifications.values()) {
    if (verification.expiresAt < now) {
      stats.expired++;
    } else {
      stats[verification.status]++;
      if (verification.remoteScannerActive) stats.activeRemoteScanners++;
    }
  }

  return stats;
}

module.exports = {
  createVerification,
  updateVerification,
  getVerification,
  completeVerification,
  updateHeartbeat,
  addSessionLog,
  getStats
};
