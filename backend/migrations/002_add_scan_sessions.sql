-- Scan Sessions Table
-- Temporary storage for scans that happen in a new tab/window
-- The iframe polls this table to check if scan completed

CREATE TABLE IF NOT EXISTS scan_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(100) UNIQUE NOT NULL,

  -- Scan Result
  approved BOOLEAN,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  age INTEGER,
  date_of_birth DATE,
  reason TEXT,

  -- Context
  outlet_id VARCHAR(100),
  register_id VARCHAR(100),

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS idx_scan_sessions_session_id ON scan_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_expires_at ON scan_sessions(expires_at);

-- Auto-cleanup expired sessions (runs every hour)
CREATE OR REPLACE FUNCTION cleanup_expired_scan_sessions()
RETURNS void AS $$
BEGIN
  DELETE FROM scan_sessions WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE scan_sessions IS 'Temporary storage for ID scans completed in new browser tabs. Auto-expires after 10 minutes.';
