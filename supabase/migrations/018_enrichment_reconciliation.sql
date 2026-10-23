-- Enrichment Reconciliation Tables
--
-- Apr 22 2026 — Audit trail for every Cargo + LeadMagic API call.
-- Supports: credit tracking, duplicate spend detection, raw response archival,
-- and dedup guards (Phase 3).
--
-- Three tables:
--   enrichment_log        — immutable audit trail, one row per API call
--   enrichment_credits    — daily rollup for cost queries
--   enrichment_dedup_cache — fast lookup for dedup guards
--
-- These are audit tables (like push_log / octave_results).
-- Write-heavy, read-rare. Never read by production triggers (except dedup_cache in Phase 3).

-- ───────────────────────────────────────────────────────────────────────
-- 1. enrichment_log — one row per provider API call
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrichment_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider + operation
  provider            text NOT NULL,       -- 'cargo' | 'leadmagic'
  operation           text NOT NULL,       -- 'verify_employment' | 'verify_employment_url' | 'find_email' | 'verify_email' | 'find_phone' | 'find_stakeholders' | 'employee_finder' | 'find_work_email' | 'validate_email' | 'find_mobile_phone' | 'company_search' | 'jobs_finder' | 'technographics'

  -- Linkage to operational tables (nullable — backfill won't always match)
  contact_id          uuid REFERENCES contacts(id),
  company_id          uuid REFERENCES companies(id),

  -- Dedup key: normalized identifier for what we enriched
  lookup_key          text NOT NULL,       -- email, linkedin slug, "first|last|domain", or domain

  -- Full payloads
  input_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload      jsonb,               -- full response (null if error)

  -- Cargo-specific linkage
  cargo_run_id        text,                -- Cargo orchestration run UUID
  cargo_workflow_id   text,                -- Which Cargo workflow was used

  -- Credit tracking
  credits_estimated   numeric(6,2) NOT NULL DEFAULT 0,

  -- Call metadata
  trigger_source      text,                -- 'enrich-contact' | 'discover-contact' | 'tam-enrich' | 'enrich-deal-contact' | 'email-waterfall' | 'script:<name>'
  duration_ms         integer,
  success             boolean NOT NULL DEFAULT false,
  error               text,

  -- Timestamps
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Backfill marker
  backfilled          boolean NOT NULL DEFAULT false
);

-- Dedup detection: same provider+operation+lookup_key within a time window
CREATE INDEX IF NOT EXISTS enrichment_log_dedup_idx
  ON enrichment_log (provider, operation, lookup_key, created_at DESC);

-- Credit audit: sum by provider over time
CREATE INDEX IF NOT EXISTS enrichment_log_credits_idx
  ON enrichment_log (provider, created_at DESC);

-- Linkage lookups
CREATE INDEX IF NOT EXISTS enrichment_log_contact_idx
  ON enrichment_log (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enrichment_log_company_idx
  ON enrichment_log (company_id) WHERE company_id IS NOT NULL;

-- Cargo run dedup (idempotent backfill)
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_log_cargo_run_idx
  ON enrichment_log (cargo_run_id) WHERE cargo_run_id IS NOT NULL;

COMMENT ON TABLE enrichment_log IS 'Audit trail for every enrichment API call (Cargo + LeadMagic). Write-heavy, read-rare. Backfilled rows marked backfilled=true.';

-- ───────────────────────────────────────────────────────────────────────
-- 2. enrichment_credits — daily rollup for cost queries
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrichment_credits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  date                date NOT NULL,
  provider            text NOT NULL,
  operation           text NOT NULL,
  trigger_source      text,

  call_count          integer NOT NULL DEFAULT 0,
  credits_total       numeric(8,2) NOT NULL DEFAULT 0,
  success_count       integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,
  duplicate_count     integer NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (date, provider, operation, trigger_source)
);

CREATE INDEX IF NOT EXISTS enrichment_credits_date_idx
  ON enrichment_credits (date DESC);

COMMENT ON TABLE enrichment_credits IS 'Daily rollup of enrichment credit consumption by provider/operation/trigger. Upserted on each enrichment call.';

-- ───────────────────────────────────────────────────────────────────────
-- 3. enrichment_dedup_cache — fast lookup for dedup guards (Phase 3)
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrichment_dedup_cache (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider              text NOT NULL,
  operation             text NOT NULL,
  lookup_key            text NOT NULL,

  last_enriched_at      timestamptz NOT NULL,
  last_result_summary   jsonb,              -- compact result: { verified: true, email: "..." }
  enrichment_log_id     uuid REFERENCES enrichment_log(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, operation, lookup_key)
);

COMMENT ON TABLE enrichment_dedup_cache IS 'Fast dedup lookup: skip re-enrichment if same provider+operation+lookup_key was enriched recently. Upserted by enrichment-logger.ts.';
