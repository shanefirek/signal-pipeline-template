-- Hardening: constraints, indexes, and dedup guards
-- Prevents the bugs we hit with Clay (38% contact dupes, missing identifiers, stale data)

-- Contacts must have at least one identifier (email or linkedin_url)
-- This prevents phantom contact rows that can never be pushed to HubSpot
ALTER TABLE contacts ADD CONSTRAINT contacts_has_identifier
  CHECK (email IS NOT NULL OR linkedin_url IS NOT NULL);

-- Dedup guard: index on domain + status for fast pending-signal lookups
-- Normalize task handles dedup logic (checks for in-flight enrichments within 10 min)
-- No UNIQUE constraint — multiple signals per domain per hour are legitimate (different visitors)
CREATE INDEX idx_raw_signals_domain_status
  ON raw_signals (domain, status, created_at DESC)
  WHERE status IN ('pending', 'enriching');

-- Octave results: ensure we don't double-process callbacks
CREATE UNIQUE INDEX idx_octave_results_request_unique
  ON octave_results (request_id);

-- Add missing contact_id FK on signals (was nullable but not explicitly FK'd)
ALTER TABLE signals ADD CONSTRAINT fk_signals_contact
  FOREIGN KEY (contact_id) REFERENCES contacts(id);

-- Companies: add octave_qualified_at index for stale detection
CREATE INDEX idx_companies_octave_qualified
  ON companies(octave_qualified_at DESC)
  WHERE octave_qualified_at IS NOT NULL;

-- Push log: add timestamp index for recent push queries
CREATE INDEX idx_push_log_recent
  ON push_log(created_at DESC);

-- Contacts: add company_id index (used in every enrichment lookup)
CREATE INDEX idx_contacts_company
  ON contacts(company_id)
  WHERE company_id IS NOT NULL;
