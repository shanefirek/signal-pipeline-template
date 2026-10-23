-- Migration 009: TAM support + lead_origin derivation
--
-- Adds TAM list/tier/owner columns for territory management.
-- TAM imports don't create raw_signals — they go straight to companies/contacts
-- with lead_source = 'tam_import' and get picked up by re-enrichment crons.

-- Companies: TAM territory fields
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tam_list text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tam_tier text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tam_added_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ae_owner text;

-- Contacts: TAM territory fields (inherited from company on discovery)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tam_list text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tam_tier text;

-- Index for territory queries
CREATE INDEX IF NOT EXISTS idx_companies_tam ON companies(tam_list, tam_tier) WHERE tam_list IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tam ON contacts(tam_list) WHERE tam_list IS NOT NULL;

-- Index for ae_owner queries
CREATE INDEX IF NOT EXISTS idx_companies_ae_owner ON companies(ae_owner) WHERE ae_owner IS NOT NULL;
