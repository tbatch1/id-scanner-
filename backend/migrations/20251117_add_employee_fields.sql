-- Add employee tracking fields to scan_sessions
-- This allows us to display actual clerk names instead of register UUIDs

ALTER TABLE scan_sessions
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS employee_name VARCHAR(200);

-- Add index for employee_id lookups (for reporting)
CREATE INDEX IF NOT EXISTS idx_scan_sessions_employee_id ON scan_sessions(employee_id);

-- Update comment
COMMENT ON COLUMN scan_sessions.employee_id IS 'Lightspeed employee ID from the POS system';
COMMENT ON COLUMN scan_sessions.employee_name IS 'Employee display name for quick reference (e.g., "John Smith")';
