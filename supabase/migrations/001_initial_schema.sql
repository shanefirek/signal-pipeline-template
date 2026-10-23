-- Acme GTM pipe schema
-- Replaces Clay's 6 tables with real Postgres
-- Source of truth: Clay table schemas (~/projects/acme-clay/tables/) + scoring-spec-v2.md

-- Enum types
CREATE TYPE lead_tier AS ENUM ('hot', 'warm', 'cool', 'cold');
CREATE TYPE signal_source AS ENUM (
  'syft_website', 'syft_linkedin',
  'rep_a_list', 'rep_d_list',
  'hubspot_backfill', 'hubspot_deal_created',
  'company_discovery', 'fibbler_engagement',
  'posthog_identify', 'csv_upload',
  'starbridge_signal', 'manual_import'
);
CREATE TYPE processing_status AS ENUM ('pending', 'enriching', 'scoring', 'pushing', 'done', 'error');

-- ============================================================
-- DOMAIN BLOCKLIST (replaces Clay Domain Blocklist table t_0tbhdkbpjbtRNJxKqRK)
-- 56 domains: customers + partners + internal + closed_lost
-- ============================================================
CREATE TABLE domain_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text UNIQUE NOT NULL,
  reason text, -- 'customer', 'partner', 'internal', 'closed_lost'
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- COMPANIES (replaces Company Profiles table t_0taokwtW3Na6hK7eWix)
-- ~259 rows, ~96 pushed to HubSpot
-- ============================================================
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text UNIQUE NOT NULL,
  name text,

  -- MixRank enrichment (from Company Info action f_0taolalFoEhC3QN39GQ)
  industry text,
  employee_count integer,
  annual_revenue text,           -- MixRank field, used for Company Stage Score (NOT funding)
  locality text,                 -- Raw MixRank field, city/state parsed from this
  city text,                     -- Parsed: locality.split(",")[0].trim()
  state text,                    -- Parsed: locality.split(",")[1].trim()
  country text,
  description text,
  linkedin_url text,

  -- AI classification (Sub-Market Classification f_0taqhp1HqHs7FuEqExb)
  sub_market text,               -- One of 19 categories: "K12 EdTech SaaS", "Higher Ed", "Not B2B", etc.
  sub_market_reason text,        -- AI's one-sentence reason

  -- Sales team data (MixRank people search f_0taqldgbBHMjTt2TCXa)
  sales_team_data jsonb,         -- Raw MixRank people results
  sales_hiring_data jsonb,       -- Raw MixRank jobs results (f_0taqhoauYYBdSSy33Zx)

  -- AI scoring outputs
  outbound_need_score integer DEFAULT 0,  -- 0-50, AI-scored (f_0taqljtPSdB2cDkvWgb)
  sales_org_summary text,                  -- 1-2 sentence summary (f_0taqljyZocMQQBkoJWw)
  lead_summary text,                       -- 3-sentence pain-point briefing (f_0tb8krlvUZ7dja4Srw5)

  -- ICP scoring breakdown (0-125 total)
  vertical_fit_score integer DEFAULT 0,    -- 0-35, from sub_market mapping
  headcount_score integer DEFAULT 0,       -- 0-15, from employee_count
  company_stage_score integer DEFAULT 0,   -- 0-30, from annual_revenue
  sales_team_score integer DEFAULT 0,      -- 0-50, extracted from outbound_need_score AI
  icp_score integer DEFAULT 0,             -- Sum of above four

  -- Lead temp (company-level, from ICP score)
  lead_temp text,                -- 'Hot' (ICP>=100), 'Warm' (ICP>=60), 'Cold'

  -- Attribution (from Normalization source data)
  lead_source text,              -- syft_website, syft_linkedin, fibbler_engagement, etc.
  lead_origin text,              -- "Clay" until coordinated cutover (9 HubSpot workflows filter on this)
  first_touch_source text,
  touch_channels text,
  touch_campaigns text,
  utm_sources text,
  utm_medium text,
  latest_source text,
  matched_intents text,
  pages_viewed text,
  lead_personas text,
  syft_intent_level text,        -- Very High, High, Medium, Low

  -- HubSpot sync
  hubspot_company_id text,
  hubspot_pushed_at timestamptz,
  hubspot_updated_at timestamptz,

  -- Enrichment metadata
  enriched_at timestamptz,
  enrichment_sources text[],     -- Which providers returned data

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- RAW SIGNALS (replaces Normalization table t_0taomlkjy4mF9dPf9SE
--   + Website Visitors Webhook t_0taf3tvBC8Z7gwrAS4c
--   + LinkedIn Activity Webhook t_0taf3tzaHxppcjAhsqt)
-- ============================================================
CREATE TABLE raw_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source signal_source NOT NULL,
  raw_payload jsonb NOT NULL,

  -- Extracted from Syft webhook payload
  domain text,                   -- Cleaned: lowercase, no protocol/www/trailing slash
  domain_raw text,               -- Original domain before cleaning
  email text,                    -- Cleaned: handle literal "null" string from Syft
  first_name text,
  last_name text,
  contact_name text,             -- Computed: first + last
  company_name text,
  title text,
  linkedin_url text,             -- Person LinkedIn URL
  company_linkedin_url text,
  employees text,                -- From Syft (string, not int)
  industry text,
  city text,
  state text,
  country text,

  -- Syft signal data
  page_views integer DEFAULT 0,
  sessions integer DEFAULT 0,
  active_time_seconds integer DEFAULT 0,
  visitor_count integer DEFAULT 0,
  linkedin_action text,          -- comment, like, reaction, profile_view, form, message, dm
  syft_purchase_intent text,     -- Very High, High, Medium, Low
  syft_intent_level text,        -- Syft's own intent classification
  icp_match text,                -- Syft's ICP match field
  last_seen text,

  -- Syft attribution
  utm_channel text,              -- LinkedIn, Paid, Google, Direct, Organic, Referral
  utm_sources text,
  utm_medium text,
  first_touch_source text,
  touch_channels text,
  touch_campaigns text,
  referrers text,
  latest_source text,
  matched_intents text,
  high_intent_sessions integer DEFAULT 0,
  session_pages_visited text,    -- Comma-separated page URLs
  pages_viewed text,
  lead_personas text,
  lead_source text,              -- syft_website, syft_linkedin (set by webhook handler)

  -- Validation results
  validation text,               -- 'pass' or 'fail' + reason
  validation_gate boolean DEFAULT false,  -- pass + (pageViews > 0 OR has linkedin_action)
  is_not_customer boolean,       -- HubSpot lifecycle check + blocklist check
  is_not_blocked boolean,        -- Domain blocklist check

  -- Dedup results
  company_exists boolean DEFAULT false,
  contact_exists_clay boolean DEFAULT false,
  contact_exists_hubspot boolean DEFAULT false,

  -- Processing state
  status processing_status DEFAULT 'pending',
  company_id uuid,               -- Set after company upsert
  contact_id uuid,               -- Set after contact upsert
  error text,

  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

-- ============================================================
-- CONTACTS (replaces Contact Profiles table t_0taqh4mZJ8nEsoCZMpJ)
-- ~379 rows
-- ============================================================
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  domain text,

  -- Identity
  email text,
  email_verified boolean DEFAULT false,
  email_source text,             -- Which waterfall step found/verified: findymail_validate, findymail_find, leadmagic_validate, leadmagic_find, leadmagic_validate2
  first_name text,
  last_name text,
  full_name text GENERATED ALWAYS AS (
    COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')
  ) STORED,
  title text,
  linkedin_url text,
  phone text,
  phone_source text,             -- leadmagic_mobile

  -- MixRank person verification (f_0tbn8fyCxJK8Egijjef)
  verified_company_domain text,  -- MixRank current_experience[0].company_domain
  company_match text,            -- 'match', 'mismatch', 'unverified'

  -- Signal type (human-readable source label)
  signal_type text,              -- 'Company Intent', 'LinkedIn Engagement', 'Deal Created', etc.

  -- Scoring (from lookups to companies + signals)
  icp_score integer DEFAULT 0,          -- From Company ICP Lookup
  intent_score integer DEFAULT 0,       -- Max Intent Score from Signal Scoring
  combined_score integer GENERATED ALWAYS AS (
    COALESCE(icp_score, 0) + COALESCE(intent_score, 0)
  ) STORED,
  tier lead_tier,

  -- AI outputs
  lead_summary text,             -- 2-3 sentence person briefing (f_0tb8kx6w5kZ7jrNNirj)

  -- Attribution
  lead_origin text DEFAULT 'Clay',      -- System source (hardcoded in Clay)
  lead_source text,                      -- syft_website, syft_linkedin, company_discovery, hubspot_deal_created
  first_touch_channel text,
  utm_source text,
  utm_medium text,
  utm_campaign text,

  -- Re-enrichment tracking
  last_signal_date timestamptz,          -- Max Updated At from Intent Lookup
  needs_refresh boolean DEFAULT false,   -- true when latest signal > contact created_at
  refresh_trigger timestamptz,           -- Dummy field for triggering re-enrichment cascade

  -- HubSpot sync
  hubspot_contact_id text,
  hubspot_pushed_at timestamptz,
  hubspot_updated_at timestamptz,
  hubspot_company_precheck boolean,      -- Whether company already existed in HubSpot (saves waterfall credits)

  -- Enrichment metadata
  enriched_at timestamptz,
  enrichment_sources text[],

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(email),
  UNIQUE(linkedin_url)
);

-- ============================================================
-- SIGNALS (replaces Signal Scoring table t_0taqh4m4K7qsUCoXXto)
-- ~129 rows, all formulas, zero credits
-- ============================================================
CREATE TABLE signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_signal_id uuid REFERENCES raw_signals(id),
  company_id uuid REFERENCES companies(id),
  contact_id uuid,               -- May be null (signal arrives before contact is created)
  source signal_source NOT NULL,
  domain text NOT NULL,

  -- Signal data (from Normalization routing)
  company_name text,
  contact_name text,
  title text,
  email text,
  linkedin_url text,
  country text,

  -- Engagement data
  page_views integer DEFAULT 0,
  sessions integer DEFAULT 0,
  active_time_seconds integer DEFAULT 0,
  visitor_count integer DEFAULT 0,
  linkedin_action text,
  utm_channel text,
  syft_purchase_intent text,     -- Raw Syft value
  syft_intent_level text,
  high_intent_sessions integer DEFAULT 0,
  session_pages_visited text,    -- Comma-separated page URLs
  pages_viewed text,             -- Legacy field

  -- Intent scoring breakdown (0-120 total)
  purchase_intent_score integer DEFAULT 0,    -- 0-20: Very High/High=20, Medium=10
  engagement_depth_score integer DEFAULT 0,   -- 0-25 (capped): pageViews>=3→15, sessions>=2→10, activeTime>=300→10, visitorCount>3→5/>1→2
  direct_action_score integer DEFAULT 0,      -- 0-35: form/message/dm=35, comment=15, like/reaction/profile_view=5
  referral_source_score integer DEFAULT 0,    -- 0-10: linkedin=10, paid/google/direct/organic/referral/nodata=5
  page_intent_score integer DEFAULT 0,        -- 0-30: pricing/results/case-study=30, about/services/solutions=15, any=5
  intent_score integer DEFAULT 0,             -- Sum of 5 components

  -- ICP lookup (from Company Profiles)
  icp_score integer DEFAULT 0,                -- Looked up from companies table
  total_score integer DEFAULT 0,              -- icp_score + intent_score
  lead_tier lead_tier,                        -- Hot>=100, Warm>=60, Cool>=30, Cold<30

  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- PUSH LOG (tracks what we've sent to HubSpot/Slack)
-- ============================================================
CREATE TABLE push_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,     -- 'company', 'contact', 'alert'
  entity_id uuid,
  destination text NOT NULL,     -- 'hubspot', 'slack'
  action text NOT NULL,          -- 'create', 'update', 'alert'
  payload jsonb,
  response jsonb,
  success boolean DEFAULT false,
  error text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Raw signals
CREATE INDEX idx_raw_signals_status ON raw_signals(status) WHERE status != 'done';
CREATE INDEX idx_raw_signals_domain ON raw_signals(domain);
CREATE INDEX idx_raw_signals_source ON raw_signals(source);

-- Companies
CREATE INDEX idx_companies_domain ON companies(domain);
CREATE INDEX idx_companies_hubspot ON companies(hubspot_company_id) WHERE hubspot_company_id IS NOT NULL;
CREATE INDEX idx_companies_icp ON companies(icp_score DESC);
CREATE INDEX idx_companies_sub_market ON companies(sub_market) WHERE sub_market IS NOT NULL;

-- Contacts
CREATE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_domain ON contacts(domain);
CREATE INDEX idx_contacts_linkedin ON contacts(linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE INDEX idx_contacts_hubspot ON contacts(hubspot_contact_id) WHERE hubspot_contact_id IS NOT NULL;
CREATE INDEX idx_contacts_tier ON contacts(tier);
CREATE INDEX idx_contacts_combined_score ON contacts(combined_score DESC);
CREATE INDEX idx_contacts_needs_refresh ON contacts(needs_refresh) WHERE needs_refresh = true;

-- Signals
CREATE INDEX idx_signals_domain ON signals(domain);
CREATE INDEX idx_signals_company ON signals(company_id);
CREATE INDEX idx_signals_contact ON signals(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_signals_lead_tier ON signals(lead_tier);

-- Push log
CREATE INDEX idx_push_log_entity ON push_log(entity_type, entity_id);

-- Domain blocklist
CREATE INDEX idx_blocklist_domain ON domain_blocklist(domain);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FOREIGN KEYS (deferred — contacts.company_id added after companies exists)
-- ============================================================
ALTER TABLE raw_signals ADD CONSTRAINT fk_raw_signals_company
  FOREIGN KEY (company_id) REFERENCES companies(id);
ALTER TABLE raw_signals ADD CONSTRAINT fk_raw_signals_contact
  FOREIGN KEY (contact_id) REFERENCES contacts(id);
ALTER TABLE contacts ADD CONSTRAINT fk_contacts_company
  FOREIGN KEY (company_id) REFERENCES companies(id);
