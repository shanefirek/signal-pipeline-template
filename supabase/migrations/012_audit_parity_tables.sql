-- HubSpot ↔ Supabase Parity Audit Tables
--
-- Apr 9 2026 — Shane's internal audit system for continuous HubSpot drift
-- detection. See ~/.claude/plans/modular-tumbling-kitten.md for the full plan.
--
-- These tables are populated weekly by src/triggers/hubspot-parity-audit.ts
-- and reviewed by Shane via SQL in Supabase Studio. Manual cleanup actions
-- are executed by scripts/run-cleanup-approved.mts which logs every action
-- to audit_cleanup_actions_log.
--
-- NO automated execution. NO Slack. All output is internal (DB + logs only).

-- ───────────────────────────────────────────────────────────────────────
-- 1. audit_hs_contacts_snapshot (append-only, keep last 4 snapshots)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_hs_contacts_snapshot (
  snapshot_id           timestamptz NOT NULL,
  hubspot_id            text        NOT NULL,
  email                 text,
  firstname             text,
  lastname              text,
  jobtitle              text,
  associated_company_id text,
  hubspot_owner_id      text,
  owner_name            text,
  lifecyclestage        text,
  lead_tier             text,
  lead_origin           text,
  signal_type           text,
  icp_score             numeric,
  lead_summary          text,
  syft_last_seen        timestamptz,
  hs_createdate         timestamptz,
  hs_lastmodified       timestamptz,
  raw_properties        jsonb,
  PRIMARY KEY (snapshot_id, hubspot_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_hs_contacts_snapshot_id
  ON audit_hs_contacts_snapshot(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_audit_hs_contacts_hubspot_id
  ON audit_hs_contacts_snapshot(hubspot_id);
CREATE INDEX IF NOT EXISTS idx_audit_hs_contacts_email
  ON audit_hs_contacts_snapshot(lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_hs_contacts_owner
  ON audit_hs_contacts_snapshot(hubspot_owner_id)
  WHERE hubspot_owner_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 2. audit_hs_companies_snapshot (append-only, keep last 4 snapshots)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_hs_companies_snapshot (
  snapshot_id        timestamptz NOT NULL,
  hubspot_id         text        NOT NULL,
  name               text,
  domain             text,
  hubspot_owner_id   text,
  owner_name         text,
  lifecyclestage     text,
  lead_tier          text,
  lead_temp          text,
  lead_origin        text,
  icp_score          numeric,
  lead_summary       text,
  sales_org_summary  text,
  sub_market         text,
  syft_last_seen     timestamptz,
  hs_createdate      timestamptz,
  hs_lastmodified    timestamptz,
  raw_properties     jsonb,
  PRIMARY KEY (snapshot_id, hubspot_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_hs_companies_snapshot_id
  ON audit_hs_companies_snapshot(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_audit_hs_companies_hubspot_id
  ON audit_hs_companies_snapshot(hubspot_id);
CREATE INDEX IF NOT EXISTS idx_audit_hs_companies_domain
  ON audit_hs_companies_snapshot(lower(domain))
  WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_hs_companies_owner
  ON audit_hs_companies_snapshot(hubspot_owner_id)
  WHERE hubspot_owner_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 3. audit_dedup_groups (latest-only, TRUNCATE + re-populate weekly)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_dedup_groups (
  id               bigserial PRIMARY KEY,
  detected_at      timestamptz DEFAULT now(),
  object_type      text NOT NULL CHECK (object_type IN ('contact','company')),
  dedup_method     text NOT NULL,
  dedup_key        text NOT NULL,
  member_ids       text[] NOT NULL,
  member_count     int GENERATED ALWAYS AS (cardinality(member_ids)) STORED,
  keeper_id        text NOT NULL,
  keeper_reason    text,
  review_decision  text DEFAULT 'pending'
    CHECK (review_decision IN ('pending','approved','rejected','manual_override')),
  reviewed_at      timestamptz,
  notes            text
);

CREATE INDEX IF NOT EXISTS idx_audit_dedup_groups_decision
  ON audit_dedup_groups(review_decision);
CREATE INDEX IF NOT EXISTS idx_audit_dedup_groups_type
  ON audit_dedup_groups(object_type);

-- ───────────────────────────────────────────────────────────────────────
-- 4. audit_archive_candidates (upsert, preserves decision across runs)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_archive_candidates (
  hubspot_id           text NOT NULL,
  object_type          text NOT NULL CHECK (object_type IN ('contact','company')),
  flags                text[] NOT NULL,
  v2_linked            boolean DEFAULT false,
  has_open_deal        boolean DEFAULT false,
  has_syft_activity    boolean DEFAULT false,
  days_since_created   integer,
  days_since_modified  integer,
  decision             text DEFAULT 'pending'
    CHECK (decision IN ('pending','approved','rejected','deferred','executed')),
  decided_at           timestamptz,
  reason               text,
  last_detected_at     timestamptz DEFAULT now(),
  PRIMARY KEY (hubspot_id, object_type)
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_decision
  ON audit_archive_candidates(decision);
CREATE INDEX IF NOT EXISTS idx_audit_archive_detected
  ON audit_archive_candidates(last_detected_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- 5. audit_enrichment_gaps (upsert, preserves resolved across runs)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_enrichment_gaps (
  hubspot_id        text NOT NULL,
  object_type       text NOT NULL CHECK (object_type IN ('contact','company')),
  gap_type          text NOT NULL,
  priority          smallint NOT NULL CHECK (priority BETWEEN 1 AND 5),
  source            text,
  resolved          boolean DEFAULT false,
  resolved_at       timestamptz,
  last_detected_at  timestamptz DEFAULT now(),
  notes             text,
  PRIMARY KEY (hubspot_id, object_type, gap_type)
);

CREATE INDEX IF NOT EXISTS idx_audit_enrich_priority
  ON audit_enrichment_gaps(priority)
  WHERE resolved = false;

-- ───────────────────────────────────────────────────────────────────────
-- 6. audit_parity_runs (append-only, weekly summary — replaces Slack digest)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_parity_runs (
  snapshot_id                 timestamptz PRIMARY KEY,
  finished_at                 timestamptz,
  contacts_total              int,
  companies_total             int,
  contacts_added              int,
  contacts_removed            int,
  contacts_modified           int,
  companies_added             int,
  companies_removed           int,
  companies_modified          int,
  dedup_groups_total          int,
  archive_candidates_pending  int,
  enrichment_gaps_pending     int,
  run_duration_seconds        int,
  notes                       text
);

-- ───────────────────────────────────────────────────────────────────────
-- 7. audit_cleanup_actions_log (append-only, every cleanup action)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_cleanup_actions_log (
  id             bigserial PRIMARY KEY,
  action_type    text NOT NULL,
  object_type    text NOT NULL,
  hubspot_id     text NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  script_name    text,
  executed_at    timestamptz DEFAULT now(),
  success        boolean NOT NULL,
  error_message  text
);

CREATE INDEX IF NOT EXISTS idx_audit_cleanup_log_executed
  ON audit_cleanup_actions_log(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cleanup_log_object
  ON audit_cleanup_actions_log(hubspot_id, object_type);
CREATE INDEX IF NOT EXISTS idx_audit_cleanup_log_action
  ON audit_cleanup_actions_log(action_type, success);

-- ═══════════════════════════════════════════════════════════════════════
-- STORED PROCEDURES — Detection logic wrapped for supabase.rpc() calls
-- ═══════════════════════════════════════════════════════════════════════
--
-- V2 uses supabase-js for DB access, which doesn't support raw SQL exec.
-- Detection logic lives in these functions so it can be called via:
--   await supabase.rpc('audit_run_contact_dedup', { p_snapshot_id: ... })
--
-- Each function is idempotent within a snapshot — re-running with the same
-- snapshot_id is safe.

-- ───────────────────────────────────────────────────────────────────────
-- Dedup detection — contacts (email_exact, linkedin_exact, name_company)
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_contact_dedup(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  -- Clear pending contact dedup groups before re-populating
  DELETE FROM audit_dedup_groups
  WHERE object_type = 'contact' AND review_decision = 'pending';

  WITH snapshot AS (
    SELECT
      s.*,
      EXISTS (SELECT 1 FROM public.contacts c WHERE c.hubspot_contact_id = s.hubspot_id) AS is_v2_linked,
      (s.hubspot_owner_id IS NOT NULL AND s.owner_name != 'RepC Offterdinger') AS has_real_owner,
      (s.lead_summary IS NOT NULL) AS has_enrichment
    FROM audit_hs_contacts_snapshot s
    WHERE s.snapshot_id = p_snapshot_id
  ),
  email_groups AS (
    SELECT
      'email_exact' AS dedup_method,
      lower(trim(email)) AS dedup_key,
      array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST) AS member_ids,
      (array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST))[1] AS keeper_id,
      CASE
        WHEN bool_or(is_v2_linked) THEN 'v2_linked'
        WHEN bool_or(has_real_owner) THEN 'has_owner'
        WHEN bool_or(has_enrichment) THEN 'has_enrichment'
        ELSE 'oldest'
      END AS keeper_reason
    FROM snapshot
    WHERE email IS NOT NULL AND trim(email) != ''
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  ),
  linkedin_groups AS (
    SELECT
      'linkedin_exact' AS dedup_method,
      lower(trim(raw_properties->>'hs_linkedin_url')) AS dedup_key,
      array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST) AS member_ids,
      (array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST))[1] AS keeper_id,
      CASE
        WHEN bool_or(is_v2_linked) THEN 'v2_linked'
        WHEN bool_or(has_real_owner) THEN 'has_owner'
        WHEN bool_or(has_enrichment) THEN 'has_enrichment'
        ELSE 'oldest'
      END AS keeper_reason
    FROM snapshot
    WHERE raw_properties->>'hs_linkedin_url' IS NOT NULL
      AND trim(raw_properties->>'hs_linkedin_url') != ''
    GROUP BY lower(trim(raw_properties->>'hs_linkedin_url'))
    HAVING count(*) > 1
  ),
  name_company_groups AS (
    SELECT
      'name_company' AS dedup_method,
      lower(trim(firstname)) || '|' || lower(trim(lastname)) || '|' || associated_company_id AS dedup_key,
      array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST) AS member_ids,
      (array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST))[1] AS keeper_id,
      CASE
        WHEN bool_or(is_v2_linked) THEN 'v2_linked'
        WHEN bool_or(has_real_owner) THEN 'has_owner'
        WHEN bool_or(has_enrichment) THEN 'has_enrichment'
        ELSE 'oldest'
      END AS keeper_reason
    FROM snapshot
    WHERE firstname IS NOT NULL AND lastname IS NOT NULL
      AND associated_company_id IS NOT NULL
      AND trim(firstname) != '' AND trim(lastname) != ''
    GROUP BY lower(trim(firstname)), lower(trim(lastname)), associated_company_id
    HAVING count(*) > 1
  )
  INSERT INTO audit_dedup_groups (object_type, dedup_method, dedup_key, member_ids, keeper_id, keeper_reason)
  SELECT 'contact', dedup_method, dedup_key, member_ids, keeper_id, keeper_reason FROM email_groups
  UNION ALL
  SELECT 'contact', dedup_method, dedup_key, member_ids, keeper_id, keeper_reason FROM linkedin_groups
  UNION ALL
  SELECT 'contact', dedup_method, dedup_key, member_ids, keeper_id, keeper_reason FROM name_company_groups;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Dedup detection — companies (domain_exact, name_normalized)
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_company_dedup(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  DELETE FROM audit_dedup_groups
  WHERE object_type = 'company' AND review_decision = 'pending';

  WITH snapshot AS (
    SELECT
      s.*,
      EXISTS (SELECT 1 FROM public.companies c WHERE c.hubspot_company_id = s.hubspot_id) AS is_v2_linked,
      (s.hubspot_owner_id IS NOT NULL AND s.owner_name != 'RepC Offterdinger') AS has_real_owner,
      (s.lead_summary IS NOT NULL OR s.sales_org_summary IS NOT NULL) AS has_enrichment,
      regexp_replace(
        regexp_replace(
          lower(trim(coalesce(s.name, ''))),
          '\s+(inc\.?|llc\.?|ltd\.?|corp\.?|corporation|company|co\.?|gmbh|limited|plc)\s*$',
          '',
          'g'
        ),
        '[^a-z0-9]+', '', 'g'
      ) AS normalized_name
    FROM audit_hs_companies_snapshot s
    WHERE s.snapshot_id = p_snapshot_id
  ),
  domain_groups AS (
    SELECT
      'domain_exact' AS dedup_method,
      lower(trim(domain)) AS dedup_key,
      array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST) AS member_ids,
      (array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST))[1] AS keeper_id,
      CASE
        WHEN bool_or(is_v2_linked) THEN 'v2_linked'
        WHEN bool_or(has_real_owner) THEN 'has_owner'
        WHEN bool_or(has_enrichment) THEN 'has_enrichment'
        ELSE 'oldest'
      END AS keeper_reason
    FROM snapshot
    WHERE domain IS NOT NULL AND trim(domain) != ''
    GROUP BY lower(trim(domain))
    HAVING count(*) > 1
  ),
  name_groups AS (
    SELECT
      'name_normalized' AS dedup_method,
      normalized_name AS dedup_key,
      array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST) AS member_ids,
      (array_agg(hubspot_id ORDER BY is_v2_linked DESC, has_real_owner DESC, has_enrichment DESC, hs_createdate ASC NULLS LAST))[1] AS keeper_id,
      CASE
        WHEN bool_or(is_v2_linked) THEN 'v2_linked'
        WHEN bool_or(has_real_owner) THEN 'has_owner'
        WHEN bool_or(has_enrichment) THEN 'has_enrichment'
        ELSE 'oldest'
      END AS keeper_reason
    FROM snapshot
    WHERE normalized_name IS NOT NULL AND length(normalized_name) >= 3
    GROUP BY normalized_name
    HAVING count(*) > 1
  )
  INSERT INTO audit_dedup_groups (object_type, dedup_method, dedup_key, member_ids, keeper_id, keeper_reason)
  SELECT 'company', dedup_method, dedup_key, member_ids, keeper_id, keeper_reason FROM domain_groups
  UNION ALL
  SELECT 'company', dedup_method, dedup_key, member_ids, keeper_id, keeper_reason FROM name_groups;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Archive candidates — contacts
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_archive_contacts(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_archive_candidates (
    hubspot_id, object_type, flags, v2_linked, has_open_deal, has_syft_activity,
    days_since_created, days_since_modified, reason, last_detected_at
  )
  SELECT
    s.hubspot_id,
    'contact',
    ARRAY(
      SELECT unnest FROM unnest(ARRAY[
        CASE WHEN s.lead_summary IS NULL THEN 'no_enrichment' END,
        CASE WHEN s.hubspot_owner_id IS NULL THEN 'no_owner'
             WHEN s.owner_name = 'RepC Offterdinger' THEN 'rep_c_default' END,
        CASE WHEN s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead' THEN 'lifecycle_never_progressed' END,
        CASE WHEN s.hs_createdate < now() - INTERVAL '180 days' THEN 'old_180d' END,
        CASE WHEN s.syft_last_seen IS NULL OR s.syft_last_seen < now() - INTERVAL '90 days' THEN 'no_syft_activity' END
      ]) WHERE unnest IS NOT NULL
    ),
    false,
    false,
    (s.syft_last_seen IS NOT NULL AND s.syft_last_seen >= now() - INTERVAL '90 days'),
    EXTRACT(DAY FROM now() - s.hs_createdate)::int,
    EXTRACT(DAY FROM now() - s.hs_lastmodified)::int,
    'auto-detected: pre-V2, no enrichment, stale',
    now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.hubspot_contact_id = s.hubspot_id)
    AND s.lead_summary IS NULL
    AND (s.hubspot_owner_id IS NULL OR s.owner_name = 'RepC Offterdinger')
    AND (s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead')
    AND s.hs_createdate < now() - INTERVAL '180 days'
    AND (s.syft_last_seen IS NULL OR s.syft_last_seen < now() - INTERVAL '90 days')
  ON CONFLICT (hubspot_id, object_type) DO UPDATE
    SET flags = EXCLUDED.flags,
        v2_linked = EXCLUDED.v2_linked,
        has_open_deal = EXCLUDED.has_open_deal,
        has_syft_activity = EXCLUDED.has_syft_activity,
        days_since_created = EXCLUDED.days_since_created,
        days_since_modified = EXCLUDED.days_since_modified,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_archive_candidates.decision = 'pending';

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Archive candidates — companies
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_archive_companies(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_archive_candidates (
    hubspot_id, object_type, flags, v2_linked, has_open_deal, has_syft_activity,
    days_since_created, days_since_modified, reason, last_detected_at
  )
  SELECT
    s.hubspot_id,
    'company',
    ARRAY(
      SELECT unnest FROM unnest(ARRAY[
        CASE WHEN s.lead_summary IS NULL AND s.sales_org_summary IS NULL THEN 'no_enrichment' END,
        CASE WHEN s.hubspot_owner_id IS NULL THEN 'no_owner'
             WHEN s.owner_name = 'RepC Offterdinger' THEN 'rep_c_default' END,
        CASE WHEN s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead' THEN 'lifecycle_never_progressed' END,
        CASE WHEN s.hs_createdate < now() - INTERVAL '180 days' THEN 'old_180d' END,
        CASE WHEN s.domain IS NULL OR trim(s.domain) = '' THEN 'no_domain' END,
        CASE WHEN s.name IS NULL OR trim(s.name) = '' THEN 'no_name' END
      ]) WHERE unnest IS NOT NULL
    ),
    false,
    false,
    (s.syft_last_seen IS NOT NULL AND s.syft_last_seen >= now() - INTERVAL '90 days'),
    EXTRACT(DAY FROM now() - s.hs_createdate)::int,
    EXTRACT(DAY FROM now() - s.hs_lastmodified)::int,
    'auto-detected: pre-V2, no enrichment, stale',
    now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.hubspot_company_id = s.hubspot_id)
    AND s.lead_summary IS NULL
    AND s.sales_org_summary IS NULL
    AND (s.hubspot_owner_id IS NULL OR s.owner_name = 'RepC Offterdinger')
    AND (s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead')
    AND s.hs_createdate < now() - INTERVAL '180 days'
    AND (s.syft_last_seen IS NULL OR s.syft_last_seen < now() - INTERVAL '90 days')
  ON CONFLICT (hubspot_id, object_type) DO UPDATE
    SET flags = EXCLUDED.flags,
        v2_linked = EXCLUDED.v2_linked,
        has_open_deal = EXCLUDED.has_open_deal,
        has_syft_activity = EXCLUDED.has_syft_activity,
        days_since_created = EXCLUDED.days_since_created,
        days_since_modified = EXCLUDED.days_since_modified,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_archive_candidates.decision = 'pending';

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Enrichment gaps — contacts (priorities 2, 3, 4)
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_enrich_contacts(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_enrichment_gaps (hubspot_id, object_type, gap_type, priority, source, last_detected_at)
  SELECT s.hubspot_id, 'contact', 'v2_has_supabase_missing_hubspot', 2, 'supabase_push_needed', now()
  FROM audit_hs_contacts_snapshot s
  JOIN public.contacts c ON c.hubspot_contact_id = s.hubspot_id
  WHERE s.snapshot_id = p_snapshot_id
    AND s.lead_summary IS NULL
    AND c.lead_summary IS NOT NULL
  UNION ALL
  SELECT s.hubspot_id, 'contact', 'mql_no_tier', 3, 'needs_scoring', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND s.lifecyclestage = 'marketingqualifiedlead'
    AND s.lead_tier IS NULL
  UNION ALL
  SELECT s.hubspot_id, 'contact', 'hot_warm_no_icp', 4, 'needs_enrichment', now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND s.lead_tier IN ('Hot', 'Warm')
    AND s.icp_score IS NULL
  ON CONFLICT (hubspot_id, object_type, gap_type) DO UPDATE
    SET priority = EXCLUDED.priority,
        source = EXCLUDED.source,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_enrichment_gaps.resolved = false;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Enrichment gaps — companies (priorities 2, 4)
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_run_enrich_companies(p_snapshot_id timestamptz)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO audit_enrichment_gaps (hubspot_id, object_type, gap_type, priority, source, last_detected_at)
  SELECT s.hubspot_id, 'company', 'v2_has_supabase_missing_hubspot', 2, 'supabase_push_needed', now()
  FROM audit_hs_companies_snapshot s
  JOIN public.companies c ON c.hubspot_company_id = s.hubspot_id
  WHERE s.snapshot_id = p_snapshot_id
    AND s.lead_summary IS NULL
    AND c.lead_summary IS NOT NULL
  UNION ALL
  SELECT s.hubspot_id, 'company', 'hot_warm_no_icp', 4, 'needs_enrichment', now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND lower(coalesce(s.lead_tier, '')) IN ('hot', 'warm')
    AND s.icp_score IS NULL
  ON CONFLICT (hubspot_id, object_type, gap_type) DO UPDATE
    SET priority = EXCLUDED.priority,
        source = EXCLUDED.source,
        last_detected_at = EXCLUDED.last_detected_at
    WHERE audit_enrichment_gaps.resolved = false;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Drift computation — returns {added, removed, modified} for contacts + companies
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_compute_drift(p_snapshot_id timestamptz)
RETURNS TABLE (
  contacts_added int,
  contacts_removed int,
  contacts_modified int,
  companies_added int,
  companies_removed int,
  companies_modified int
)
LANGUAGE plpgsql
AS $$
DECLARE
  prev_contacts_snap timestamptz;
  prev_companies_snap timestamptz;
BEGIN
  SELECT DISTINCT snapshot_id INTO prev_contacts_snap
  FROM audit_hs_contacts_snapshot
  WHERE snapshot_id < p_snapshot_id
  ORDER BY snapshot_id DESC
  LIMIT 1;

  SELECT DISTINCT snapshot_id INTO prev_companies_snap
  FROM audit_hs_companies_snapshot
  WHERE snapshot_id < p_snapshot_id
  ORDER BY snapshot_id DESC
  LIMIT 1;

  RETURN QUERY
  SELECT
    (SELECT count(*)::int FROM audit_hs_contacts_snapshot cu
     WHERE cu.snapshot_id = p_snapshot_id
       AND prev_contacts_snap IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audit_hs_contacts_snapshot cp
         WHERE cp.snapshot_id = prev_contacts_snap AND cp.hubspot_id = cu.hubspot_id
       )
    ),
    (SELECT count(*)::int FROM audit_hs_contacts_snapshot cp
     WHERE cp.snapshot_id = prev_contacts_snap
       AND prev_contacts_snap IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audit_hs_contacts_snapshot cu
         WHERE cu.snapshot_id = p_snapshot_id AND cu.hubspot_id = cp.hubspot_id
       )
    ),
    (SELECT count(*)::int FROM audit_hs_contacts_snapshot cu
     JOIN audit_hs_contacts_snapshot cp ON cp.hubspot_id = cu.hubspot_id
     WHERE cu.snapshot_id = p_snapshot_id
       AND cp.snapshot_id = prev_contacts_snap
       AND prev_contacts_snap IS NOT NULL
       AND (cu.email IS DISTINCT FROM cp.email
            OR cu.lifecyclestage IS DISTINCT FROM cp.lifecyclestage
            OR cu.hubspot_owner_id IS DISTINCT FROM cp.hubspot_owner_id
            OR cu.lead_tier IS DISTINCT FROM cp.lead_tier)
    ),
    (SELECT count(*)::int FROM audit_hs_companies_snapshot cu
     WHERE cu.snapshot_id = p_snapshot_id
       AND prev_companies_snap IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audit_hs_companies_snapshot cp
         WHERE cp.snapshot_id = prev_companies_snap AND cp.hubspot_id = cu.hubspot_id
       )
    ),
    (SELECT count(*)::int FROM audit_hs_companies_snapshot cp
     WHERE cp.snapshot_id = prev_companies_snap
       AND prev_companies_snap IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audit_hs_companies_snapshot cu
         WHERE cu.snapshot_id = p_snapshot_id AND cu.hubspot_id = cp.hubspot_id
       )
    ),
    (SELECT count(*)::int FROM audit_hs_companies_snapshot cu
     JOIN audit_hs_companies_snapshot cp ON cp.hubspot_id = cu.hubspot_id
     WHERE cu.snapshot_id = p_snapshot_id
       AND cp.snapshot_id = prev_companies_snap
       AND prev_companies_snap IS NOT NULL
       AND (cu.domain IS DISTINCT FROM cp.domain
            OR cu.lifecyclestage IS DISTINCT FROM cp.lifecyclestage
            OR cu.hubspot_owner_id IS DISTINCT FROM cp.hubspot_owner_id
            OR cu.lead_tier IS DISTINCT FROM cp.lead_tier)
    );
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Prune old snapshots — keeps last N snapshot_ids per table
-- ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_prune_snapshots(p_keep int DEFAULT 4)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count int;
  total_deleted int := 0;
BEGIN
  DELETE FROM audit_hs_contacts_snapshot
  WHERE snapshot_id NOT IN (
    SELECT DISTINCT snapshot_id FROM audit_hs_contacts_snapshot
    ORDER BY snapshot_id DESC LIMIT p_keep
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  total_deleted := total_deleted + deleted_count;

  DELETE FROM audit_hs_companies_snapshot
  WHERE snapshot_id NOT IN (
    SELECT DISTINCT snapshot_id FROM audit_hs_companies_snapshot
    ORDER BY snapshot_id DESC LIMIT p_keep
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  total_deleted := total_deleted + deleted_count;

  RETURN total_deleted;
END;
$$;
