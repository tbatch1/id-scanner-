BEGIN;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS document_expiry DATE;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS nationality VARCHAR(120);

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS sex VARCHAR(10);

DROP VIEW IF EXISTS compliance_report;

CREATE OR REPLACE VIEW compliance_report AS
SELECT
  v.verification_id,
  v.sale_id,
  v.clerk_id,
  v.first_name,
  v.last_name,
  v.middle_name,
  v.age,
  v.status AS verification_status,
  v.reason AS rejection_reason,
  v.document_type,
  v.document_number,
  v.issuing_country,
  v.document_expiry,
  v.nationality,
  v.sex,
  v.source,
  v.ip_address,
  v.user_agent,
  v.location_id,
  v.created_at AS verified_at,
  sc.payment_type,
  sc.amount AS sale_amount,
  sc.completed_at,
  CASE
    WHEN sc.completed_at IS NOT NULL THEN 'completed'
    WHEN v.status = 'rejected' THEN 'rejected'
    ELSE 'pending'
  END AS sale_status
FROM verifications v
LEFT JOIN sales_completions sc ON v.verification_id = sc.verification_id
ORDER BY v.created_at DESC;

COMMENT ON VIEW compliance_report IS 'TABC Inspection Ready: Complete audit trail of all verifications and sales.';

CREATE INDEX IF NOT EXISTS idx_verification_overrides_created_at ON verification_overrides(created_at DESC);

COMMIT;
