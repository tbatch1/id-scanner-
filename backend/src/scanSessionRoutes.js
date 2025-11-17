const express = require('express');
const db = require('./db');
const logger = require('./logger');

const router = express.Router();

// Scan Sessions API - For hybrid fallback flow
// POST /api/scan-sessions - Create or update scan session
router.post('/', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Scan sessions require database connection'
    });
  }

  const {
    sessionId, approved, firstName, lastName, age, dob, reason, outletId, registerId,
    documentType, documentNumber, nationality, sex, expiry, scannedAt
  } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'sessionId is required'
    });
  }

  try {
    // Save to scan_sessions table
    const sessionQuery = `
      INSERT INTO scan_sessions (
        session_id,
        approved,
        first_name,
        last_name,
        age,
        date_of_birth,
        reason,
        outlet_id,
        register_id,
        completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        approved = EXCLUDED.approved,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        age = EXCLUDED.age,
        date_of_birth = EXCLUDED.date_of_birth,
        reason = EXCLUDED.reason,
        outlet_id = EXCLUDED.outlet_id,
        register_id = EXCLUDED.register_id,
        completed_at = NOW()
      RETURNING *
    `;

    const sessionResult = await db.pool.query(sessionQuery, [
      sessionId,
      approved !== undefined ? approved : null,
      firstName || null,
      lastName || null,
      age || null,
      dob || null,
      reason || null,
      outletId || null,
      registerId || null
    ]);

    // Also save to verifications table so it appears in admin dashboard
    const verificationStatus = approved === true ? 'approved' : (approved === false ? 'rejected' : 'pending');
    const verificationQuery = `
      INSERT INTO verifications (
        verification_id,
        sale_id,
        first_name,
        last_name,
        age,
        date_of_birth,
        status,
        reason,
        document_type,
        document_number,
        issuing_country,
        sex,
        document_expiry,
        location_id,
        clerk_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (sale_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        age = EXCLUDED.age,
        date_of_birth = EXCLUDED.date_of_birth,
        reason = EXCLUDED.reason,
        document_type = EXCLUDED.document_type,
        document_number = EXCLUDED.document_number,
        issuing_country = EXCLUDED.issuing_country,
        sex = EXCLUDED.sex,
        document_expiry = EXCLUDED.document_expiry
      RETURNING *
    `;

    await db.pool.query(verificationQuery, [
      sessionId, // verification_id (use session ID)
      sessionId, // sale_id (use session ID for now)
      firstName || null,
      lastName || null,
      age || null,
      dob || null,
      verificationStatus,
      reason || null,
      documentType || null,
      documentNumber || null,
      nationality || null, // Maps to issuing_country
      sex || null,
      expiry || null,
      outletId || null,
      registerId || null,
      scannedAt ? new Date(scannedAt) : new Date()
    ]);

    logger.info({
      event: 'scan_session_saved',
      sessionId,
      approved,
      status: verificationStatus
    }, 'Scan session and verification saved');

    res.status(200).json({
      success: true,
      data: sessionResult.rows[0]
    });
  } catch (error) {
    logger.logAPIError('save_scan_session', error, { sessionId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to save scan session'
    });
  }
});

// GET /api/scan-sessions/:sessionId - Check scan session status
router.get('/:sessionId', async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Scan sessions require database connection'
    });
  }

  const { sessionId } = req.params;

  try {
    const query = `
      SELECT * FROM scan_sessions
      WHERE session_id = $1
      AND expires_at > NOW()
      LIMIT 1
    `;

    const result = await db.pool.query(query, [sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'SESSION_NOT_FOUND',
        message: 'Scan session not found or expired'
      });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    logger.logAPIError('get_scan_session', error, { sessionId });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve scan session'
    });
  }
});

module.exports = router;
