-- Tune the archive candidate detection threshold from 180 days to 90 days.
--
-- Apr 9 2026 — The first parity audit run found 0 archive candidates because
-- the ACME HubSpot portal was only provisioned in early November 2025 (see
-- audit_hs_*_snapshot — oldest createdate is 2025-11-02). With a 180-day
-- age floor, no records qualified because the oldest is only 158 days old.
--
-- Lowering to 90 days catches 134 contacts and 5,226 companies as archive
-- candidates, which matches the order of magnitude the audit-hubspot-state
-- script found yesterday. Syft staleness floor stays at 90 days (separate
-- check).
--
-- Same logic otherwise — only the INTERVAL literal changes.

-- ───────────────────────────────────────────────────────────────────────
-- audit_run_archive_contacts — threshold 180 → 90 days
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
        CASE WHEN s.hs_createdate < now() - INTERVAL '90 days' THEN 'old_90d' END,
        CASE WHEN s.syft_last_seen IS NULL OR s.syft_last_seen < now() - INTERVAL '90 days' THEN 'no_syft_activity' END
      ]) WHERE unnest IS NOT NULL
    ),
    false,
    false,
    (s.syft_last_seen IS NOT NULL AND s.syft_last_seen >= now() - INTERVAL '90 days'),
    EXTRACT(DAY FROM now() - s.hs_createdate)::int,
    EXTRACT(DAY FROM now() - s.hs_lastmodified)::int,
    'auto-detected: pre-V2, no enrichment, stale (>=90d)',
    now()
  FROM audit_hs_contacts_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.hubspot_contact_id = s.hubspot_id)
    AND s.lead_summary IS NULL
    AND (s.hubspot_owner_id IS NULL OR s.owner_name = 'RepC Offterdinger')
    AND (s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead')
    AND s.hs_createdate < now() - INTERVAL '90 days'
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
-- audit_run_archive_companies — threshold 180 → 90 days
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
        CASE WHEN s.hs_createdate < now() - INTERVAL '90 days' THEN 'old_90d' END,
        CASE WHEN s.domain IS NULL OR trim(s.domain) = '' THEN 'no_domain' END,
        CASE WHEN s.name IS NULL OR trim(s.name) = '' THEN 'no_name' END
      ]) WHERE unnest IS NOT NULL
    ),
    false,
    false,
    (s.syft_last_seen IS NOT NULL AND s.syft_last_seen >= now() - INTERVAL '90 days'),
    EXTRACT(DAY FROM now() - s.hs_createdate)::int,
    EXTRACT(DAY FROM now() - s.hs_lastmodified)::int,
    'auto-detected: pre-V2, no enrichment, stale (>=90d)',
    now()
  FROM audit_hs_companies_snapshot s
  WHERE s.snapshot_id = p_snapshot_id
    AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.hubspot_company_id = s.hubspot_id)
    AND s.lead_summary IS NULL
    AND s.sales_org_summary IS NULL
    AND (s.hubspot_owner_id IS NULL OR s.owner_name = 'RepC Offterdinger')
    AND (s.lifecyclestage IS NULL OR s.lifecyclestage = 'lead')
    AND s.hs_createdate < now() - INTERVAL '90 days'
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
