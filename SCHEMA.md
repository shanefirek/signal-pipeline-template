# Signal Pipeline Schema Reference

Source: `supabase/migrations/001–018` + direct ALTER statements (noted inline)

---

## Enums

| Type | Values |
|------|--------|
| `lead_tier` | hot, warm, cool, cold, departed |
| `signal_source` | syft_website, syft_linkedin, rep_a_list, rep_d_list, hubspot_backfill, hubspot_deal_created, company_discovery, fibbler_engagement, posthog_identify, csv_upload, starbridge_signal, manual_import |
| `processing_status` | pending, enriching, scoring, pushing, done, error, **filtered** |

> `filtered` added post-004 (no migration). Used by `normalize.ts` for validation rejections that are not errors.

---

## Tables

### raw_signals
Replaces Clay Normalization + Website Visitors + LinkedIn Activity webhook tables.

Written by: `syft-webhook.ts`, `syft-poll.ts`
Read by: `normalize.ts`, `score-intent.ts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| source | signal_source | NOT NULL | |
| raw_payload | jsonb | NOT NULL | Full Syft webhook JSON |
| domain | text | | Cleaned (lowercase, no protocol/www) |
| domain_raw | text | | Original before cleaning |
| email | text | | Handles literal "null" from Syft |
| first_name | text | | |
| last_name | text | | |
| contact_name | text | | Computed: first + last |
| company_name | text | | |
| title | text | | |
| linkedin_url | text | | Person LinkedIn URL |
| company_linkedin_url | text | | |
| employees | text | | String from Syft, not int |
| industry | text | | |
| city | text | | NOTE: Syft sometimes swaps city/state |
| state | text | | |
| country | text | | |
| page_views | integer | 0 | Account-level aggregate (NOT session) |
| sessions | integer | 0 | Account-level aggregate |
| active_time_seconds | integer | 0 | Session-level current visit |
| visitor_count | integer | 0 | `account.visitors` in Syft |
| linkedin_action | text | | comment, like, reaction, profile_view, form, message, dm |
| syft_purchase_intent | text | | Very High, High, Medium, Low |
| syft_intent_level | text | | Same as purchase_intent (Syft has no separate field) |
| icp_match | text | | Syft ICP match (from `account.icps` array, joined) |
| last_seen | text | | |
| utm_channel | text | | LinkedIn, Paid, Google, Direct, Organic, Referral |
| utm_sources | text | | |
| utm_medium | text | | |
| first_touch_source | text | | |
| touch_channels | text | | |
| touch_campaigns | text | | |
| referrers | text | | |
| latest_source | text | | |
| matched_intents | text | | From `account.syft_intents_array`, joined |
| high_intent_sessions | integer | 0 | |
| session_pages_visited | text | | Comma-separated URLs |
| pages_viewed | text | | |
| lead_personas | text | | From `lead.personas` array, joined |
| lead_source | text | | syft_website or syft_linkedin |
| validation | text | | 'pass' or 'fail' + reason |
| validation_gate | boolean | false | pass + (pageViews > 0 OR has linkedin_action) |
| is_not_customer | boolean | | HubSpot lifecycle + blocklist check |
| is_not_blocked | boolean | | Domain blocklist check |
| company_exists | boolean | false | |
| contact_exists_clay | boolean | false | |
| contact_exists_hubspot | boolean | false | |
| status | processing_status | pending | Now includes `filtered` value |
| company_id | uuid FK→companies | | Set after company upsert |
| contact_id | uuid FK→contacts | | Set after contact upsert |
| error | text | | |
| created_at | timestamptz | now() | |
| processed_at | timestamptz | | |

**Indexes:** domain+status+created_at (partial: pending/enriching), status (partial: not done), domain, source, **syft_dedup_idx** (UNIQUE on domain+source+last_seen, partial: syft_website/syft_linkedin where last_seen IS NOT NULL)

---

### companies
Replaces Clay Company Profiles table. One row per domain.

Written by: `enrich-company.ts`, `tam-enrich.ts`, `tam-activate.ts`, `company-data-waterfall.ts`
Read by: `normalize.ts` (dedup), `gates.ts`, `hubspot.ts`, `score-intent.ts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| domain | text UNIQUE | NOT NULL | |
| name | text | | |
| industry | text | | |
| employee_count | integer | | |
| annual_revenue | text | | For Company Stage Score (NOT funding) |
| locality | text | | Raw, city/state parsed from this |
| city | text | | |
| state | text | | |
| country | text | | |
| description | text | | |
| linkedin_url | text | | |
| sub_market | text | | 19 categories: "K12 EdTech SaaS", "Higher Ed", etc. |
| sub_market_reason | text | | AI one-sentence reason |
| sales_team_data | jsonb | | Raw people search results |
| sales_hiring_data | jsonb | | Raw jobs results |
| outbound_need_score | integer | 0 | 0-50, AI-scored |
| sales_org_summary | text | | 1-2 sentence summary |
| lead_summary | text | | 3-sentence pain-point briefing |
| vertical_fit_score | integer | 0 | 0-35, from sub_market |
| headcount_score | integer | 0 | 0-15, from employee_count |
| company_stage_score | integer | 0 | 0-30, from annual_revenue |
| sales_team_score | integer | 0 | 0-50, from outbound_need_score |
| icp_score | integer | 0 | Sum of 4 components (0-125) |
| lead_temp | text | | Hot (>=100), Warm (>=60), Cold |
| lead_source | text | | syft_website, syft_linkedin, tam_import, etc. |
| lead_origin | text | | "Clay" until coordinated cutover |
| first_touch_source | text | | |
| touch_channels | text | | |
| touch_campaigns | text | | |
| utm_sources | text | | |
| utm_medium | text | | |
| latest_source | text | | |
| matched_intents | text | | |
| pages_viewed | text | | |
| lead_personas | text | | |
| syft_intent_level | text | | Very High, High, Medium, Low |
| hubspot_company_id | text | | |
| hubspot_pushed_at | timestamptz | | |
| hubspot_updated_at | timestamptz | | |
| enriched_at | timestamptz | | |
| enrichment_sources | text[] | | Which providers returned data |
| created_at | timestamptz | now() | |
| updated_at | timestamptz | now() | Auto-updated via trigger |
| ~~octave_score~~ | integer | | **(deprecated — Octave removed Apr 15, not populated)** 1-10 from QUALIFY_COMPANY (002) |
| ~~octave_rationale~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| ~~octave_raw~~ | jsonb | | **(deprecated — Octave removed Apr 15, not populated)** Full QUALIFY response (002) |
| ~~octave_request_id~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** Async request tracking (002) |
| ~~octave_qualified_at~~ | timestamptz | | **(deprecated — Octave removed Apr 15, not populated)** When Octave ran (002) |
| ~~octave_segment~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| ~~octave_product~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| ~~octave_playbook~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| ~~octave_disqualifiers~~ | text[] | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| funding_stage | text | | Seed, Series A, B, etc. (002) |
| funding_total | numeric | | Latest round amount in dollars (002) |
| funding_date | date | | Latest round date (002) |
| investors | text[] | | Investor names (002) |
| funding_round_count | integer | | Total rounds (002) |
| funding_score | integer | 0 | 0-30 from funding_stage (002) |
| ~~octave_icp_score~~ | integer | | **(deprecated — Octave removed Apr 15, not populated)** (002) |
| ~~starbridge_buyer_id~~ | text | | **(deprecated — Octave removed Apr 15, not populated)** Phase 5 (002) |
| ~~starbridge_contract_count~~ | integer | | **(deprecated — Octave removed Apr 15, not populated)** Phase 5 (002) |
| ~~starbridge_last_contract_date~~ | date | | **(deprecated — Octave removed Apr 15, not populated)** Phase 5 (002) |
| hubspot_deal_id | text | | Deal tracking for deal-sync task (004) |
| deal_created_at | timestamptz | | When associated deal was created (004) |
| **last_scored_at** | timestamptz | | When company was last scored for stale-refresh (005) |
| **intent_score** | integer | 0 | Intent score from signals (005) |
| **total_score** | integer | 0 | icp + intent (005) |
| **lead_tier** | text | | Hot>=100, Warm>=60, Cool>=30, Cold<30 (005) |
| **last_requalified_at** | timestamptz | | Re-qualification cycle tracking (007) |
| **requalification_count** | integer NOT NULL | 0 | How many re-qualification cycles (007) |
| **tam_list** | text | | TAM list name, e.g. "rep_b_higher_ed" (009) |
| **tam_tier** | text | | tier_1, tier_2, tier_3 (009) |
| **tam_added_at** | timestamptz | | When added to TAM list (009) |
| **ae_owner** | text | | Territory owner: "rep_b", "rep_a" (009) |
| **tech_stack_data** | jsonb | | Technographics from LeadMagic (applied directly, no migration) |
| **tech_stack_score** | integer | | Score from tech stack analysis (applied directly, no migration) |
| **tam_icp_raw** | integer | | Raw TAM ICP score before normalization (applied directly, no migration) |
| **tam_enriched_at** | timestamptz | | When TAM enrichment last ran (applied directly, no migration) |
| **tam_dq_reason** | text | | Why company was disqualified from TAM (applied directly, no migration) |
| **leadmagic_data** | jsonb | | Raw LeadMagic company search response (applied directly, no migration) |
| **classifier_source** | text | | Which tier set sub_market: tld, industry_keyword, octave_segment, claude, default (011) |
| **classifier_confidence** | text | | high / medium / low (011) |
| **classifier_reason** | text | | One-sentence justification (011) |
| **classifier_version** | text | | Bump when prompt or enum changes (011) |
| **last_classified_at** | timestamptz | | Timestamp for re-classification scheduling (011) |
| **data_source** | text | | Which enrichment tier returned company data: leadmagic, apify, website_fetch, none (011) |
| **tam_list_mismatch** | boolean | false | TRUE when tam_list disagrees with classified sub_market (011) |
| **pitch_angle** | text | | AE-facing pitch angle for outbound (applied directly, no migration) |

**Indexes:** domain (unique + btree), hubspot_company_id (partial: not null), icp_score DESC, sub_market (partial: not null), octave_score DESC (partial), funding_stage (partial), octave_qualified_at DESC (partial), stale_scored (last_scored_at WHERE intent_score IS NOT NULL), refresh_eligible (octave_qualified_at WHERE icp>=60 AND hs_id IS NOT NULL), tam (tam_list+tam_tier WHERE tam_list IS NOT NULL), ae_owner (partial: not null), classifier_confidence (partial), classifier_version (partial), tam_list_mismatch (partial: true), data_source (partial: not null)

---

### contacts
Replaces Clay Contact Profiles table. One row per person.

Written by: `enrich-contact.ts`, `discover-contact.ts`, `enrich-deal-contact.ts`, `tam-activate.ts`
Read by: `normalize.ts` (dedup), `gates.ts`, `hubspot.ts`, `score-intent.ts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| company_id | uuid FK→companies | | |
| domain | text | | |
| email | text UNIQUE | | |
| email_verified | boolean | false | |
| email_source | text | | Which waterfall step found it |
| first_name | text | | |
| last_name | text | | |
| full_name | text GENERATED | | first + ' ' + last (STORED) |
| title | text | | |
| linkedin_url | text UNIQUE | | |
| phone | text | | |
| phone_source | text | | leadmagic_mobile |
| verified_company_domain | text | | MixRank verification |
| company_match | text | | match, mismatch, unverified |
| signal_type | text | | 'Company Intent', 'LinkedIn Engagement', etc. |
| icp_score | integer | 0 | From company lookup |
| intent_score | integer | 0 | Max from signal scoring |
| combined_score | integer GENERATED | | icp + intent (STORED) |
| tier | lead_tier | | |
| lead_summary | text | | 2-3 sentence briefing |
| lead_origin | text | 'Clay' | Hardcoded until cutover |
| lead_source | text | | syft_website, company_discovery, tam_import, etc. |
| first_touch_channel | text | | |
| utm_source | text | | |
| utm_medium | text | | |
| utm_campaign | text | | |
| last_signal_date | timestamptz | | |
| needs_refresh | boolean | false | |
| refresh_trigger | timestamptz | | |
| hubspot_contact_id | text | | |
| hubspot_pushed_at | timestamptz | | |
| hubspot_updated_at | timestamptz | | |
| hubspot_company_precheck | boolean | | Saves waterfall credits |
| enriched_at | timestamptz | | |
| enrichment_sources | text[] | | |
| created_at | timestamptz | now() | |
| updated_at | timestamptz | now() | Auto-updated via trigger |
| **last_refreshed_at** | timestamptz | | When stale-refresh last processed this contact (004) |
| **fibbler_influenced** | boolean | false | Company has Fibbler LinkedIn ad engagement (006) |
| **email_bounce_detected_at** | timestamptz | | When email bounced (007) |
| **job_change_detected_at** | timestamptz | | When job change was detected (007) |
| **previous_title** | text | | Title before job change (007) |
| **previous_contact_name** | text | | Name before change (007) |
| **tam_list** | text | | Inherited from company on discovery (009) |
| **tam_tier** | text | | Inherited from company on discovery (009) |
| **ae_owner** | text | | Work ownership: "rep_b", "rep_a" (015) |
| **lead_type** | text | | inbound / outbound / referral / unknown (016) |
| **has_intent_signal** | boolean | false | TRUE when outbound contact has inbound signal at same domain (016) |
| **mql_at** | timestamptz | | Timestamp when contact became MQL (017) |
| **is_mql** | boolean | false | TRUE if contact is MQL: inbound signal + qualified tier (017) |

**Constraints:** CHECK (email IS NOT NULL OR linkedin_url IS NOT NULL)
**Indexes:** email (unique + btree), domain, linkedin_url (unique + btree), hubspot_contact_id (partial: not null), tier, combined_score DESC, needs_refresh (partial: true), company_id (partial: not null), refresh_eligible (enriched_at WHERE tier IN hot/warm AND hs_id IS NOT NULL), stale (last_signal_date DESC WHERE needs_refresh=true), tam (tam_list WHERE tam_list IS NOT NULL), ae_owner (partial: not null), lead_type, has_intent_signal (partial: true), mql_idx (is_mql+mql_at DESC WHERE is_mql=true)

---

### signals
Replaces Clay Signal Scoring table. Every scored signal event.

Written by: `score-intent.ts`
Read by: `enrich-contact.ts` (intent lookup), `update-hubspot.ts` (signal attribution filter)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| raw_signal_id | uuid FK→raw_signals | | |
| company_id | uuid FK→companies | | |
| contact_id | uuid FK→contacts | | Nullable (signal before contact) |
| source | signal_source | NOT NULL | |
| domain | text | NOT NULL | |
| company_name | text | | |
| contact_name | text | | |
| title | text | | |
| email | text | | |
| linkedin_url | text | | |
| country | text | | |
| page_views | integer | 0 | |
| sessions | integer | 0 | |
| active_time_seconds | integer | 0 | |
| visitor_count | integer | 0 | |
| linkedin_action | text | | |
| utm_channel | text | | |
| syft_purchase_intent | text | | |
| syft_intent_level | text | | |
| high_intent_sessions | integer | 0 | |
| session_pages_visited | text | | |
| pages_viewed | text | | |
| purchase_intent_score | integer | 0 | 0-20 |
| engagement_depth_score | integer | 0 | 0-25 |
| direct_action_score | integer | 0 | 0-35 |
| referral_source_score | integer | 0 | 0-10 |
| page_intent_score | integer | 0 | 0-30 |
| intent_score | integer | 0 | Sum of 5 components + fibbler bonus (0-145) |
| icp_score | integer | 0 | Looked up from companies |
| total_score | integer | 0 | icp + intent |
| lead_tier | lead_tier | | Hot>=100, Warm>=60, Cool>=30, Cold<30 |
| created_at | timestamptz | now() | |
| **fibbler_clicks** | integer | 0 | Fibbler ad click count (005) |
| **fibbler_leads** | integer | 0 | Fibbler ad lead count (005) |
| **fibbler_impressions** | integer | 0 | Fibbler ad impression count (005) |
| **fibbler_score** | integer | 0 | Fibbler engagement bonus (0-25) (006) |
| **fibbler_organic_engagements** | integer | 0 | Organic LinkedIn engagement count (008) |
| **fibbler_organic_impressions** | integer | 0 | Organic LinkedIn impression count (008) |
| **fibbler_engagement_level** | text | | VERY_HIGH, HIGH, MEDIUM, LOW, VERY_LOW (008) |

**Indexes:** domain, company_id, contact_id (partial: not null), lead_tier

---

### octave_results
Audit trail for every Octave agent call. Created in 002. **(deprecated — Octave removed Apr 15. Table retained for historical data.)**

Written by: ~~`waterfall.ts`~~ (removed), ~~`octave-callback.ts`~~ (removed)
Read by: nothing (historical only)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| company_id | uuid FK→companies | | |
| agent_id | text | NOT NULL | Which Octave agent |
| agent_type | text | NOT NULL | qualify, prospector, email, call_prep |
| request_id | text | NOT NULL | Octave async request ID |
| domain | text | | |
| input_payload | jsonb | | What we sent |
| output_payload | jsonb | | What came back |
| score | integer | | Octave score if applicable |
| credits_used | integer | | Estimated credits consumed |
| duration_ms | integer | | How long the agent took |
| status | text | 'pending' | pending, completed, failed |
| error | text | | |
| created_at | timestamptz | now() | |
| completed_at | timestamptz | | |

**Indexes:** company_id, request_id (UNIQUE), status (partial: not completed)

---

### push_log
Audit trail for HubSpot/Slack pushes.

Written by: `hubspot.ts`, `slack.ts`, `gates.ts` (gate_rejected action)
Read by: `pipe-health.ts` (Check 8: orphan detection)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| entity_type | text | NOT NULL | company, contact, alert |
| entity_id | uuid | | Supabase row UUID (not HubSpot numeric ID) |
| destination | text | NOT NULL | hubspot, slack |
| action | text | NOT NULL | create, update, alert, **gate_rejected** |
| payload | jsonb | | |
| response | jsonb | | |
| success | boolean | false | |
| error | text | | |
| created_at | timestamptz | now() | |

**Indexes:** entity_type+entity_id, created_at DESC

---

### domain_blocklist
Blocked domains: customers, partners, internal, closed_lost. 56 domains.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| domain | text UNIQUE | NOT NULL | |
| reason | text | | customer, partner, internal, closed_lost |
| created_at | timestamptz | now() | |

---

### outbound_sequences
Generated email sequences for Phase 3. Created in 002. **Not populated yet.**

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| contact_id | uuid FK→contacts | | |
| company_id | uuid FK→companies | | |
| agent_id | text | | Which EMAIL agent |
| sequence_type | text | | cold_k12, cold_pe, etc. |
| steps | jsonb | | Array of { step_number, subject, body, send_delay_days } |
| status | text | 'draft' | draft, approved, sent_to_lemlist, active, completed |
| lemlist_campaign_id | text | | |
| created_at | timestamptz | now() | |

---

### scheduled_runs
Audit trail for cron/scheduled task executions. Created in 002.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| task_name | text | NOT NULL | deal-sync, contact-backfill, stale-refresh, etc. |
| trigger_type | text | NOT NULL | scheduled, webhook, manual |
| started_at | timestamptz | now() | |
| completed_at | timestamptz | | |
| records_processed | integer | 0 | |
| records_created | integer | 0 | |
| records_updated | integer | 0 | |
| records_errored | integer | 0 | |
| error | text | | |
| metadata | jsonb | | |

**Indexes:** task_name+started_at DESC

---

### enrichment_log
Immutable audit trail for every Cargo/LeadMagic API call. Created in 018.

Written by: `enrichment-logger.ts` (called from `enrich-contact.ts`, `discover-contact.ts`, `tam-enrich.ts`, `enrich-deal-contact.ts`, `email-waterfall.ts`)
Read by: rarely — audit queries, `enrichment-logger.ts` (dedup check)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| provider | text | NOT NULL | 'cargo' or 'leadmagic' |
| operation | text | NOT NULL | verify_employment, verify_employment_url, find_email, verify_email, find_phone, find_stakeholders, employee_finder, find_work_email, validate_email, find_mobile_phone, company_search, jobs_finder, technographics |
| contact_id | uuid FK→contacts | | Nullable — backfill won't always match |
| company_id | uuid FK→companies | | Nullable |
| lookup_key | text | NOT NULL | email, linkedin slug, "first\|last\|domain", or domain |
| input_payload | jsonb | '{}' | What we sent |
| output_payload | jsonb | | Full response (null if error) |
| cargo_run_id | text | | Cargo orchestration run UUID |
| cargo_workflow_id | text | | Which Cargo workflow was used |
| credits_estimated | numeric(6,2) | 0 | |
| trigger_source | text | | enrich-contact, discover-contact, tam-enrich, enrich-deal-contact, email-waterfall, script:<name> |
| duration_ms | integer | | |
| success | boolean | false | |
| error | text | | |
| created_at | timestamptz | now() | |
| backfilled | boolean | false | TRUE for rows inserted by `scripts/cargo-pull-historical.mts` |

**Indexes:** dedup (provider+operation+lookup_key+created_at DESC), credits (provider+created_at DESC), contact_id (partial: not null), company_id (partial: not null), cargo_run_id (UNIQUE, partial: not null)

---

### enrichment_credits
Daily rollup of enrichment credit consumption. Upserted on each enrichment call. Created in 018.

Written by: `enrichment-logger.ts`
Read by: audit queries (cost monitoring)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| date | date | NOT NULL | |
| provider | text | NOT NULL | |
| operation | text | NOT NULL | |
| trigger_source | text | | |
| call_count | integer | 0 | |
| credits_total | numeric(8,2) | 0 | |
| success_count | integer | 0 | |
| error_count | integer | 0 | |
| duplicate_count | integer | 0 | |
| created_at | timestamptz | now() | |

**Constraints:** UNIQUE (date, provider, operation, trigger_source)
**Indexes:** date DESC

---

### enrichment_dedup_cache
Fast dedup lookup — skip re-enrichment if same provider+operation+lookup_key was enriched recently. Created in 018. Phase 3 dedup guards.

Written by: `enrichment-logger.ts`
Read by: `enrichment-logger.ts` (dedup check before calling provider)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| provider | text | NOT NULL | |
| operation | text | NOT NULL | |
| lookup_key | text | NOT NULL | |
| last_enriched_at | timestamptz | NOT NULL | |
| last_result_summary | jsonb | | Compact result: { verified: true, email: "..." } |
| enrichment_log_id | uuid FK→enrichment_log | | |
| created_at | timestamptz | now() | |
| updated_at | timestamptz | now() | |

**Constraints:** UNIQUE (provider, operation, lookup_key)

---

### tam_list_staging
Staging table for TAM list review before push. Used by RepB Higher Ed TAM workflow.

Written by: `scripts/populate-tam-staging.mts`, `scripts/coalesce-rep_b-final.mts`
Read by: `scripts/export-rep_b-list.mts`, `scripts/export-rep_b-excel.mts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid PK | gen_random_uuid() | |
| list_name | text | NOT NULL | e.g. "rep_b_higher_ed" |
| domain | text | NOT NULL | |
| company_name | text | | |
| sub_market | text | | |
| employee_count | integer | | |
| icp_score | integer | | |
| outbound_need_score | integer | | |
| sales_org_summary | text | | |
| tam_tier | text | | |
| contact_name | text | | |
| contact_title | text | | |
| contact_email | text | | |
| contact_phone | text | | |
| contact_linkedin | text | | |
| contact_tier | text | | |
| rep_b_notes | text | | AE-added notes |
| rep_b_status | text | | AE review status |
| score_changed | boolean | false | Flag for score drift detection |
| old_icp_score | integer | | Previous ICP score for comparison |
| old_outbound_need | integer | | Previous outbound need score |
| change_reason | text | | Why score changed |
| excluded | boolean | false | |
| exclude_reason | text | | Why excluded |
| created_at | timestamptz | now() | |

---

### tam_cleanup_backup_2026_04_06
Backup of TAM companies before cleanup. One-time table, no migration. **(Historical snapshot — not written to by production code.)**

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | uuid | | Original company UUID |
| domain | text | | |
| name | text | | |
| tam_list | text | | |
| tam_tier | text | | |
| ae_owner | text | | |
| sub_market | text | | |
| tam_dq_reason | text | | |
| classifier_source | text | | |
| classifier_confidence | text | | |
| classifier_reason | text | | |
| backed_up_at | timestamptz | | When backup was taken |
| cleanup_bucket | text | | Which cleanup action group |

---

## Audit Tables (012–014)

All audit tables are populated weekly by `hubspot-parity-audit.ts` (via `audit-parity.ts`). Reviewed by Shane via SQL in Supabase Studio. Manual cleanup actions executed by `scripts/run-cleanup-approved.mts`.

**NO automated execution. NO Slack. All output is DB + logs only.**

### audit_parity_runs
Append-only weekly summary. Replaces Slack digest. Created in 012.

Written by: `hubspot-parity-audit.ts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| snapshot_id | timestamptz PK | | Run identifier |
| finished_at | timestamptz | | |
| contacts_total | integer | | |
| companies_total | integer | | |
| contacts_added | integer | | Delta from previous snapshot |
| contacts_removed | integer | | |
| contacts_modified | integer | | |
| companies_added | integer | | |
| companies_removed | integer | | |
| companies_modified | integer | | |
| dedup_groups_total | integer | | |
| archive_candidates_pending | integer | | |
| enrichment_gaps_pending | integer | | |
| run_duration_seconds | integer | | |
| notes | text | | |

---

### audit_hs_contacts_snapshot
Append-only HubSpot contact snapshots. Keep last 4 snapshots (pruned by `audit_prune_snapshots()`). Created in 012, extended in 014.

Written by: `hubspot-parity-audit.ts`
Read by: stored procs `audit_run_contact_dedup()`, `audit_run_archive_contacts()`, `audit_run_enrich_contacts()`, `audit_run_quality_contacts()`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| snapshot_id | timestamptz | NOT NULL | PK with hubspot_id |
| hubspot_id | text | NOT NULL | PK with snapshot_id |
| email | text | | |
| firstname | text | | |
| lastname | text | | |
| jobtitle | text | | |
| associated_company_id | text | | |
| hubspot_owner_id | text | | |
| owner_name | text | | |
| lifecyclestage | text | | |
| lead_tier | text | | |
| lead_origin | text | | |
| signal_type | text | | |
| icp_score | numeric | | |
| lead_summary | text | | |
| syft_last_seen | timestamptz | | |
| hs_createdate | timestamptz | | |
| hs_lastmodified | timestamptz | | |
| raw_properties | jsonb | | |
| **last_scored_date** | timestamptz | | When enrichment scored (014) |
| **hs_linkedin_url** | text | | (014) |
| **company_string** | text | | Fallback company name (014) |
| **city** | text | | (014) |
| **state** | text | | (014) |
| **utm_source** | text | | (014) |
| **utm_medium** | text | | (014) |
| **utm_campaign** | text | | (014) |
| **first_touch_channel** | text | | (014) |

**Indexes:** snapshot_id, hubspot_id, lower(email) (partial: not null), hubspot_owner_id (partial: not null), last_scored_date (partial: not null)

---

### audit_hs_companies_snapshot
Append-only HubSpot company snapshots. Keep last 4 snapshots. Created in 012, extended in 014.

Written by: `hubspot-parity-audit.ts`
Read by: stored procs `audit_run_company_dedup()`, `audit_run_archive_companies()`, `audit_run_enrich_companies()`, `audit_run_quality_companies()`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| snapshot_id | timestamptz | NOT NULL | PK with hubspot_id |
| hubspot_id | text | NOT NULL | PK with snapshot_id |
| name | text | | |
| domain | text | | |
| hubspot_owner_id | text | | |
| owner_name | text | | |
| lifecyclestage | text | | |
| lead_tier | text | | |
| lead_temp | text | | |
| lead_origin | text | | |
| icp_score | numeric | | |
| lead_summary | text | | |
| sales_org_summary | text | | |
| sub_market | text | | |
| syft_last_seen | timestamptz | | |
| hs_createdate | timestamptz | | |
| hs_lastmodified | timestamptz | | |
| raw_properties | jsonb | | |
| **last_scored_date** | timestamptz | | When enrichment scored (014) |
| **first_touch_source** | text | | (014) |
| **touch_channels** | text | | (014) |
| **touch_campaigns** | text | | (014) |
| **utm_medium** | text | | (014) |
| **latest_source** | text | | (014) |

**Indexes:** snapshot_id, hubspot_id, lower(domain) (partial: not null), hubspot_owner_id (partial: not null), last_scored_date (partial: not null)

---

### audit_dedup_groups
Duplicate detection groups. TRUNCATE + re-populate weekly. Created in 012.

Written by: stored procs `audit_run_contact_dedup()`, `audit_run_company_dedup()`
Read by: Shane via Supabase Studio

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | bigserial PK | | |
| detected_at | timestamptz | now() | |
| object_type | text | NOT NULL | CHECK: 'contact' or 'company' |
| dedup_method | text | NOT NULL | email_exact, linkedin_exact, name_company, domain_exact, name_normalized |
| dedup_key | text | NOT NULL | Normalized match key |
| member_ids | text[] | NOT NULL | HubSpot IDs in the group |
| member_count | integer GENERATED | | cardinality(member_ids) (STORED) |
| keeper_id | text | NOT NULL | Recommended survivor |
| keeper_reason | text | | v2_linked, has_owner, has_enrichment, oldest |
| review_decision | text | 'pending' | CHECK: pending, approved, rejected, manual_override |
| reviewed_at | timestamptz | | |
| notes | text | | |

**Indexes:** review_decision, object_type

---

### audit_archive_candidates
Stale/orphan HubSpot records for cleanup review. Upsert — preserves decision across runs. Created in 012, threshold tuned in 013 (180d→90d).

Written by: stored procs `audit_run_archive_contacts()`, `audit_run_archive_companies()`
Read by: Shane via Supabase Studio, `scripts/run-cleanup-approved.mts`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| hubspot_id | text | NOT NULL | PK with object_type |
| object_type | text | NOT NULL | PK with hubspot_id. CHECK: 'contact' or 'company' |
| flags | text[] | NOT NULL | no_enrichment, no_owner, rep_c_default, lifecycle_never_progressed, old_90d, no_syft_activity, no_domain, no_name |
| v2_linked | boolean | false | Has matching Supabase record |
| has_open_deal | boolean | false | |
| has_syft_activity | boolean | false | Recent Syft signal (90d) |
| days_since_created | integer | | |
| days_since_modified | integer | | |
| decision | text | 'pending' | CHECK: pending, approved, rejected, deferred, executed |
| decided_at | timestamptz | | |
| reason | text | | |
| last_detected_at | timestamptz | now() | |

**Indexes:** decision, last_detected_at DESC

---

### audit_enrichment_gaps
Missing enrichment data for remediation. Upsert — preserves resolved state. Created in 012, extended in 014 (quality gaps).

Written by: stored procs `audit_run_enrich_contacts()`, `audit_run_enrich_companies()`, `audit_run_quality_contacts()`, `audit_run_quality_companies()`
Read by: Shane via Supabase Studio

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| hubspot_id | text | NOT NULL | PK with object_type + gap_type |
| object_type | text | NOT NULL | CHECK: 'contact' or 'company' |
| gap_type | text | NOT NULL | v2_has_supabase_missing_hubspot, mql_no_tier, hot_warm_no_icp, orphaned_contact, bad_name_format, stale_enrichment, attribution_incomplete |
| priority | smallint | NOT NULL | CHECK: 1-5. Lower = higher priority |
| source | text | | needs_scoring, needs_enrichment, supabase_push_needed, etc. |
| resolved | boolean | false | |
| resolved_at | timestamptz | | |
| last_detected_at | timestamptz | now() | |
| notes | text | | |

**Indexes:** priority (partial: resolved=false)

---

### audit_cleanup_actions_log
Every cleanup action executed by `scripts/run-cleanup-approved.mts`. Append-only. Created in 012.

Written by: `scripts/run-cleanup-approved.mts`
Read by: audit queries

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | bigserial PK | | |
| action_type | text | NOT NULL | merge, archive, update, delete, etc. |
| object_type | text | NOT NULL | contact, company |
| hubspot_id | text | NOT NULL | |
| before_state | jsonb | | |
| after_state | jsonb | | |
| script_name | text | | |
| executed_at | timestamptz | now() | |
| success | boolean | NOT NULL | |
| error_message | text | | |

**Indexes:** executed_at DESC, hubspot_id+object_type, action_type+success

---

## Stored Procedures (012–014)

All called via `supabase.rpc()` from `hubspot-parity-audit.ts`.

| Function | Returns | Created | Notes |
|----------|---------|---------|-------|
| `audit_run_contact_dedup(p_snapshot_id)` | int | 012 | Detects email_exact, linkedin_exact, name_company dupes |
| `audit_run_company_dedup(p_snapshot_id)` | int | 012 | Detects domain_exact, name_normalized dupes |
| `audit_run_archive_contacts(p_snapshot_id)` | int | 012, tuned 013 | 90-day threshold for stale contacts |
| `audit_run_archive_companies(p_snapshot_id)` | int | 012, tuned 013 | 90-day threshold for stale companies |
| `audit_run_enrich_contacts(p_snapshot_id)` | int | 012 | Detects v2_has_supabase_missing_hubspot, mql_no_tier, hot_warm_no_icp |
| `audit_run_enrich_companies(p_snapshot_id)` | int | 012 | Detects v2_has_supabase_missing_hubspot, hot_warm_no_icp |
| `audit_run_quality_contacts(p_snapshot_id)` | int | 014 | Detects orphaned_contact, bad_name_format, stale_enrichment, attribution_incomplete |
| `audit_run_quality_companies(p_snapshot_id)` | int | 014 | Detects bad_name_format, stale_enrichment, attribution_incomplete |
| `audit_compute_drift(p_snapshot_id)` | TABLE | 012 | Returns added/removed/modified counts for contacts+companies |
| `audit_prune_snapshots(p_keep)` | int | 012 | Prunes old snapshots, keeps last N (default 4) |

---

## Migration Index

| Migration | What it adds |
|-----------|-------------|
| 001 | Initial schema: raw_signals, companies, contacts, signals, push_log, domain_blocklist |
| 002 | Octave integration + funding columns on companies, octave_results, outbound_sequences, scheduled_runs |
| 003 | Hardening: indexes, constraints, enum values |
| 004 | Phase 2: hubspot_deal_id, deal_created_at on companies; last_refreshed_at on contacts |
| 005 | Fibbler ad engagement on signals (clicks/leads/impressions); last_scored_at, intent_score, total_score, lead_tier on companies |
| 006 | Fibbler scoring: fibbler_score on signals; fibbler_influenced on contacts |
| 007 | Re-enrichment tracking: last_requalified_at, requalification_count on companies; email_bounce_detected_at, job_change_detected_at, previous_title, previous_contact_name on contacts |
| 008 | Fibbler organic: fibbler_organic_engagements, fibbler_organic_impressions, fibbler_engagement_level on signals |
| 009 | TAM support: tam_list, tam_tier, tam_added_at, ae_owner on companies; tam_list, tam_tier on contacts |
| 011 | Sub-market classifier: classifier_source/confidence/reason/version, last_classified_at, data_source, tam_list_mismatch on companies |
| 012 | Audit parity tables: all 7 audit_* tables + 10 stored procedures |
| 013 | Audit threshold tune: archive candidate age 180d→90d |
| 014 | Audit quality gaps: last_scored_date + attribution columns on snapshot tables; quality gap detection procs |
| 015 | Contact ae_owner column + backfill from company |
| 016 | lead_type + has_intent_signal on contacts + backfill |
| 017 | MQL tracking: mql_at, is_mql on contacts |
| 018 | Enrichment reconciliation: enrichment_log, enrichment_credits, enrichment_dedup_cache |

> **Note:** Migration 010 does not exist (numbering gap). Columns `tech_stack_data`, `tech_stack_score`, `tam_icp_raw`, `tam_enriched_at`, `tam_dq_reason`, `leadmagic_data`, `pitch_angle` on companies and `tam_cleanup_backup_2026_04_06` table were applied directly to the database without migration files.
