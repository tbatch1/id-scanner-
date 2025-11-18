-- Add outlet_name field to scan_sessions for display purposes
-- This allows us to show actual location names instead of UUIDs

ALTER TABLE scan_sessions
  ADD COLUMN IF NOT EXISTS outlet_name VARCHAR(200);

-- Add comment
COMMENT ON COLUMN scan_sessions.outlet_name IS 'Outlet/location display name from Lightspeed (e.g., "Westheimer", "Galleria")';
