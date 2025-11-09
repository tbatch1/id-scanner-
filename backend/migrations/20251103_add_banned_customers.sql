BEGIN;

CREATE TABLE IF NOT EXISTS banned_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(50) NOT NULL,
  document_number VARCHAR(150) NOT NULL,
  issuing_country VARCHAR(120) NOT NULL DEFAULT '',
  date_of_birth DATE,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, document_number, issuing_country)
);

CREATE INDEX IF NOT EXISTS idx_banned_customers_doc ON banned_customers(document_number);
CREATE INDEX IF NOT EXISTS idx_banned_customers_type ON banned_customers(document_type);
CREATE INDEX IF NOT EXISTS idx_banned_customers_country ON banned_customers(issuing_country);

COMMIT;
