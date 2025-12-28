const { query } = require('./db');
const logger = require('./logger');
const config = require('./config');

function sanitizeNote(note) {
  if (!note) return null;
  return String(note).replace(/[<>]/g, '').trim().substring(0, 500);
}

function normalizeVerificationPayload(verification, context = {}) {
  return {
    verification_id: verification.verificationId,
    sale_id: verification.saleId,
    clerk_id: verification.clerkId,
    first_name: verification.firstName || null,
    last_name: verification.lastName || null,
    middle_name: verification.middleName || null,
    age: verification.age || null,
    date_of_birth: verification.dob ? new Date(verification.dob) : null,
    status: verification.status,
    reason: verification.reason || null,
    document_type: verification.documentType || null,
    document_number: verification.documentNumber || null,
    issuing_country: verification.issuingCountry || null,
    document_expiry: verification.documentExpiry ? new Date(verification.documentExpiry) : null,
    nationality: verification.nationality || null,
    sex: verification.sex || null,
    source: verification.source || null,
    ip_address: context.ipAddress || null,
    user_agent: context.userAgent || null,
    location_id: context.locationId || null
  };
}

async function saveVerification(verification, context) {
  const payload = normalizeVerificationPayload(verification, context);

  try {
    const { rows } = await query(
      `
        INSERT INTO verifications (
          verification_id,
          sale_id,
          clerk_id,
          first_name,
          last_name,
          middle_name,
          age,
          date_of_birth,
          status,
          reason,
          document_type,
          document_number,
          issuing_country,
          document_expiry,
          nationality,
          sex,
          source,
          ip_address,
          user_agent,
          location_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (verification_id)
        DO UPDATE
          SET
            clerk_id = EXCLUDED.clerk_id,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            middle_name = EXCLUDED.middle_name,
            age = EXCLUDED.age,
            date_of_birth = EXCLUDED.date_of_birth,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            document_type = EXCLUDED.document_type,
            document_number = EXCLUDED.document_number,
            issuing_country = EXCLUDED.issuing_country,
            document_expiry = EXCLUDED.document_expiry,
            nationality = EXCLUDED.nationality,
            sex = EXCLUDED.sex,
            source = EXCLUDED.source,
            ip_address = EXCLUDED.ip_address,
            user_agent = EXCLUDED.user_agent,
            location_id = EXCLUDED.location_id,
            updated_at = NOW()
        RETURNING *
      `,
      [
        payload.verification_id,
        payload.sale_id,
        payload.clerk_id,
        payload.first_name,
        payload.last_name,
        payload.middle_name,
        payload.age,
        payload.date_of_birth,
        payload.status,
        payload.reason,
        payload.document_type,
        payload.document_number,
        payload.issuing_country,
        payload.document_expiry,
        payload.nationality,
        payload.sex,
        payload.source,
        payload.ip_address,
        payload.user_agent,
        payload.location_id
      ]
    );

    logger.info(
      {
        event: 'verification_persisted',
        saleId: payload.sale_id,
        verificationId: payload.verification_id,
        documentType: payload.document_type || null,
        issuingCountry: payload.issuing_country || null,
        source: payload.source || null,
        documentExpiry: payload.document_expiry || null,
        nationality: payload.nationality || null,
        sex: payload.sex || null
      },
      'Verification persisted to compliance store'
    );

    return rows[0];
  } catch (error) {
    logger.logAPIError('saveVerification', error, {
      saleId: payload.sale_id,
      verificationId: payload.verification_id
    });
    throw error;
  }
}

async function getLatestVerificationForSale(saleId) {
  const { rows } = await query(
    `
      SELECT *
      FROM verifications
      WHERE sale_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [saleId]
  );

  return rows[0] || null;
}

async function recordSaleCompletion({ saleId, verificationId, paymentType, amount }) {
  try {
    const { rows } = await query(
      `
        INSERT INTO sales_completions (
          sale_id,
          verification_id,
          payment_type,
          amount
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (sale_id)
        DO UPDATE
          SET
            verification_id = EXCLUDED.verification_id,
            payment_type = EXCLUDED.payment_type,
            amount = EXCLUDED.amount,
            completed_at = NOW()
        RETURNING *
      `,
      [saleId, verificationId, paymentType, amount]
    );

    logger.info(
      { event: 'sale_completion_persisted', saleId, verificationId, paymentType },
      'Sale completion persisted to compliance store'
    );

    return rows[0];
  } catch (error) {
    logger.logAPIError('recordSaleCompletion', error, { saleId, verificationId, paymentType });
    throw error;
  }
}

function resolveOutletDescriptor(locationId) {
  if (!locationId) {
    return null;
  }

  const outletsById = config.lightspeed?.outletsById || {};
  const outlets = config.lightspeed?.outlets || {};
  const descriptorById = outletsById[locationId];
  if (descriptorById) {
    return {
      id: descriptorById.id,
      code: descriptorById.code || null,
      label: descriptorById.label || null
    };
  }

  const slug = locationId.toLowerCase();
  const descriptorBySlug = outlets[slug];
  if (descriptorBySlug) {
    return {
      id: descriptorBySlug.id || locationId,
      code: descriptorBySlug.code || null,
      label: descriptorBySlug.label || null
    };
  }

  return {
    id: locationId,
    code: null,
    label: null
  };
}

async function summarizeCompliance({ days = 30, limit = 50 } = {}) {
  const [summaryResult, rejectionResult, recentResult, statsResult] = await Promise.all([
    query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('approved','approved_override')) AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS within_range
        FROM verifications
      `,
      [days]
    ),
    query(
      `
        SELECT
          COALESCE(reason, 'Unspecified') AS reason,
          COUNT(*) AS count
        FROM verifications
        WHERE status = 'rejected'
        GROUP BY reason
        ORDER BY count DESC
        LIMIT 5
      `
    ),
    query(
      `
        SELECT
          c.verification_id,
          c.sale_id,
          c.clerk_id,
          c.verification_status,
          c.rejection_reason,
          c.payment_type,
          c.sale_amount,
          c.sale_status,
          c.verified_at,
          c.completed_at,
          c.location_id
        FROM compliance_report c
        ORDER BY c.verified_at DESC
        LIMIT $1
      `,
      [limit]
    ),
    query(
      `
        SELECT
          date,
          location_id,
          total_verifications,
          approved_count,
          rejected_count,
          approval_rate
        FROM daily_stats
        ORDER BY date DESC
        LIMIT 14
      `
    )
  ]);

  const summary = summaryResult.rows[0] || {
    total: 0,
    approved: 0,
    rejected: 0,
    within_range: 0
  };

  return {
    summary: {
      totalVerifications: Number(summary.total || 0),
      approved: Number(summary.approved || 0),
      rejected: Number(summary.rejected || 0),
      withinRange: Number(summary.within_range || 0)
    },
    rejectionReasons: rejectionResult.rows.map((row) => ({
      reason: row.reason,
      count: Number(row.count)
    })),
    recentActivity: recentResult.rows.map((row) => ({
      verificationId: row.verification_id,
      saleId: row.sale_id,
      clerkId: row.clerk_id,
      status: row.verification_status,
      reason: row.rejection_reason,
      paymentType: row.payment_type,
      saleAmount: row.sale_amount,
      saleStatus: row.sale_status,
      verifiedAt: row.verified_at,
      completedAt: row.completed_at,
      locationId: row.location_id,
      outlet: resolveOutletDescriptor(row.location_id)
    })),
    dailyStats: statsResult.rows.map((row) => ({
      date: row.date,
      locationId: row.location_id,
      totalVerifications: Number(row.total_verifications),
      approved: Number(row.approved_count),
      rejected: Number(row.rejected_count),
      approvalRate: row.approval_rate !== null ? Number(row.approval_rate) : null,
      outlet: resolveOutletDescriptor(row.location_id)
    }))
  };
}

async function findBannedCustomer({ documentType, documentNumber, issuingCountry }) {
  if (!documentType || !documentNumber) {
    return null;
  }

  const normalizedCountry = issuingCountry ? issuingCountry : '';

  const { rows } = await query(
    `
      SELECT *
      FROM banned_customers
      WHERE document_type = $1
        AND document_number = $2
        AND issuing_country = $3
      LIMIT 1
    `,
    [documentType, documentNumber, normalizedCountry]
  );

  return rows[0] || null;
}

async function addBannedCustomer(entry) {
  const { documentType, documentNumber, issuingCountry, dateOfBirth, firstName, lastName, notes } = entry;
  const normalizedCountry = issuingCountry ? issuingCountry : '';

  const { rows } = await query(
    `
      INSERT INTO banned_customers (
        document_type,
        document_number,
        issuing_country,
        date_of_birth,
        first_name,
        last_name,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (document_type, document_number, issuing_country)
      DO UPDATE
        SET
          issuing_country = EXCLUDED.issuing_country,
          date_of_birth = EXCLUDED.date_of_birth,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          notes = EXCLUDED.notes,
          updated_at = NOW()
      RETURNING *
    `,
    [
      documentType,
      documentNumber,
      normalizedCountry,
      dateOfBirth ? new Date(dateOfBirth) : null,
      firstName || null,
      lastName || null,
      notes || null
    ]
  );

  logger.info(
    {
      event: 'banned_customer_saved',
      documentType,
      documentNumber,
      issuingCountry: normalizedCountry || null
    },
    'Banned customer entry upserted'
  );

  return rows[0];
}

async function listBannedCustomers() {
  const { rows } = await query(
    `
      SELECT
        id,
        document_type AS "documentType",
        document_number AS "documentNumber",
        NULLIF(issuing_country, '') AS "issuingCountry",
        date_of_birth AS "dateOfBirth",
        first_name AS "firstName",
        last_name AS "lastName",
        notes,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM banned_customers
      ORDER BY created_at DESC
    `
  );

  return rows;
}

async function markVerificationOverride({ verificationId, saleId, managerId, note, clerkId, registerId }) {
  if (!verificationId || !saleId) {
    throw new Error('VERIFICATION_REQUIRED');
  }

  const sanitizedNote = sanitizeNote(note);
  let finalVerificationId = verificationId;
  let verificationRecord = null;

  // Handle "Pure" Manual Override (No previous scan)
  if (verificationId === 'MANUAL-OVERRIDE') {
    // Generate a unique verification_id for manual override
    const generatedVerificationId = `OVERRIDE-${saleId}-${Date.now()}`;

    const newVerification = await query(
      `
        INSERT INTO verifications (
          verification_id, sale_id, clerk_id, location_id, status, reason, 
          document_type, document_number, age, approved, source
        )
        VALUES ($1, $2, $3, $4, 'approved_override', $5, 
                'manual', 'no-scan', 21, true, 'manual_override')
        RETURNING *
      `,
      [generatedVerificationId, saleId, clerkId || 'unknown-clerk', registerId || 'unknown-location', sanitizedNote]
    );
    finalVerificationId = newVerification.rows[0].verification_id;
    verificationRecord = newVerification.rows[0];
  } else {
    // Existing logic for updating a rejected scan
    const updateResult = await query(
      `
        UPDATE verifications
        SET status = 'approved_override',
            reason = COALESCE($1, reason),
            clerk_id = COALESCE($3, clerk_id),
            location_id = COALESCE($4, location_id),
            updated_at = NOW()
        WHERE verification_id = $2
        RETURNING *
      `,
      [sanitizedNote, verificationId, clerkId, registerId]
    );

    if (!updateResult.rows.length) {
      throw new Error('VERIFICATION_NOT_FOUND');
    }
    verificationRecord = updateResult.rows[0];
  }

  const overrideInsert = await query(
    `
      INSERT INTO verification_overrides (
        verification_id,
        sale_id,
        manager_id,
        note
      )
      VALUES ($1,$2,$3,$4)
      RETURNING id, verification_id, sale_id, manager_id, note, created_at
    `,
    [finalVerificationId, saleId, managerId || 'unknown-manager', sanitizedNote]
  );

  logger.info({
    event: 'verification_override',
    verificationId,
    saleId,
    managerId: managerId || null
  }, 'Verification override recorded');

  return {
    verification: verificationRecord,
    override: overrideInsert.rows[0]
  };
}



async function listOverridesForSale(saleId) {
  const { rows } = await query(
    `
      SELECT
        id,
        verification_id AS verificationId,
        sale_id AS saleId,
        manager_id AS managerId,
        note,
        created_at AS createdAt
      FROM verification_overrides
      WHERE sale_id = $1
      ORDER BY created_at DESC
    `,
    [saleId]
  );

  return rows;
}

function normalizeRetentionDays(value, fallback) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 3650); // cap at ~10 years
}

async function listRecentOverrides({ days = 30, limit = 200 } = {}) {
  const normalizedDays = normalizeRetentionDays(days, 30);
  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);

  const { rows } = await query(
    `
      SELECT
        o.id,
        o.verification_id AS "verificationId",
        o.sale_id AS "saleId",
        o.manager_id AS "managerId",
        o.note,
        o.created_at AS "createdAt",
        v.location_id AS "locationId",
        v.clerk_id AS "clerkId",
        v.status,
        v.document_type AS "documentType",
        v.document_number AS "documentNumber",
        v.issuing_country AS "issuingCountry",
        v.document_expiry AS "documentExpiry",
        v.nationality,
        v.sex
      FROM verification_overrides o
      JOIN verifications v ON v.verification_id = o.verification_id
      WHERE o.created_at >= NOW() - ($1::int || ' days')::interval
      ORDER BY o.created_at DESC
      LIMIT $2
    `,
    [normalizedDays, normalizedLimit]
  );

  return rows;
}

async function enforceRetention({
  verificationDays = 730, // TABC requires 2-year retention (730 days)
  overrideDays,
  completionDays
} = {}) {
  const normalizedVerificationDays = normalizeRetentionDays(verificationDays, 730);
  const normalizedOverrideDays = normalizeRetentionDays(
    overrideDays ?? normalizedVerificationDays,
    normalizedVerificationDays
  );
  const normalizedCompletionDays = normalizeRetentionDays(
    completionDays ?? normalizedVerificationDays,
    normalizedVerificationDays
  );

  const results = {
    verificationsDeleted: 0,
    completionsDeleted: 0,
    overridesDeleted: 0
  };

  const deletions = [];

  deletions.push(
    query(
      `
        DELETE FROM verification_overrides
        WHERE created_at < NOW() - ($1::int || ' days')::interval
      `,
      [normalizedOverrideDays]
    ).then((res) => {
      results.overridesDeleted = res.rowCount || 0;
    })
  );

  deletions.push(
    query(
      `
        DELETE FROM sales_completions
        WHERE completed_at < NOW() - ($1::int || ' days')::interval
      `,
      [normalizedCompletionDays]
    ).then((res) => {
      results.completionsDeleted = res.rowCount || 0;
    })
  );

  await Promise.all(deletions);

  const verificationsResult = await query(
    `
      DELETE FROM verifications
      WHERE created_at < NOW() - ($1::int || ' days')::interval
    `,
    [normalizedVerificationDays]
  );

  results.verificationsDeleted = verificationsResult.rowCount || 0;

  logger.info(
    {
      event: 'retention_enforced',
      verificationDays: normalizedVerificationDays,
      overrideDays: normalizedOverrideDays,
      completionDays: normalizedCompletionDays,
      ...results
    },
    'Retention policy enforced'
  );

  return results;
}

async function removeBannedCustomer(id) {
  const { rowCount } = await query(`DELETE FROM banned_customers WHERE id = $1`, [id]);
  if (rowCount) {
    logger.info({ event: 'banned_customer_removed', id }, 'Banned customer removed');
  }
  return rowCount > 0;
}

async function countRecentOverrides({ locationId, minutes = 10 }) {
  // If no pool, return 0 (can't count)
  if (!query) return 0;

  const { rows } = await query(
    `
      SELECT COUNT(*) as count
      FROM verification_overrides o
      JOIN verifications v ON v.verification_id = o.verification_id
      WHERE o.created_at >= NOW() - ($1::int || ' minutes')::interval
      AND ($2::text IS NULL OR v.location_id = $2)
    `,
    [minutes, locationId]
  );

  return parseInt(rows[0]?.count || 0, 10);
}

async function logDiagnostic({ type, saleId, userAgent, error, details }) {
  try {
    // Ensure params are not undefined for PG driver
    const params = [
      type || null,
      saleId || null,
      userAgent || null,
      error || null,
      details ? JSON.stringify(details) : null
    ];
    await query(`
      INSERT INTO diagnostics (type, sale_id, user_agent, error, details)
      VALUES ($1, $2, $3, $4, $5)
    `, params);
  } catch (err) {
    logger.error({ err }, 'Failed to log diagnostic to DB');
  }
}

// Ensure diagnostics table exists
async function initDiagnostics() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        type TEXT,
        sale_id TEXT,
        user_agent TEXT,
        error TEXT,
        details JSONB
      )
    `);
  } catch (err) {
    logger.error({ err }, 'Failed to init diagnostics table');
  }
}

initDiagnostics();

module.exports = {
  saveVerification,
  getLatestVerificationForSale,
  recordSaleCompletion,
  summarizeCompliance,
  findBannedCustomer,
  addBannedCustomer,
  listBannedCustomers,
  removeBannedCustomer,
  markVerificationOverride,
  listOverridesForSale,
  listRecentOverrides,
  enforceRetention,
  countRecentOverrides,
  logDiagnostic
};
