-- Add ae_owner to contacts — AE ownership lives on the contact, not the company.
-- Companies have territory assignment (companies.ae_owner = "RepB's TAM list").
-- Contacts have work ownership (contacts.ae_owner = "RepB is calling this person").
-- HubSpot mirrors this: hubspot_owner_id is a contact property, not company.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ae_owner text;

-- Index for AE-filtered views
CREATE INDEX IF NOT EXISTS idx_contacts_ae_owner ON contacts(ae_owner) WHERE ae_owner IS NOT NULL;

-- Backfill from company's ae_owner for existing TAM contacts
UPDATE contacts c
SET ae_owner = comp.ae_owner
FROM companies comp
WHERE c.company_id = comp.id
  AND comp.ae_owner IS NOT NULL
  AND c.ae_owner IS NULL;
