-- Phase 2: Fibbler engagement columns + decay tracking
-- Adds: Fibbler data on signals, last_scored_at on companies for stale-refresh

-- Fibbler engagement data on signals table (G24)
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_clicks integer DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_leads integer DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_impressions integer DEFAULT 0;

-- Stale-refresh needs to track when company was last scored
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_scored_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS intent_score integer DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_score integer DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_tier text;

-- Index for stale-refresh query
CREATE INDEX IF NOT EXISTS idx_companies_stale_scored
  ON companies(last_scored_at)
  WHERE intent_score IS NOT NULL;
