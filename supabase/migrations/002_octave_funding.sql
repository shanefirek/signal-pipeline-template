-- Octave + funding fields on companies table
-- Octave QUALIFY_COMPANY returns: score, rationale, funding rounds, segment, playbook
-- This replaces Apollo/Cargo/MixRank for company enrichment

-- ============================================================
-- COMPANIES: Octave enrichment + funding fields
-- ============================================================

-- Octave qualification
ALTER TABLE companies ADD COLUMN octave_score integer;           -- 1-10 from QUALIFY_COMPANY
ALTER TABLE companies ADD COLUMN octave_rationale text;          -- 1-2 sentence rationale
ALTER TABLE companies ADD COLUMN octave_raw jsonb;               -- Full QUALIFY response for audit
ALTER TABLE companies ADD COLUMN octave_request_id text;         -- Async request tracking
ALTER TABLE companies ADD COLUMN octave_qualified_at timestamptz; -- When Octave ran

-- Octave segment/product match
ALTER TABLE companies ADD COLUMN octave_segment text;            -- e.g. "K-12 Pipeline-Driven EdTech Sellers"
ALTER TABLE companies ADD COLUMN octave_product text;            -- e.g. "K12 SDR Services"
ALTER TABLE companies ADD COLUMN octave_playbook text;           -- Matched playbook name
ALTER TABLE companies ADD COLUMN octave_disqualifiers text[];    -- Any disqualifier flags

-- Funding (extracted from crunchBaseFunding[] in Octave response)
ALTER TABLE companies ADD COLUMN funding_stage text;             -- Seed, Series A, Series B, etc.
ALTER TABLE companies ADD COLUMN funding_total numeric;          -- Total raised in latest round (dollars)
ALTER TABLE companies ADD COLUMN funding_date date;              -- Date of latest round
ALTER TABLE companies ADD COLUMN investors text[];               -- Investor names from latest round
ALTER TABLE companies ADD COLUMN funding_round_count integer;    -- Total number of rounds

-- ICP scoring: new funding component + Octave-derived score
ALTER TABLE companies ADD COLUMN funding_score integer DEFAULT 0; -- 0-30, from funding_stage
ALTER TABLE companies ADD COLUMN octave_icp_score integer;       -- ICP mapped from Octave 1-10 + funding

-- Starbridge overlay (schema only — filled in Phase 5)
ALTER TABLE companies ADD COLUMN starbridge_buyer_id text;
ALTER TABLE companies ADD COLUMN starbridge_contract_count integer;
ALTER TABLE companies ADD COLUMN starbridge_last_contract_date date;

-- ============================================================
-- OCTAVE_RESULTS: Audit trail for every Octave agent call
-- ============================================================
CREATE TABLE octave_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  agent_id text NOT NULL,                -- Which Octave agent was called
  agent_type text NOT NULL,              -- 'qualify', 'prospector', 'email', 'call_prep'
  request_id text NOT NULL,              -- Octave async request ID
  domain text,
  input_payload jsonb,                   -- What we sent
  output_payload jsonb,                  -- What came back
  score integer,                         -- Octave score if applicable
  credits_used integer,                  -- Estimated credits consumed
  duration_ms integer,                   -- How long the agent took
  status text DEFAULT 'pending',         -- pending, completed, failed
  error text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- ============================================================
-- OUTBOUND_SEQUENCES: Generated email sequences (Phase 3)
-- ============================================================
CREATE TABLE outbound_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id),
  company_id uuid REFERENCES companies(id),
  agent_id text,                         -- Which EMAIL agent generated it
  sequence_type text,                    -- 'cold_k12', 'cold_pe', etc.
  steps jsonb,                           -- Array of { step_number, subject, body, send_delay_days }
  status text DEFAULT 'draft',           -- draft, approved, sent_to_lemlist, active, completed
  lemlist_campaign_id text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- SCHEDULED_RUNS: Tracks cron/scheduled task executions
-- ============================================================
CREATE TABLE scheduled_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_name text NOT NULL,               -- 'deal-sync', 'contact-backfill', 'stale-refresh', etc.
  trigger_type text NOT NULL,            -- 'scheduled', 'webhook', 'manual'
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  records_processed integer DEFAULT 0,
  records_created integer DEFAULT 0,
  records_updated integer DEFAULT 0,
  records_errored integer DEFAULT 0,
  error text,
  metadata jsonb                         -- Task-specific data
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_companies_octave_score ON companies(octave_score DESC) WHERE octave_score IS NOT NULL;
CREATE INDEX idx_companies_funding_stage ON companies(funding_stage) WHERE funding_stage IS NOT NULL;
-- vertical column removed — sub_market serves the same purpose
CREATE INDEX idx_octave_results_company ON octave_results(company_id);
CREATE INDEX idx_octave_results_request ON octave_results(request_id);
CREATE INDEX idx_octave_results_status ON octave_results(status) WHERE status != 'completed';
CREATE INDEX idx_scheduled_runs_task ON scheduled_runs(task_name, started_at DESC);
