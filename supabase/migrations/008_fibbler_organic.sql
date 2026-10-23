-- Fibbler organic + engagement level columns on signals table
-- Fibbler tracks both ad AND organic LinkedIn engagement

ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_organic_engagements integer DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_organic_impressions integer DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS fibbler_engagement_level text;  -- VERY_HIGH, HIGH, MEDIUM, LOW, VERY_LOW
