-- ID Scanner Database Schema for TABC Compliance
-- Texas Alcoholic Beverage Commission requires complete audit trail

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Verifications Table (TABC Compliance - Store ALL age verifications)
CREATE TABLE IF NOT EXISTS verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id VARCHAR(100) UNIQUE NOT NULL,
  sale_id VARCHAR(100) NOT NULL,
  clerk_id VARCHAR(100) NOT NULL,

  -- Customer Data (minimal PII, TABC required for audit)
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  middle_name VARCHAR(100),
  age INTEGER NOT NULL,
  date_of_birth DATE,

  -- Verification Result
  status VARCHAR(20) NOT NULL CHECK (status IN ('approved', 'rejected', 'approved_override')),
  reason TEXT, -- If rejected, why (e.g., "Under 21", "Invalid ID", "Expired")
  document_type VARCHAR(50),
  document_number VARCHAR(150),
  issuing_country VARCHAR(120) NOT NULL DEFAULT '',
  document_expiry DATE,
  nationality VARCHAR(120),
  sex VARCHAR(10),
  source VARCHAR(50),

  -- Audit Trail (TABC Required - must be able to prove when/where/who)
  ip_address INET,
  user_agent TEXT,
  location_id VARCHAR(100), -- Which of your 13 locations

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for fast lookups during inspections
CREATE INDEX IF NOT EXISTS idx_verifications_sale_id ON verifications(sale_id);
CREATE INDEX IF NOT EXISTS idx_verifications_created_at ON verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verifications_location ON verifications(location_id);
CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_verifications_clerk ON verifications(clerk_id);

-- Sales Completions Table (Links verifications to completed sales)
CREATE TABLE IF NOT EXISTS sales_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id VARCHAR(100) UNIQUE NOT NULL,
  verification_id VARCHAR(100) NOT NULL,

  -- Transaction Details
  payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('cash', 'card')),
  amount DECIMAL(10, 2) NOT NULL,

  -- Timestamps
  completed_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Foreign Key - Cannot delete verification if sale is completed
  FOREIGN KEY (verification_id) REFERENCES verifications(verification_id) ON DELETE RESTRICT
);

-- Index for fast completion lookups
CREATE INDEX IF NOT EXISTS idx_sales_completions_sale_id ON sales_completions(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_completions_verification_id ON sales_completions(verification_id);
CREATE INDEX IF NOT EXISTS idx_sales_completions_completed_at ON sales_completions(completed_at DESC);


-- Manager Overrides Table
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
CREATE INDEX IF NOT EXISTS idx_verification_overrides_created_at ON verification_overrides(created_at DESC);

-- Banned Customers Table (prevent service for flagged IDs)
CREATE TABLE IF NOT EXISTS banned_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(50) NOT NULL,
  document_number VARCHAR(150) NOT NULL,
  issuing_country VARCHAR(120),
  banned_location_id VARCHAR(100),
  date_of_birth DATE,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(30),
  email VARCHAR(254),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, document_number, issuing_country)
);

-- Allow schema.sql to upgrade existing tables too.
ALTER TABLE IF EXISTS banned_customers ADD COLUMN IF NOT EXISTS banned_location_id VARCHAR(100);
ALTER TABLE IF EXISTS banned_customers ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE IF EXISTS banned_customers ADD COLUMN IF NOT EXISTS email VARCHAR(254);

CREATE INDEX IF NOT EXISTS idx_banned_customers_doc ON banned_customers(document_number);
CREATE INDEX IF NOT EXISTS idx_banned_customers_type ON banned_customers(document_type);
CREATE INDEX IF NOT EXISTS idx_banned_customers_country ON banned_customers(issuing_country);
CREATE INDEX IF NOT EXISTS idx_banned_customers_banned_location ON banned_customers(banned_location_id);
CREATE INDEX IF NOT EXISTS idx_banned_customers_name_dob ON banned_customers(lower(first_name), lower(last_name), date_of_birth);

-- Compliance Reports View (Easy exports for TABC inspections)
-- This view joins verifications with sales completions for complete audit trail
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

-- Summary Statistics View (Dashboard/reporting)
CREATE OR REPLACE VIEW daily_stats AS
SELECT
  DATE(created_at) AS date,
  location_id,
  COUNT(*) AS total_verifications,
  COUNT(*) FILTER (WHERE status IN ('approved','approved_override')) AS approved_count,
  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count,
  ROUND(
    COUNT(*) FILTER (WHERE status IN ('approved','approved_override'))::NUMERIC /
    NULLIF(COUNT(*), 0) * 100,
    2
  ) AS approval_rate
FROM verifications
GROUP BY DATE(created_at), location_id
ORDER BY date DESC, location_id;

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_verifications_updated_at') THEN
    CREATE TRIGGER update_verifications_updated_at BEFORE UPDATE
      ON verifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END;
$$;

-- Comments for documentation
COMMENT ON TABLE verifications IS 'TABC Compliance: All age verifications for consumable hemp products. Required by Texas law.';
COMMENT ON TABLE sales_completions IS 'TABC Compliance: Completed sales linked to age verifications.';
COMMENT ON VIEW compliance_report IS 'TABC Inspection Ready: Complete audit trail of all verifications and sales.';
COMMENT ON COLUMN verifications.ip_address IS 'Audit trail: IP address of the device that performed verification';
COMMENT ON COLUMN verifications.user_agent IS 'Audit trail: Browser/device information';
COMMENT ON COLUMN verifications.location_id IS 'Which of the 13 THC Club locations performed this verification';
COMMENT ON TABLE banned_customers IS 'IDs that are banned from completing a sale.';
