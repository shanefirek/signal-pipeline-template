-- Re-enrichment tracking: detect org changes, job departures, email decay
-- Companies get re-qualified via Octave biweekly. Contacts get verified monthly.

-- Companies: track re-qualification cycle (separate from initial octave_qualified_at)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS last_requalified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requalification_count INTEGER NOT NULL DEFAULT 0;

-- Contacts: track refresh outcomes
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_bounce_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS job_change_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previous_title TEXT,
  ADD COLUMN IF NOT EXISTS previous_contact_name TEXT;

-- Partial index: company refresh eligibility (stalest first)
CREATE INDEX IF NOT EXISTS idx_companies_refresh_eligible
  ON companies(octave_qualified_at ASC)
  WHERE icp_score >= 60 AND hubspot_company_id IS NOT NULL;

-- Partial index: contact refresh eligibility
CREATE INDEX IF NOT EXISTS idx_contacts_refresh_eligible
  ON contacts(enriched_at ASC)
  WHERE tier IN ('hot', 'warm') AND hubspot_contact_id IS NOT NULL;
