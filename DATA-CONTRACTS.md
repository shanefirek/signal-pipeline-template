# Data Contracts — Signal Pipeline

Single source of truth for every upstream source (what sends data IN), every downstream consumer (what reads data OUT), and how the schema connects them.

**Last verified:** Apr 22, 2026, against live code (`v20260422.3` prod deploy).

---

## Upstream Sources

### 1. Syft Website Visitors

**Trigger:** Syft auto-fires webhook when a company visits acmegtm.com
**Frequency:** Real-time, ~5-20/day
**Status:** LIVE — `src/triggers/syft-webhook.ts` + `src/triggers/syft-poll.ts` (30m cron).

**Payload structure:** `{ account, lead, session }`

```
account (company-level aggregates)
├── domain: string              → raw_signals.domain (cleaned)
├── name: string                → raw_signals.company_name
├── industry: string            → raw_signals.industry
├── employees: number           → raw_signals.employees (as string)
├── employeeCount: number       → (duplicate of employees)
├── linkedin: string            → raw_signals.company_linkedin_url
├── city: string                → raw_signals.city (WARN: sometimes swapped with state)
├── state: string               → raw_signals.state
├── country: string             → raw_signals.country
├── pageViews: number           → raw_signals.page_views
├── sessions: number            → raw_signals.sessions
├── timeSpent: number           → (account aggregate, prefer session.active_time)
├── visitors: number            → raw_signals.visitor_count
├── purchaseIntent: string      → raw_signals.syft_purchase_intent ("Very High"|"High"|"Medium"|"Low")
├── lastSeen: ISO8601           → raw_signals.last_seen
├── icps: string[]              → raw_signals.icp_match (joined)
├── foundedYear: string         → NOT EXTRACTED (stored in raw_payload)
├── estimatedAnnualRevenue: str → NOT EXTRACTED (stored in raw_payload)
├── syft_intents_array: str[]   → raw_signals.matched_intents (joined)
├── syft_persona_array: str[]   → (used at lead level)
├── syft_visited_pages: string  → raw_signals.pages_viewed
├── syft_high_intent_sessions   → raw_signals.high_intent_sessions
├── syft_latest_utm_channel     → raw_signals.utm_channel (fallback)
├── syft_original_utm_channel   → raw_signals.touch_channels (combined)
├── syft_latest_utm_source      → raw_signals.utm_sources (fallback)
├── syft_latest_utm_medium      → (fallback for utm_medium)
├── syft_utm_campaigns: string  → raw_signals.touch_campaigns
├── syft_latest_source          → raw_signals.latest_source
├── syft_original_referrer      → raw_signals.first_touch_source (fallback)
├── syft_latest_referrer        → raw_signals.referrers (combined)
├── syft_summary: string        → NOT EXTRACTED (free AI summary, in raw_payload)
├── syft_linkedin_*_total       → NOT EXTRACTED (LinkedIn ad metrics, in raw_payload)
└── lifecycleStage: string      → NOT EXTRACTED (HubSpot lifecycle from Syft)

lead (person-level)
├── firstName: string           → raw_signals.first_name
├── lastName: string            → raw_signals.last_name
├── email: string               → raw_signals.email (cleaned, handles "null" string)
├── title: string               → raw_signals.title
├── linkedin: string            → raw_signals.linkedin_url
├── company: string             → (redundant with account.name)
├── city/state/country          → raw_signals.city/state/country (overrides account)
├── personas: string[]          → raw_signals.lead_personas (joined)
├── enrichmentConfidence        → NOT EXTRACTED (in raw_payload)
├── hubspot_contact_id          → NOT EXTRACTED (stale, in raw_payload)
├── hubspot_company_id          → NOT EXTRACTED (stale, in raw_payload)
├── syft_summary                → NOT EXTRACTED (in raw_payload)
└── syft_research_report        → NOT EXTRACTED (in raw_payload)

session (current visit — ONLY present for website visitors, NOT LinkedIn)
├── active_time: number         → raw_signals.active_time_seconds
├── pages_visited: string[]     → raw_signals.session_pages_visited (joined)
├── referrer: string            → raw_signals.first_touch_source
├── utm_source: string          → raw_signals.utm_sources
├── utm_medium: string          → raw_signals.utm_medium
├── utm_campaign: string        → (in touch_campaigns via account aggregate)
├── utm_channel: string         → raw_signals.utm_channel
└── signals: string[]           → NOT EXTRACTED (e.g. "Viewed Pricing", in raw_payload)
```

**Known issues:**
- `email: "null"` is a literal string from Syft. `cleanEmail()` handles this.
- City/state swapped on some records. Downstream must not assume order.
- Session object is ABSENT for LinkedIn activity webhooks.
- `account.pageViews` can be 0 even for website visitors (company aggregate, not session).
- All data also in `raw_payload` jsonb — nothing is truly lost.

---

### 2. Syft LinkedIn Activity

**Trigger:** Syft auto-fires webhook on LinkedIn engagement (profile view, like, comment, etc.)
**Frequency:** Real-time, ~3-10/day
**Status:** LIVE — same `syft-webhook.ts`, source=`syft_linkedin`.

**Payload structure:** `{ account, lead, linkedin }` — NO session object.

```
linkedin (action-specific)
├── action: string              → raw_signals.linkedin_action
│     Values: "Profile View", "Like", "Comment", "Share"
├── intent: string              → (duplicate of account.purchaseIntent)
├── post_url: string            → NOT EXTRACTED (in raw_payload)
├── post_id: string             → NOT EXTRACTED (in raw_payload)
├── timestamp: ISO8601          → NOT EXTRACTED (in raw_payload)
└── syft_purchase_intent        → (duplicate)
```

**Key difference from website:** No session data, no UTM data from current action. Attribution falls back to account-level `syft_latest_utm_*` fields.

---

### 3. PostHog Events

**Trigger:** PostHog fires webhook on `$identify` events (user identified on website)
**Frequency:** Real-time (when tracking fires)
**Status:** NOT integrated into Signal Pipeline pipe. Currently a cron job (`posthog-signal-upgrade.py`) that patches HubSpot directly.

**Payload structure:**

```
{
  event: "$identify",
  distinct_id: string,           → extract domain from email
  timestamp: ISO8601,
  properties: {
    $set: {
      email: string,             → raw_signals.email
      name: string,              → raw_signals.contact_name (parse first/last)
      company: string,           → raw_signals.company_name
      title: string,             → raw_signals.title
    },
    $session_count: number,      → raw_signals.sessions
    $initial_utm_source: string, → raw_signals.utm_sources
    $initial_utm_medium: string, → raw_signals.utm_medium
    $initial_utm_campaign: str,  → raw_signals.touch_campaigns
    $initial_current_url: string → extract pages_viewed
  }
}
```

**What Signal Pipeline needs:** A `posthog-webhook.ts` trigger task that:
1. Receives `$identify` event
2. Extracts email → domain
3. Inserts into `raw_signals` with `source = 'posthog_identify'`
4. Triggers normalize → enrich pipeline (upgrades signal_type to "Identified Visitor")

**What's missing from raw_signals for PostHog:**
- Nothing — all fields map to existing columns. `source` enum now includes `posthog_identify`.

**What PostHog gives us that Syft doesn't:**
- Confirmed identity (email from form fill, not enrichment guess)
- First-party UTM data (not Syft's reverse-engineered attribution)
- Session-level behavioral data (pages, time, events)

---

### 4. HubSpot Deal Created

**Trigger:** `deal-sync.ts` cron polls HubSpot for new deals hourly
**Frequency:** Hourly cron (LIVE)
**Status:** LIVE — `src/triggers/deal-sync.ts` (hourly cron) triggers `enrich-deal-contact.ts` (isolated task, no gates).

**Payload structure (what we extract from HubSpot deal + associations):**

```
deal
├── dealname: string             → (for logging)
├── amount: string               → NOT USED (would need for pipeline reporting)
├── dealstage: string            → NOT USED
├── pipeline: string             → NOT USED
├── closedate: string            → NOT USED
├── hs_object_id: string         → NOT USED
└── associations:
    ├── company
    │   ├── domain: string       → raw_signals.domain
    │   ├── name: string         → raw_signals.company_name
    │   └── lifecyclestage       → (used for gate check, not stored)
    └── contact
        ├── email: string        → raw_signals.email
        ├── firstname: string    → raw_signals.first_name
        ├── lastname: string     → raw_signals.last_name
        └── jobtitle: string     → raw_signals.title
```

**Implementation:** `enrich-deal-contact.ts` is the reference pattern for isolated non-Syft workflows. Standalone task, calls enrichment primitives directly, no gates. Company enrichment runs inline (full LeadMagic chain + Claude classifier + ICP scoring). Contact gets Cargo verification + LeadMagic phone + Claude summary. Always pushes to HubSpot with `lead_tier = Hot`.

---

### 5. TAM Batch Import

**Trigger:** Manual batch via `tam-enrich.ts` — one task per domain
**Frequency:** Ad-hoc, driven by AE lists (RepB Higher Ed, RepA K12)
**Status:** LIVE — `src/triggers/tam-enrich.ts` (enrichment) + `src/triggers/tam-activate.ts` (HubSpot push).

**Payload:**
```
{ domain: string, tam_list: string, ae_owner: "rep_a" | "rep_b" }
```

**Enrichment chain:** LeadMagic company → LeadMagic employees (Cargo findStakeholders fallback) → LeadMagic jobs → Claude classifier → deterministic ICP scoring → Claude lead_summary. Stores in Supabase only — does NOT push to HubSpot or discover contacts. `tam-activate.ts` handles HubSpot push separately.

**Safety:** `tam_only` flag is force-coerced to `true` whenever `lead_source=tam_import` (line 50 of `enrich-company.ts`), preventing TAM traffic from triggering HubSpot push or contact discovery through the Syft pipeline.

---

### 6. CSV List Imports (RepA + RepD)

**Trigger:** Manual CSV upload
**Frequency:** Ad-hoc, ~1-2x/week during active outbound
**Status:** NOT automated. Currently manual Clay table import or direct list handoff.

**Payload structure (from actual CSVs in `data/`):**

```csv
First Name,Last Name,Full Name,Job Title,Company Domain,LinkedIn Profile
```

Maps to:
```
First Name                       → raw_signals.first_name
Last Name                        → raw_signals.last_name
Full Name                        → raw_signals.contact_name
Job Title                        → raw_signals.title
Company Domain                   → raw_signals.domain (cleaned)
LinkedIn Profile                 → raw_signals.linkedin_url
```

**What's missing:** Email (must be found via waterfall), phone, company size, industry — all get enriched downstream.

---

### 7. Starbridge (Phase 5 — not integrated yet)

**Trigger:** API polling (no webhook from Starbridge)
**Frequency:** Planned every 4h
**Status:** NOT built. API client exists at `~/projects/acme-starbridge/`.

**What Starbridge provides:**

```
Buyer Search Response
├── id: string                   → companies.starbridge_buyer_id
├── name: string                 → raw_signals.company_name
├── type: string                 → "SchoolDistrict", "Municipality", etc.
├── stateCode: string            → raw_signals.state
├── city: string                 → raw_signals.city
├── url: string                  → raw_signals.domain (cleaned)
├── tags: string[]               → NOT MAPPED (K-12, Local, State, etc.)
├── extraData:
│   ├── totalEnrollment: number  → NOT MAPPED
│   ├── budgetAmount: number     → NOT MAPPED
│   ├── budgetSbita: number      → NOT MAPPED (SBITA = technology budget)
│   ├── sis: string              → NOT MAPPED (PowerSchool, Infinite Campus, etc.)
│   └── lmsArray: string[]       → NOT MAPPED (Canvas, Schoology, etc.)
├── aiAdoptionScore: number      → NOT MAPPED (0-100)
├── propensityToSpendScore: num  → NOT MAPPED (0-100)
└── procurementHellScore: number → NOT MAPPED (0-100)
```

---

### 8. Fibbler LinkedIn Ad Engagement

**Trigger:** `fibbler-sync.ts` cron (was hourly)
**Frequency:** N/A — **cron disabled Apr 21, 2026**
**Status:** DISABLED. Not running LinkedIn ads. Fibbler zero-data signals were overwriting real website attribution. Scoring returns 0 for fibbler signals. Re-enable when ads resume.

**What it synced:** LinkedIn ad impressions, clicks, leads per company domain. Stored in `signals` table with `source = 'fibbler_engagement'`. 1,561 rows still in signals table (archiving pending).

**Downstream impact while disabled:** `enrich-contact.ts` still checks for `fibbler_influenced` flag (line 327) but no new Fibbler signals arrive. Existing Fibbler rows are filtered out of signal queries by the activity filter: `page_views.gt.0,sessions.gt.0,linkedin_action.not.is.null`.

---

## Enrichment Sources (Middle of Pipe)

### Company Enrichment — LeadMagic + Claude (Octave removed Apr 15, 2026)

**Called by:** `enrich-company.ts` via `company-data-waterfall.ts`
**Trigger:** New company domain enters pipe (not seen before)

**Company Data Waterfall** (`src/enrichment/company-data-waterfall.ts`):

Tier order (cheapest first):
1. **LeadMagic companySearch** (~1 credit, structured data) — primary
2. **Apify website-content-crawler** (~$0.0015, free-text scrape) — fallback
3. **Lightweight HTTP + meta tags** (free, last-ditch) — final fallback
4. Mark as `enrichment_gap` — caller decides

At every tier, the sub-market classifier runs on whatever data was fetched.

**LeadMagic company data → stored on `companies` table:**

```
companyName                      → companies.name
domain                           → companies.domain
description                      → companies.description
industry                         → companies.industry
employeeCount                    → companies.employee_count
headquarters.city                → companies.city
headquarters.geographicArea      → companies.state
headquarters.country             → companies.country
total_funding                    → companies.funding_total (parsed to numeric)
total_funding_formatted          → pushed as total_money_raised to HubSpot
funding_rounds                   → companies.funding_round_count
revenue                          → pushed as annualrevenue to HubSpot
revenue_formatted                → used in ICP scoring
linkedin_url                     → companies.linkedin_url
full response                    → companies.leadmagic_data (jsonb audit trail)
```

**Sub-market classification** (`src/lib/sub-market-classifier.ts`):
- Claude Haiku classifies into: K12 EdTech SaaS, Higher Ed, Government & Public Sector, Other B2B, Not B2B
- Stores: `classifier_source`, `classifier_confidence`, `classifier_reason`, `classifier_version`, `last_classified_at`

**LeadMagic employees + jobs** (`src/enrichment/providers/leadmagic-company.ts`):
- `employeeFinder(domain)` — finds employees, feeds sales team analysis
- `jobsFinder(domain)` — finds open jobs, feeds outbound need scoring
- `classifySalesTeamLLM()` — Claude analyzes employee list + jobs → sales org structure
- `scoreSalesTeamReal()` — deterministic score from analysis
- `technographics(domain)` — gated on outbound_need >= 25

**ICP scoring** (`src/scoring/tam-icp.ts`):
- `computeTamICP()` — deterministic formula, raw_total (0-175) normalized to 0-125
- Components: vertical_fit, headcount, company_stage, outbound_need, tech_stack
- Zero API calls. All local math.

### Contact Discovery — LeadMagic + Cargo Fallback

**Called by:** `discover-contact.ts` (triggered by `enrich-company.ts` after company passes gate)
**Gate:** ICP >= 50 + vertical_fit > 0 + < 500 employees + no existing deal + not TAM

**Implementation** (`src/triggers/discover-contact.ts`):
1. LeadMagic `employeeFinder(domain, 30)` — get employees at company
2. Filter to decision maker titles (`isDecisionMakerTitle()`), exclude blocked titles (`isTitleBlocked()`)
3. Sort by title seniority heuristic (CEO/CTO > VP > Director > Head of > Manager)
4. Trigger `enrich-contact` with best candidate, `lead_source = "company_discovery"`
5. Cargo verification happens downstream in enrich-contact Step 0.5

**Fallback:** If LeadMagic returns zero employees, `tam-enrich.ts` uses Cargo `findStakeholders` (6.5 credits) as discovery fallback.

### Cargo Verification Chain

**Called by:** `enrich-contact.ts` Step 0.5, `enrich-deal-contact.ts` Step 3
**Gate:** `CARGO_VERIFY_ENABLED=true` (Syft path), always-on (deal path)
**Implemented in:** `src/enrichment/providers/cargo.ts`

The verification chain (wired Apr 21, 2026):

1. **If LinkedIn URL available** → `verifyEmploymentByUrl(linkedinUrl, domain)` — uses Cargo `enrichProfile` workflow (`53f31647`, 0.5 credits). ~75% reliable. Always preferred.
2. **If no LinkedIn URL** → `verifyEmployment(firstName, lastName, domain)` — uses Cargo `enrichProfileFromName` workflow (`1ca01822`, 0.5 credits). ~44% reliable. Last resort only.
3. **Domain comparison** — `domainsMatch()` handles rebrands (tophat.com / toph.at, n2y.com / everway.com, etc.). Match = verified, mismatch = departed.
4. **Departed contacts** → stored with `job_change_detected_at`, `previous_title`, `previous_contact_name`. Enrichment stops (saves downstream credits).
5. **Verified contacts** → LinkedIn URL backfilled from Cargo if missing, enrichment continues.

| Workflow | Input | Cost | Reliability | Use when |
|----------|-------|------|-------------|----------|
| `enrichProfile` (`53f31647`) | linkedinUrl | 0.5 | ~75% | Have LinkedIn URL (always prefer) |
| `enrichProfileFromName` (`1ca01822`) | firstName, lastName, companyDomain | 0.5 | ~44% | No LinkedIn URL (last resort) |
| `findStakeholders` (`4b29f36e`) | companyDomain, titles | 6.5 | Varies | Discovery fallback when LeadMagic returns 0 |

### Email Waterfall — Cargo-First

**Called by:** `enrich-contact.ts` Step 1 via `email-waterfall.ts`
**Trigger:** Every new contact that enters pipe
**Implemented in:** `src/enrichment/email-waterfall.ts`

**Waterfall order (Cargo primary, LeadMagic fallback — since Apr 14, 2026):**

1. **If existing email** → Cargo `verifyEmail` (0.2 credits). If valid, done.
2. If Cargo rejects existing email → LeadMagic `validateEmail` (1 credit). If valid, done.
3. **If no email + have name+domain** → Cargo `findEmail` (1.1 credits). If found+verified, done.
4. If Cargo found but unverified → Cargo `verifyEmail` on found email.
5. **If Cargo missed** → LeadMagic `findWorkEmail` (1 credit). If status=valid, done.
6. If LeadMagic found but not valid → Cargo `verifyEmail` → then LeadMagic `validateEmail`.
7. If all fail → `{ email: null, verified: false, source: "none" }`.

**Returns → stored on `contacts` table:**

```
email                            → contacts.email
verified (boolean)               → contacts.email_verified
source (waterfall step)          → contacts.email_source
  Values: "cargo_validate", "leadmagic_validate", "cargo_find", "leadmagic_find", "none"
```

### Phone Lookup — LeadMagic

**Called by:** `enrich-contact.ts` Step 2, `enrich-deal-contact.ts` Step 4
**Trigger:** Contact has LinkedIn URL (or email, for deal contacts)
**Implemented in:** `src/enrichment/providers/leadmagic.ts` → `findMobilePhone()`

**Returns:**

```
mobile_number                    → contacts.phone
source = "leadmagic_mobile"      → contacts.phone_source
```

---

## Attribution & Classification Rules

All rules implemented in `src/lib/constants.ts`. No hardcoded `LEAD_ORIGIN` constant — derived at push time from `lead_source`.

### lead_source → lead_origin mapping (`deriveLeadOrigin()`, constants.ts:30-57)

| lead_source (Supabase) | lead_origin (HubSpot) |
|------------------------|-----------------------|
| `syft_website` | `Website Visitor` |
| `syft_linkedin` | `LinkedIn Engagement` |
| `tam_import` | `TAM Outbound` |
| `salesnav_import` | `Sales Nav` |
| `starbridge_referral` | `Starbridge Referral` |
| `hubspot_backfill` | `HubSpot Backfill` |
| `hubspot_deal_created` | `Deal Created` |
| `company_discovery` | `Company Discovery` |
| `fibbler_engagement` | `LinkedIn Ad Engagement` |
| `departed_follow` | `Departed Follow` |
| `departed_backfill` | `Departed Backfill` |
| (default) | `V2 Enriched` |

### lead_type classification (`deriveLeadType()`, constants.ts:99-108)

| Classification | lead_source values |
|---------------|--------------------|
| `inbound` | `syft_website`, `syft_linkedin`, `fibbler_engagement`, `company_discovery`, `posthog_identify` |
| `outbound` | `tam_import`, `departed_follow`, `departed_backfill` |
| `referral` | `salesnav_import`, `starbridge_referral` |
| `unknown` | Everything else (including `hubspot_backfill`, `hubspot_deal_created`) |

### signal_type derivation (`getSignalType()`, constants.ts:67-88)

Returns `null` for non-signal sources — NEVER returns "Unknown" as placeholder.

| lead_source | signal_type |
|-------------|-------------|
| `syft_website` | `Company Intent` |
| `syft_linkedin` | `LinkedIn Engagement` |
| `hubspot_deal_created` | `Deal Created` |
| `company_discovery` | `Company Intent` |
| `fibbler_engagement` | `LinkedIn Engagement` |
| `tam_import` | `null` (no signal — attribution lives in lead_origin) |
| `hubspot_backfill` | `null` |
| (default) | `null` |

### AE Owner Routing (`deriveAeOwner()`, constants.ts:121-139)

Territory-based routing on `sub_market`:
- **RepA:** `K12 EdTech SaaS` (exact) + loose match on `k12`/`k-12`
- **RepB:** `Higher Ed` or `Government & Public Sector` (exact) + loose match
- **null** (HubSpot Auto-Assign handles): all other sub_markets

Routing is on contacts only, not companies (per `feedback_territory_assignment.md`).

### MQL Rules (`isMQL()`, constants.ts:154-166 + `isMql()`, gates.ts:358-378)

Two implementations, slightly different gates:

**`isMQL()` in constants.ts** (used by `enrich-contact.ts`):
- Must be `inbound` (via `deriveLeadType()`)
- Must be `hot` or `warm` tier

**`isMql()` in gates.ts** (full gate, used for Slack alerts + priority routing):
- Must be `inbound` lead_type
- Must be `hot` or `warm` tier
- Must have buyer title (MQL_BUYER_PATTERNS allowlist — CEO, COO, CRO, Founder, President, Owner, VP Sales, Head of Sales, Sales Director, GM, Managing Director)
- Must be SLED sub_market (if provided)

**When MQL = true:** `is_mql=true`, `mql_at=now()`, `lifecyclestage=marketingqualifiedlead` pushed to HubSpot. Slack alert fires (when re-enabled). TAM outbound contacts are NEVER MQLs.

---

## Push Gates

All gates implemented in `src/lib/gates.ts`. Rejections logged to `push_log` with `action: "gate_rejected"`.

### Validation Gate (`passesValidationGate()`, gates.ts:53-70)

- Valid domain (not internal, not .edu/.gov/.k12.)
- Must have `page_views > 0` OR `linkedin_action` present
- **Bypass:** `hubspot_deal_created` signals skip engagement check

### Company Push Gate (`passesCompanyPushGateWithReason()`, gates.ts:135-160)

- Valid domain
- Not enterprise blocklist
- Has sub_market (not empty, not "Not B2B", not "Other B2B")
- **SLED only:** sub_market must be in `SLED_PUSH_MARKETS` (K12 EdTech SaaS, Higher Ed, Government & Public Sector + variants)
- ICP score >= 50
- Vertical fit > 0
- Employee count < 500
- **Bypass:** `hubspot_deal_created` auto-passes

### Contact Push Gate (`passesContactPushGateWithReason()`, gates.ts:275-313)

- Has email
- Not already in HubSpot
- Not internal domain
- Not blocked title (`TITLE_BLOCKLIST_PATTERNS` + `TITLE_BLOCKLIST_ACRONYMS`)
- ICP score >= 50
- **SLED only:** sub_market must be in `SLED_SUB_MARKETS`
- **US/CA geo gate** (if country provided)
- Must be Hot/Warm tier, OR `company_discovery` with vertical_fit > 0
- **Bypass:** `tam_import` auto-passes (gates.ts:308) — TAM gate bypass in prod, manual trigger only

### Contact Update Gate (`passesContactUpdateGate()`, gates.ts:322-353)

- Must have HubSpot Contact ID
- If `needs_refresh=true` → always passes
- Same gates as push (minus email/existing check)

---

## Downstream Consumers

### HubSpot Company Push

**Called by:** `enrich-company.ts` → `pushCompanyToHubSpot()` (line 291-353)
**Gate:** `passesCompanyPushGateWithReason()` — SLED only, ICP >= 50, vertical_fit > 0, < 500 employees, not enterprise
**Also called by:** `enrich-deal-contact.ts` (no gates — always pushes for deals)
**Implemented in:** `src/lib/hubspot.ts:77-139`

**Properties pushed (HubSpot internal name → source):**

| HubSpot Property | Source | Notes |
|-----------------|--------|-------|
| `domain` | companies.domain | |
| `name` | companies.name | |
| `linkedin_company_page` | companies.linkedin_url | |
| `numberofemployees` | companies.employee_count | |
| `sub_market` | companies.sub_market | Custom prop |
| `icp_score` | companies.icp_score | Normalized 0-125 |
| `intent_score` | companies.intent_score | From signals table (via update-hubspot) |
| `lead_tier` | companies.lead_tier | |
| `lead_temp` | companies.lead_temp | "Hot"/"Warm"/"Cold" (capitalized) |
| `lead_origin` | `deriveLeadOrigin(lead_source)` | Dynamic — "Website Visitor", "TAM Outbound", etc. |
| `total_score` | icp_score (+ intent via update-hubspot) | |
| `first_touch_source` | companies.first_touch_source | |
| `touch_channels` | companies.touch_channels | |
| `touch_campaigns` | companies.touch_campaigns | |
| `syft_intent` | companies.syft_intent_level | "very high" → "high" mapping |
| `matched_intents` | companies.matched_intents | |
| `utm_medium` | companies.utm_medium | |
| `latest_source` | companies.latest_source | |
| `lead_summary` | companies.lead_summary | Claude AI-generated |
| `sales_org_summary` | companies.sales_org_summary | Claude + LeadMagic employee analysis |
| `description` | companies.description | |
| `city` | companies.city | From LeadMagic headquarters |
| `state` | companies.state | |
| `country` | companies.country | |
| `funding_stage` | companies.funding_stage | Mapped to HubSpot enum via `toHubSpotFundingStage()` |
| `annualrevenue` | LeadMagic revenue | |
| `total_money_raised` | LeadMagic total_funding_formatted | |
| `icp_tier` | Derived from icp_score | "priority"/"strong_fit"/"high_potential"/"review" |

### HubSpot Contact Create

**Called by:** `enrich-contact.ts` → `createHubSpotContact()` (line 615-662)
**Gate:** `passesContactPushGateWithReason()` — has email, not in HubSpot, not internal domain, not blocked title, ICP >= 50, SLED, US/CA, Hot/Warm or company_discovery or tam_import
**Implemented in:** `src/lib/hubspot.ts:184-234`

**Properties pushed:**

| HubSpot Property | Source | Notes |
|-----------------|--------|-------|
| `email` | contacts.email | Required |
| `firstname` | contacts.first_name | |
| `lastname` | contacts.last_name | |
| `jobtitle` | contacts.title | |
| `company` | companies.name | Company NAME, not domain |
| `hs_linkedin_url` | contacts.linkedin_url | |
| `lead_tier` | tier_display | "Cold" → "" mapping |
| `lead_temp` | tier_display | "Cool" → "Cold" mapping. Skipped for outbound sources to avoid triggering MQL/nurture workflows. |
| `lead_origin` | `deriveLeadOrigin(lead_source)` | Dynamic per source — no more hardcoded "Clay" |
| `lead_type` | `deriveLeadType(lead_source)` | "inbound"/"outbound"/"referral"/"unknown" |
| `clay_lead_source` | contacts.lead_source | Raw signal path name. Fibbler-influenced contacts get comma-separated: `"syft_website,fibbler_linkedin_ad"` |
| `signal_type` | `getSignalType(lead_source)` | "Company Intent"/"LinkedIn Engagement"/"Deal Created"/null |
| `total_score` | icp_score + intent_score | |
| `icp_score` | From company lookup | |
| `intent_score` | Max from signals table | |
| `lead_summary` | Claude AI-generated | Per-contact version with signal behavior data |
| `sales_org_summary` | companies.sales_org_summary | |
| `sub_market` | companies.sub_market | |
| `city` | companies.city | |
| `state` | companies.state | |
| `first_touch_channel` | companies.first_touch_source | |
| `utm_source` | companies.utm_sources | |
| `utm_medium` | companies.utm_medium | |
| `utm_campaign` | companies.touch_campaigns | |
| `phone` | contacts.phone | From LeadMagic |
| `hubspot_owner_id` | `AE_OWNERS[ae_owner]` | Set for outbound + territory-routed contacts |
| `lifecyclestage` | MQL → "marketingqualifiedlead", outbound → "lead" | GTMOS owns this, not HubSpot workflows |
| `signal_date` | latestSignal.created_at | ISO → midnight UTC epoch ms via `toHubSpotDate()` |
| `signal_pages_visited` | latestSignal.session_pages_visited | Comma-separated URLs |
| `signal_sessions` | latestSignal.sessions | Session count |
| `signal_time_on_site` | latestSignal.active_time_seconds | Seconds on site |
| `icp_tier` | Derived from icp_score | "priority"/"strong_fit"/"high_potential"/"review" |

### HubSpot Contact Update

**Called by:** `update-hubspot.ts` (score updates), `enrich-contact.ts` (stale refresh, LinkedIn backfill)
**Implemented in:** `src/lib/hubspot.ts:278-319`

**Properties pushed (same mapping as create, plus):**

| HubSpot Property | Source | Notes |
|-----------------|--------|-------|
| `signal_date` | latestSignal.created_at | **Added Apr 21** — existing contacts get fresh signal data on score updates |
| `signal_pages_visited` | latestSignal.session_pages_visited | **Added Apr 21** |
| `signal_sessions` | latestSignal.sessions | **Added Apr 21** |
| `signal_time_on_site` | latestSignal.active_time_seconds | **Added Apr 21** |
| `hs_linkedin_url` | contacts.linkedin_url | Added Apr 8 — backfills LinkedIn to existing contacts |

**Not pushed on update:** UTMs (`utm_source`, `utm_medium`, `utm_campaign`) — Syft owns these on existing contacts. Only set on CREATE. (G14 fix)

### HubSpot Workflows

These fire AFTER data is pushed to HubSpot. They read HubSpot properties, not Supabase. Zero active workflows filter on `lead_origin` (verified Apr 20 audit of `docs/hubspot-schema/workflows.json`).

| Workflow | Reads | Enum values that MUST match |
|----------|-------|----------------------------|
| MQL → Auto-Assign to RepA (id=29283830) | ownerless MQL contacts | `lifecyclestage = marketingqualifiedlead` (unconditional, no territory filter) |
| MQL Progression | `lead_temp` = "Hot" or "Warm" | Capitalized |
| Cold Lead Nurture | `lead_temp` = "Cold" | Capitalized |
| Hot Lead Slack Alert | `lead_temp` = "Hot" | Capitalized |
| Meeting Booked → Deal | `meetings` association | N/A |
| New Deal Alert | `deal` creation | N/A |
| Partnership Deal Alert | `pipeline` = "Partners" | |
| CW Date Change | `dealstage` = "closedwon" | |
| Deal Won → Customer | `dealstage` = "closedwon" | |

**Critical enum values** (must be exact):
- `lead_temp`: `"Hot"`, `"Warm"`, `"Cold"` (capitalized first letter)
- `lead_tier`: `"Hot"`, `"Warm"`, `"Cool"`, `""` (empty string for Cold)
- `lead_origin`: Dynamic per `deriveLeadOrigin()` — no longer hardcoded "Clay"
- `lead_type`: `"inbound"`, `"outbound"`, `"referral"`, `"unknown"` — separates MQL from TAM workflows
- `signal_type`: `"Company Intent"`, `"LinkedIn Engagement"`, `"Deal Created"`, or not set (null for non-signal sources)
- `icp_tier`: `"priority"`, `"strong_fit"`, `"high_potential"`, `"review"`

### Slack Alerts

**Called by:** `enrich-contact.ts` → `sendSlackAlert()` (MQL alerts), `update-hubspot.ts` (tier upgrade alerts)
**Status:** **DISABLED since Apr 17, 2026.** `SLACK_WEBHOOK_URL` hard-coded to `null` in `src/lib/slack.ts`, `pipe-health.ts`, `rep_c-digest.ts`. Old webhook pointed at wrong channel. Message-building code is intact — only the POST is short-circuited. Do not re-enable without confirming new channel + new webhook.

**MQL alert payload (when re-enabled):** contact_name, title, domain, company_name, email, linkedin_url, icp_score, intent_score, total_score, tier, lead_source, lead_origin, signal_type, sub_market, lead_summary, page_views, sessions, last_seen, hubspot_contact_id, employee_count, city, state, funding_stage, funding_total, sales_team_data, octave_score, pages_visited, utm_channel.

### Cron Tasks (LIVE)

| Task | Reads from | Writes to | Frequency | Status |
|------|-----------|-----------|-----------|--------|
| `deal-sync` | HubSpot deals API | triggers enrich-deal-contact | Hourly | LIVE |
| `contact-backfill` | contacts (missing icp_score) + companies | contacts, HubSpot contacts | Hourly | LIVE |
| `utm-backfill` | contacts missing UTM + signals with UTM | contacts | Every 6h | LIVE |
| `hubspot-enrich-new` | HubSpot contacts without enrichment | triggers enrich-contact | Hourly | LIVE |
| `hubspot-parity-audit` | raw_signals, push_log, contacts | Supabase scheduled_runs | Weekly (Sun 10am UTC) | LIVE (audit-only, no Slack) |
| `pipe-health` | raw_signals, push_log, signals | (Slack disabled) | Every 4h | LIVE (no-op on Slack) |

### Cron Tasks (DISABLED / NO-OP)

| Task | Status | Reason |
|------|--------|--------|
| `fibbler-sync` | Cron disabled Apr 21 | Not running LinkedIn ads. Zero-data signals overwrite real attribution. |
| `company-refresh` | Stubbed no-op since Apr 15 | Octave removal. Cargo verification in enrich-contact covers departures. |
| `contact-refresh` | Stubbed no-op since Apr 15 | Same as above. |
| `deal-refresh` | Stubbed no-op since Apr 15 | Same as above. |
| `rep_c-digest` | Slack disabled | Webhook null'd Apr 17. |

---

## Schema → Code Mapping

### raw_signals (written by syft-webhook/syft-poll, read by normalize + score-intent)

All 37 extracted columns verified against real Syft payloads (Mar 15).
`raw_payload jsonb` stores full payload — nothing is lost even if extraction misses a field.

### companies (written by enrich-company, enrich-deal-contact, tam-enrich)

Written by three paths:
- `enrich-company.ts` — Syft pipeline (LeadMagic + Claude classifier + deterministic ICP)
- `enrich-deal-contact.ts` — Deal pipeline (same chain, no gates)
- `tam-enrich.ts` — TAM batch (LeadMagic + Claude + ICP, stores but does not push)

Key columns added post-Mar 15:
- `classifier_source`, `classifier_confidence`, `classifier_reason`, `classifier_version`, `last_classified_at` — sub-market classification paper trail
- `data_source` — which enrichment tier provided data ("leadmagic", "apify", "website_fetch", "none")
- `leadmagic_data` (jsonb) — raw LeadMagic response (replaces `octave_raw`)
- `sales_team_data` (jsonb) — real LeadMagic employee analysis (replaces Octave Q&A inference)
- `sales_hiring_data` (jsonb) — LeadMagic jobs data
- `tech_stack_data` (jsonb) — LeadMagic technographics
- `tam_icp_raw` — raw ICP score before normalization (0-175)
- `enrichment_sources` (text[]) — which providers contributed data

Dead weight columns (from pre-Octave era): `octave_score`, `octave_rationale`, `octave_segment`, `octave_product`, `octave_playbook`, `octave_disqualifiers`, `octave_raw`. Still exist in schema but never written by current code.

### contacts (written by enrich-contact, enrich-deal-contact)

Key columns added post-Mar 15:
- `lead_origin` — derived at push time via `deriveLeadOrigin(lead_source)`, no longer hardcoded "Clay"
- `lead_type` — "inbound"/"outbound"/"referral"/"unknown" via `deriveLeadType(lead_source)`
- `ae_owner` — "rep_a"/"rep_b"/null via `deriveAeOwner(sub_market)` or explicit from TAM activate
- `is_mql`, `mql_at` — GTMOS-owned MQL determination
- `fibbler_influenced` — boolean flag from Fibbler signal check
- `enrichment_sources` (text[]) — which providers contributed data
- `job_change_detected_at`, `previous_title`, `previous_contact_name` — departure detection

`full_name` and `combined_score` are generated columns.
Dead weight: `verified_company_domain`, `company_match` (MixRank verification), `refresh_trigger`, `hubspot_company_precheck`.

### signals (written by score-intent)

30 columns. `contact_id` is nullable (signal arrives before contact creation, never backfilled).

### enrichment_log (NEW — written by enrichment-logger.ts)

Logs every enrichment API call: provider, operation, lookup_key, input/output payloads, credits, duration, success/error. Enables credit tracking and deduplication.

---

## What's NOT documented yet

- **Starbridge full field mapping** — not integrated, API client exists separately
- **LemList enrollment payload** — helpers exist in `src/lib/lemlist.ts`, auto-enrollment stubbed but not live
- **PostHog $pageview events** — only $identify is planned; could add pageview tracking later
- **Raw provider response storage** — enrichment data discarded after one read. `enrichment_log` table partially addresses this (stores input/output payloads).
