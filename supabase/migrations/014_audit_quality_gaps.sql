-- Parity Audit — Quality Gaps Extension
--
-- Apr 9 2026 — Shane asked for the audit to also surface:
--   1. When contacts were enriched (last_scored_date)
--   2. Stale summaries worth refreshing (>60 days since scored)
--   3. Orphaned contacts (no company association)
--   4. Bad name formatting
--   5. Inconsistent attribution (UTM gaps, first-touch missing, etc.)
--
-- All gap types flow into the existing audit_enrichment_gaps table. No new
-- tables. No new review surface. Shane filters by gap_type in Supabase Studio.
--
-- Migration is append-only:
--   - ADD COLUMN IF NOT EXISTS for new snapshot fields
--   - CREATE OR REPLACE FUNCTION for new detection procs
-- Cannot break existing functionality.

-- ═══════════════════════════════════════════════════════════════════════
-- Snapshot schema additions
-- ═══════════════════════════════════════════════════════════════════════

-- Contacts: enrichment timestamp, attribution fields, geo, linkedin, company fallback
ALTER TABLE audit_hs_contacts_snapshot
  ADD COLUMN IF NOT EXISTS last_scored_date    timestamptz,
  ADD COLUMN IF NOT EXISTS hs_linkedin_url     text,
  ADD COLUMN IF NOT EXISTS company_string      text,
  ADD COLUMN IF NOT EXISTS city                text,
  ADD COLUMN IF NOT EXISTS state               text,
  ADD COLUMN IF NOT EXISTS utm_source          text,
  ADD COLUMN IF NOT EXISTS utm_medium          text,
  ADD COLUMN IF NOT EXISTS utm_campaign        text,
  ADD COLUMN IF NOT EXISTS first_touch_channel text;

-- Companies: enrichment timestamp + attribution
ALTER TABLE audit_hs_companies_snapshot
  ADD COLUMN IF NOT EXISTS last_scored_date    timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_source  text,
  ADD COLUMN IF NOT EXISTS touch_channels      text,
  ADD COLUMN IF NOT EXISTS touch_campaigns     text,
  ADD COLUMN IF NOT EXISTS utm_medium          text,
  ADD COLUMN IF NOT EXISTS latest_source       text;

-- Partial index on stale-enrichment detection hotpath
CREATE INDEX IF NOT EXISTS idx_audit_hs_contacts_last_scored
  ON audit_hs_contacts_snapshot(last_scored_date)
  WHERE last_scored_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_hs_companies_last_scored
  ON audit_hs_companies_snapshot(last_scored_date)
  WHERE last_scored_date IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- audit_run_quality_contacts — 4 new gap types
-- ═══════════════════════════════════════════════════════════════════════
--
-- Inserts into audit_enrichment_gaps with these gap_type values:
--   orphaned_contact       (priority 3) — no company association at all
--   bad_name_format        (priority 4) — null/undefined/single-word/too-short
--   stale_enrichment       (priority 3) — scored >60 days ago
--   attribution_incomplete (priority 4) — partial UTM data

CREATE OR REPLACE FUNCTION audit_run_quality_contacts(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_enrichment_gaps (hubspot_id, object_type, gap_type, priority, source, last_detected_at)

  -- 1. orphaned_contact
  SELECT s.hubspot_id, 'contact', 'orphaned_contact', 3, 'needs_company_association', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND s.associated_company_id IS NULL
    AND (s.company_string IS NULL OR trim(s.company_string) = '')

  UNION ALL

  -- 2. bad_name_format
  SELECT s.hubspot_id, 'contact', 'bad_name_format', 4, 'needs_name_cleanup', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND (
      -- Both first and last name missing
      (s.firstname IS NULL AND s.lastname IS NULL)
      -- Contains literal "undefined" string (V2 enrichment artifact)
      OR lower(coalesce(s.firstname, '')) = 'undefined'
      OR lower(coalesce(s.lastname, '')) = 'undefined'
      OR lower(coalesce(s.firstname, '') || ' ' || coalesce(s.lastname, '')) LIKE '%undefined%'
      -- First or last is a single character
      OR length(trim(coalesce(s.firstname, ''))) = 1
      OR length(trim(coalesce(s.lastname, ''))) = 1
      -- Both empty strings after trim
      OR (trim(coalesce(s.firstname, '')) = '' AND trim(coalesce(s.lastname, '')) = '')
      -- Placeholder dashes
      OR s.firstname = '—' OR s.lastname = '—'
      OR s.firstname = '-' OR s.lastname = '-'
    )

  UNION ALL

  -- 3. stale_enrichment (was scored, but >60 days old)
  SELECT s.hubspot_id, 'contact', 'stale_enrichment', 3, 'needs_rescore', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND s.lead_tier IS NOT NULL
    AND s.last_scored_date IS NOT NULL
    AND s.last_scored_date < now() - INTERVAL '60 days'

  UNION ALL

  -- 4. attribution_incomplete
  SELECT s.hubspot_id, 'contact', 'attribution_incomplete', 4, 'needs_attribution_fix', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND (
      -- utm_source set but utm_campaign missing
      (s.utm_source IS NOT NULL AND trim(s.utm_source) != ''
       AND (s.utm_campaign IS NULL OR trim(s.utm_campaign) = ''))
      -- lead_origin set to V2-era value but no signal_type
      OR (s.lead_origin IS NOT NULL
          AND s.lead_origin NOT IN ('Clay', 'HubSpot Backfill', 'meeting_booked')
          AND (s.signal_type IS NULL OR trim(s.signal_type) = ''))
    )

  ON CONFLICT (hubspot_id, object_type, gap_type) DO UPDATE
    SET priority = EXCLUDED.priority,
        source = EXCLUDED.source,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_enrichment_gaps.resolved = false;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- audit_run_quality_companies — 3 new gap types
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit_run_quality_companies(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_enrichment_gaps (hubspot_id, object_type, gap_type, priority, source, last_detected_at)

  -- 1. bad_name_format (stricter for companies — HTML scrape artifacts)
  SELECT s.hubspot_id, 'company', 'bad_name_format', 4, 'needs_name_cleanup', now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND (
      s.name IS NULL OR trim(s.name) = ''
      OR length(trim(s.name)) < 2
      -- HTML title scrape: "Page Title | Site Name"
      OR (s.name LIKE '% | %' AND length(s.name) > 40)
      -- URL-like
      OR s.name ILIKE 'http%'
      OR s.name ~* '^[a-z0-9-]+\.(com|org|net|io|edu|gov)\b'
      -- Generic page titles
      OR lower(trim(s.name)) IN ('home', 'login', 'sign in', 'welcome', 'page not found', '404')
      -- Placeholder dashes or undefined
      OR lower(trim(s.name)) = 'undefined'
      OR trim(s.name) IN ('—', '-')
    )

  UNION ALL

  -- 2. stale_enrichment
  SELECT s.hubspot_id, 'company', 'stale_enrichment', 3, 'needs_rescore', now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND (s.lead_summary IS NOT NULL OR s.sales_org_summary IS NOT NULL)
    AND s.last_scored_date IS NOT NULL
    AND s.last_scored_date < now() - INTERVAL '60 days'

  UNION ALL

  -- 3. attribution_incomplete
  SELECT s.hubspot_id, 'company', 'attribution_incomplete', 4, 'needs_attribution_fix', now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND s.first_touch_source IS NULL
    AND (s.touch_channels IS NOT NULL AND trim(s.touch_channels) != '')

  ON CONFLICT (hubspot_id, object_type, gap_type) DO UPDATE
    SET priority = EXCLUDED.priority,
        source = EXCLUDED.source,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_enrichment_gaps.resolved = false;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;
