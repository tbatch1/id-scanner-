-- Customer profile dimension table for marketing analytics (Lightspeed X-Series)

CREATE TABLE IF NOT EXISTS sync_cursors (
  key TEXT PRIMARY KEY,
  cursor BIGINT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255),
  first_name VARCHAR(120),
  last_name VARCHAR(120),
  email VARCHAR(255),
  phone VARCHAR(80),
  mobile VARCHAR(80),
  customer_code VARCHAR(120),
  company_name VARCHAR(255),
  note TEXT,
  date_of_birth DATE,
  sex VARCHAR(20),
  website VARCHAR(255),
  twitter VARCHAR(255),
  enable_loyalty BOOLEAN,
  loyalty_balance DECIMAL(12,2),
  year_to_date DECIMAL(12,2),
  balance DECIMAL(12,2),
  customer_group_id VARCHAR(64),
  physical_address1 VARCHAR(255),
  physical_address2 VARCHAR(255),
  physical_suburb VARCHAR(255),
  physical_city VARCHAR(255),
  physical_state VARCHAR(255),
  physical_postcode VARCHAR(40),
  physical_country VARCHAR(80),
  postal_address1 VARCHAR(255),
  postal_address2 VARCHAR(255),
  postal_suburb VARCHAR(255),
  postal_city VARCHAR(255),
  postal_state VARCHAR(255),
  postal_postcode VARCHAR(40),
  postal_country VARCHAR(80),
  custom_field_1 TEXT,
  custom_field_2 TEXT,
  custom_field_3 TEXT,
  custom_field_4 TEXT,
  version BIGINT,
  lightspeed_created_at TIMESTAMP,
  lightspeed_updated_at TIMESTAMP,
  synced_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_synced_at ON customer_profiles(synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_dob ON customer_profiles(date_of_birth);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_sex ON customer_profiles(sex);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_zip ON customer_profiles(physical_postcode);

