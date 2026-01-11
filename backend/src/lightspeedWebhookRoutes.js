const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./logger');
const queue = require('./lightspeedWebhookQueue');

const router = express.Router();

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    logger.logSecurity('rate_limit_exceeded', {
      ip: req.ip,
      path: req.path,
      type: 'lightspeed_webhooks'
    });
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many webhook requests, please retry later.'
    });
  }
});

// Lightspeed webhooks require raw body for signature verification (HMAC-SHA256 over request body).
router.post('/:topic?', webhookLimiter, express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const topic = queue.normalizeTopic(req.params.topic || req.query.type || req.query.topic || 'unknown');
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');

  // Verify signature if present + client_secret configured.
  const xSigHeader = req.get('X-Signature') || req.get('x-signature') || '';
  const clientSecret = config?.lightspeed?.clientSecret || process.env.LIGHTSPEED_CLIENT_SECRET || '';
  const signature = queue.verifyLightspeedSignature({
    rawBody,
    xSignatureHeader: xSigHeader,
    clientSecret
  });

  if (!signature.verified) {
    // Don't reject by default: webhook delivery should remain robust; log so we can tighten later.
    logger.warn(
      { event: 'lightspeed_webhook_signature_unverified', topic, reason: signature.reason },
      'Lightspeed webhook signature could not be verified'
    );
  }

  let payload = null;
  const textBody = rawBody.toString('utf8');
  const parse = queue.safeJsonParse(textBody);
  if (parse.ok) payload = parse.value;

  try {
    const stored = await queue.enqueueWebhookEvent({
      topic,
      rawBody,
      payload,
      signatureVerified: signature.verified,
      signatureReason: signature.reason,
      headers: req.headers
    });

    logger.info(
      {
        event: 'lightspeed_webhook_received',
        topic,
        stored: stored.stored,
        eventKey: stored.eventKey || null,
        signatureVerified: signature.verified
      },
      'Lightspeed webhook received'
    );

    // Always ACK quickly (avoid retries + higher costs).
    res.status(200).json({
      ok: true,
      topic,
      signatureVerified: signature.verified,
      stored: stored.stored
    });
  } catch (error) {
    logger.error(
      { event: 'lightspeed_webhook_store_failed', topic, error: error.message },
      'Failed to store Lightspeed webhook'
    );
    res.status(500).json({ ok: false, error: 'WEBHOOK_STORE_FAILED' });
  }
});

module.exports = router;
