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
    documentType, documentNumber, nationality, sex, expiry, scannedAt,
    employeeId, employeeName, outletName
  } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'sessionId is required'
    });
  }

  try {
    const query = `
      INSERT INTO scan_sessions (
        session_id,
        approved,
        first_name,
        last_name,
        age,
        date_of_birth,
        reason,
        outlet_id,
        outlet_name,
        register_id,
        employee_id,
        employee_name,
        completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        approved = EXCLUDED.approved,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        age = EXCLUDED.age,
        date_of_birth = EXCLUDED.date_of_birth,
        reason = EXCLUDED.reason,
        outlet_id = EXCLUDED.outlet_id,
        outlet_name = EXCLUDED.outlet_name,
        register_id = EXCLUDED.register_id,
        employee_id = EXCLUDED.employee_id,
        employee_name = EXCLUDED.employee_name,
        completed_at = NOW()
      RETURNING *
    `;

    const result = await db.pool.query(query, [
      sessionId,
      approved !== undefined ? approved : null,
      firstName || null,
      lastName || null,
      age || null,
      dob || null,
      reason || null,
      outletId || null,
      outletName || null,
      registerId || null,
      employeeId || null,
      employeeName || null
    ]);

    logger.info({ event: 'scan_session_saved', sessionId, approved }, 'Scan session saved');

    res.status(200).json({
      success: true,
      data: result.rows[0]
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
