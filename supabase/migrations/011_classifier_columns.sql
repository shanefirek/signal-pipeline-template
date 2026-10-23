-- Migration 011: Sub-market classifier columns
--
-- Adds audit + observability columns for the new company data waterfall and
-- Claude-based sub-market classifier (src/lib/sub-market-classifier.ts +
-- src/enrichment/company-data-waterfall.ts).
--
-- Every classification now carries:
--   - source        — which tier set it (tld, industry_keyword, octave_segment, claude, default)
--   - confidence    — high / medium / low
--   - reason        — one-sentence justification (audit trail)
--   - version       — bump when prompt or enum changes
--   - last_run_at   — timestamp for re-classification scheduling
-- Plus:
--   - data_source        — which enrichment tier returned company data (leadmagic, apify, website_fetch, none)
--   - tam_list_mismatch  — TRUE when tam_list disagrees with classified sub_market

ALTER TABLE companies ADD COLUMN IF NOT EXISTS classifier_source text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS classifier_confidence text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS classifier_reason text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS classifier_version text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_classified_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS data_source text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tam_list_mismatch boolean DEFAULT false;

-- Indexes for the most common query patterns:
--   - Find records with low-confidence classifications for spot-checking
--   - Find records that need reclassification after a version bump
--   - Find tam_list mismatches for review

CREATE INDEX IF NOT EXISTS idx_companies_classifier_confidence
  ON companies(classifier_confidence)
  WHERE classifier_confidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_classifier_version
  ON companies(classifier_version)
  WHERE classifier_version IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_tam_list_mismatch
  ON companies(tam_list_mismatch)
  WHERE tam_list_mismatch = true;

CREATE INDEX IF NOT EXISTS idx_companies_data_source
  ON companies(data_source)
  WHERE data_source IS NOT NULL;
