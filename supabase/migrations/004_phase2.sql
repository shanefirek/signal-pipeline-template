-- Phase 2: Schema additions for cron replacement tasks
-- Adds: stale refresh tracking, deal tracking, improved stale detection index

-- Stale refresh tracking (contacts table)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz;

-- Deal tracking (companies table)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_deal_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deal_created_at timestamptz;

-- Composite index for stale detection query (used by stale-refresh task)
-- Covers: WHERE needs_refresh = true AND (last_refreshed_at IS NULL OR last_signal_date > last_refreshed_at)
CREATE INDEX IF NOT EXISTS idx_contacts_stale
  ON contacts(last_signal_date DESC)
  WHERE needs_refresh = true;
