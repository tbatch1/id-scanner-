/**
 * Sale Verification Store
 *
 * In-memory storage for Lightspeed POS sale verification requests
 * Handles the request-response flow between payment-gateway.html and scanner.html
 *
 * Flow:
 * 1. payment-gateway.html creates pending verification (Lightspeed iframe)
 * 2. scanner.html scans ID and submits result (PWA app)
 * 3. payment-gateway.html polls for status and displays result
 * 4. payment-gateway.html sends unlock to Lightspeed
 */

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
}, 5 * 60 * 1000); // Run every 5 minutes

/**
 * Create a new pending verification
 * Called when payment-gateway.html loads (Lightspeed button clicked)
 */
function createVerification(saleId, { registerId = null } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

  const verification = {
    saleId,
    status: 'pending',
    customerId: null,
    customerName: null,
    age: null,
    reason: null,
    registerId,
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
 * Update verification with scan result
 * Called by scanner.html after ID scan
 */
function updateVerification(saleId, {
  approved,
  customerId = null,
  customerName = null,
  age = null,
  reason = null,
  registerId = null
}) {
  const verification = verifications.get(saleId);

  if (!verification) {
    logger.warn({
      event: 'verification_not_found',
      saleId
    }, `Attempted to update non-existent verification: ${saleId}`);
    return null;
  }

  // Check if expired
  if (verification.expiresAt < new Date()) {
    verifications.delete(saleId);
    logger.warn({
      event: 'verification_expired_on_update',
      saleId
    }, `Attempted to update expired verification: ${saleId}`);
    return null;
  }

  // Update verification
  verification.status = approved ? 'approved' : 'rejected';
  verification.customerId = customerId;
  verification.customerName = customerName;
  verification.age = age;
  verification.reason = reason;
  verification.registerId = registerId || verification.registerId;
  verification.updatedAt = new Date();

  logger.info({
    event: 'verification_updated',
    saleId,
    status: verification.status,
    customerId,
    age,
    reason
  }, `Sale verification updated: ${saleId} - ${verification.status}`);

  return verification;
}

/**
 * Get verification status
 * Called by payment-gateway.html (polling)
 */
function getVerification(saleId) {
  const verification = verifications.get(saleId);

  if (!verification) {
    return null;
  }

  // Check if expired
  if (verification.expiresAt < new Date()) {
    verifications.delete(saleId);
    logger.info({
      event: 'verification_expired_on_get',
      saleId
    }, `Verification expired on retrieval: ${saleId}`);
    return null;
  }

  return verification;
}

/**
 * Mark verification as completed
 * Called by payment-gateway.html after sending unlock to Lightspeed
 */
function completeVerification(saleId) {
  const verification = verifications.get(saleId);

  if (!verification) {
    logger.warn({
      event: 'verification_complete_not_found',
      saleId
    }, `Attempted to complete non-existent verification: ${saleId}`);
    return false;
  }

  // Remove from store
  verifications.delete(saleId);

  logger.info({
    event: 'verification_completed',
    saleId,
    status: verification.status,
    duration: Math.round((new Date() - verification.createdAt) / 1000)
  }, `Sale verification completed and removed: ${saleId}`);

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
    expired: 0
  };

  for (const verification of verifications.values()) {
    if (verification.expiresAt < now) {
      stats.expired++;
    } else {
      stats[verification.status]++;
    }
  }

  return stats;
}

module.exports = {
  createVerification,
  updateVerification,
  getVerification,
  completeVerification,
  getStats
};
