-- MQL tracking: own the MQL decision in Trigger.dev, not HubSpot workflows
--
-- MQL = inbound signal + qualified tier (hot/warm)
-- TAM outbound contacts are NOT MQLs regardless of tier

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mql_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_mql BOOLEAN DEFAULT FALSE;

-- Index for MQL queries
CREATE INDEX IF NOT EXISTS contacts_mql_idx ON contacts (is_mql, mql_at DESC) WHERE is_mql = TRUE;

COMMENT ON COLUMN contacts.mql_at IS 'Timestamp when contact became MQL (inbound + hot/warm)';
COMMENT ON COLUMN contacts.is_mql IS 'True if contact is MQL (inbound signal + qualified tier)';
