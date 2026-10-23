-- Add lead_type and has_intent_signal to contacts table
-- lead_type: Separates MQL workflows (inbound) from TAM workflows (outbound)
-- has_intent_signal: Tracks when an outbound contact shows buying intent (two things can be true)

-- Add lead_type column (inbound / outbound / referral / unknown)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_type TEXT;

-- Add has_intent_signal boolean (default false)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS has_intent_signal BOOLEAN DEFAULT FALSE;

-- Create index for workflow filtering
CREATE INDEX IF NOT EXISTS idx_contacts_lead_type ON contacts(lead_type);
CREATE INDEX IF NOT EXISTS idx_contacts_has_intent_signal ON contacts(has_intent_signal) WHERE has_intent_signal = TRUE;

-- Backfill existing contacts based on lead_source
-- inbound sources: syft_website, syft_linkedin, fibbler_engagement, company_discovery, posthog_identify
-- outbound sources: tam_import
-- referral sources: salesnav_import, starbridge_referral
UPDATE contacts
SET lead_type = CASE
  WHEN lead_source IN ('syft_website', 'syft_linkedin', 'fibbler_engagement', 'company_discovery', 'posthog_identify') THEN 'inbound'
  WHEN lead_source = 'tam_import' THEN 'outbound'
  WHEN lead_source IN ('salesnav_import', 'starbridge_referral') THEN 'referral'
  ELSE 'unknown'
END
WHERE lead_type IS NULL;

-- Set has_intent_signal = true for any outbound contact at a domain that has inbound signals
UPDATE contacts c
SET has_intent_signal = TRUE
WHERE c.lead_type = 'outbound'
  AND c.has_intent_signal = FALSE
  AND EXISTS (
    SELECT 1 FROM signals s
    WHERE s.domain = c.domain
      AND s.source IN ('syft_website', 'syft_linkedin', 'fibbler_engagement', 'posthog_identify')
  );
