BEGIN;

ALTER TABLE verifications
  DROP CONSTRAINT IF EXISTS verifications_status_check;

ALTER TABLE verifications
  ADD CONSTRAINT verifications_status_check
  CHECK (status IN ('approved', 'rejected', 'approved_override'));

CREATE TABLE IF NOT EXISTS verification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id VARCHAR(100) NOT NULL REFERENCES verifications(verification_id) ON DELETE CASCADE,
  sale_id VARCHAR(100) NOT NULL,
  manager_id VARCHAR(100) NOT NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_overrides_sale ON verification_overrides(sale_id);
CREATE INDEX IF NOT EXISTS idx_verification_overrides_verification ON verification_overrides(verification_id);

COMMIT;
