const express = require('express');
const config = require('./config');
const lightspeed = require('./lightspeedClient');

const router = express.Router();

const millisecondsPerMinute = 60 * 1000;

function isVerificationExpired(verification) {
  if (!verification) {
    return true;
  }

  const expiryWindow = config.verificationExpiryMinutes * millisecondsPerMinute;
  const verifiedAt = new Date(verification.createdAt).getTime();
  const now = Date.now();

  return now - verifiedAt > expiryWindow;
}

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: config.env,
    timestamp: new Date().toISOString()
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

router.get('/sales', (req, res) => {
  res.json({
    data: lightspeed.listSales()
  });
});

router.get('/sales/:saleId', (req, res) => {
  const sale = lightspeed.getSaleById(req.params.saleId);
  if (!sale) {
    return res.status(404).json({
      error: 'SALE_NOT_FOUND',
      message: 'Sale not found in mock store. Seed new sales in mockLightspeedClient.js'
    });
  }

  const expired = isVerificationExpired(sale.verification);

  res.json({
    data: {
      ...sale,
      verificationExpired: expired
    }
  });
});

router.post('/sales/:saleId/verify', (req, res) => {
  const { clerkId, scan } = req.body || {};

  if (!clerkId) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'clerkId is required.'
    });
  }

  if (!scan || typeof scan.approved !== 'boolean') {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'scan.approved boolean flag is required.'
    });
  }

  try {
    const verification = lightspeed.recordVerification({
      saleId: req.params.saleId,
      clerkId,
      verificationData: {
        approved: scan.approved,
        reason: scan.reason,
        firstName: scan.firstName,
        lastName: scan.lastName,
        dob: scan.dob,
        age: scan.age
      }
    });

    res.status(201).json({
      data: verification
    });
  } catch (error) {
    const status = error.message === 'SALE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({
      error: error.message,
      message: status === 404 ? 'Sale not found.' : 'Unable to record verification.'
    });
  }
});

router.post('/sales/:saleId/complete', async (req, res) => {
  const { verificationId, paymentType } = req.body || {};

  if (!verificationId) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'verificationId is required.'
    });
  }

  if (!paymentType || !['cash', 'card'].includes(paymentType)) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'paymentType is required and must be either "cash" or "card".'
    });
  }

  try {
    const sale = await lightspeed.getSaleById(req.params.saleId);
    if (!sale) {
      return res.status(404).json({
        error: 'SALE_NOT_FOUND',
        message: 'Sale not found.'
      });
    }

    if (!sale.verification || sale.verification.verificationId !== verificationId) {
      return res.status(409).json({
        error: 'VERIFICATION_MISMATCH',
        message: 'Verification ID does not match the latest verification for this sale.'
      });
    }

    if (isVerificationExpired(sale.verification)) {
      return res.status(409).json({
        error: 'VERIFICATION_EXPIRED',
        message: 'Verification expired. Please rescan the ID.'
      });
    }

    if (sale.verification.status !== 'approved') {
      return res.status(409).json({
        error: 'VERIFICATION_NOT_APPROVED',
        message: 'Latest verification is not approved.'
      });
    }

    const completion = await lightspeed.completeSale({
      saleId: req.params.saleId,
      verificationId,
      paymentType
    });

    res.status(200).json({
      data: completion
    });
  } catch (error) {
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

module.exports = router;
