# Signal Pipeline — Cross-System Entity Relationship Diagram

Updated: Apr 22, 2026

Source of truth for how data flows between Supabase, HubSpot, and external providers. For Supabase-only schema details see `SCHEMA.md`. For HubSpot-only properties see `docs/hubspot-schema/`.

---

## Signal Sources — All Inputs and Why They Exist

Every record in the system entered through one of these doors. Each has different rules, different data quality, and different downstream behavior.

### 1. Syft Website (`syft_website`)
- **What:** Anonymous company visits to acmegtm.com (and client sites)
- **How it arrives:** Webhook (real-time) + 30-minute poll (`syft-poll.ts`)
- **What it carries:** domain, page_views, sessions, active_time_seconds, pages visited, UTMs
- **Why it exists:** Inbound demand signal — company is actively researching
- **Intake rules:** `normalize.ts` validates domain, rejects .edu/.gov/internal/enterprise
- **Scoring:** Intent scored (page depth, recency, BOFU pages) + company ICP scored
- **Gates to HubSpot:** SLED sub_market + ICP >= 50 + has email + buyer title + hot/warm tier
- **Lead type:** `inbound` — eligible for MQL if qualified
- **Volume:** ~102 companies to date

### 2. Syft LinkedIn (`syft_linkedin`)
- **What:** LinkedIn engagement with RepC's posts (likes, comments, follows, profile views)
- **How it arrives:** Same webhook/poll as website
- **What it carries:** domain, linkedin_action (like/comment/follow/view), profile URL
- **Why it exists:** Social intent signal — company employees engaging with content
- **Intake rules:** Same as website
- **Scoring:** LinkedIn action scored (comment > like > follow > view) + company ICP
- **Gates to HubSpot:** Same SLED + qualification gates as website
- **Lead type:** `inbound`
- **Volume:** ~211 companies to date

### 3. TAM Import (`tam_import`)
- **What:** AE-curated target account lists (RepB's Higher Ed, RepA's K12)
- **How it arrives:** CSV → `tam-enrich.ts` (manual trigger, no cron)
- **What it carries:** domain, company name, ae_owner, tam_list name
- **Why it exists:** Outbound prospecting — AEs pick companies to pursue
- **Intake rules:** No normalize gate (already curated). `tam-enrich` enriches via LeadMagic + scores via `tam-icp.ts`
- **Scoring:** TAM-specific ICP (vertical_fit + headcount + stage + sales_org + funding + tech_stack, 0-175 scale → T1/T2/T3/DQ)
- **Gates to HubSpot:** Bypasses tier gate at `gates.ts:308` (intentional — TAM has no intent signals). Still requires email + SLED.
- **Lead type:** `outbound` — never MQL, never triggers lead_temp workflows (if handled correctly)
- **Volume:** 1,551 companies (965 RepB, 583 RepA, 3 unowned)
- **Known issue:** Gate bypass caused 152 zero-intent contacts to leak into HubSpot (cleaned Apr 22). See `open-threads.md`.

### 4. HubSpot Backfill (`hubspot_backfill`)
- **What:** Existing CRM contacts/companies pulled into Supabase for enrichment
- **How it arrives:** `contact-backfill.ts` cron (hourly) + one-time historical pull
- **What it carries:** email, name, title, hubspot IDs, existing HubSpot properties
- **Why it exists:** Enrich existing CRM data with LinkedIn URLs, phones, verified employment
- **Intake rules:** No signal gates — these already exist in HubSpot
- **Scoring:** ICP scored on the company side. No intent scoring (no signal).
- **Gates to HubSpot:** Updates only (already in HubSpot). Score updates pushed back.
- **Lead type:** N/A (not classified — pre-existing)
- **Volume:** 420 companies, 841 contacts

### 5. HubSpot Deal Created (`hubspot_deal_created`)
- **What:** New deals in HubSpot trigger contact enrichment
- **How it arrives:** `deal-sync.ts` cron (hourly) detects new deals → `enrich-deal-contact.ts`
- **What it carries:** deal ID, associated contact email, company domain
- **Why it exists:** Every deal contact MUST have LinkedIn URL + phone for RepC's plays
- **Intake rules:** No signal gates. Standalone task, calls enrichment primitives directly, no SLED gate.
- **Scoring:** Company ICP only (no intent — deal is the intent)
- **Gates to HubSpot:** No gates — deal contacts are already in HubSpot. Enrichment updates pushed directly.
- **Lead type:** N/A
- **Volume:** 28 companies, 4 contacts
- **Known issue:** 59 failed deal_enrich contact pushes (91% failure rate) — needs investigation

### 6. Fibbler (`fibbler_engagement`) — DISABLED
- **What:** LinkedIn ad impressions/clicks from Fibbler dashboard
- **How it arrives:** `fibbler-sync.ts` cron — **OFF since Apr 21**
- **Why disabled:** Not running LinkedIn ads. Fibbler zero-data signals were overwriting real website attribution.
- **Volume:** 1,561 signal rows in DB (noise, pending archive). 22 contacts.
- **Scoring:** `scoreFibblerEngagement()` returns 0 even if re-enabled
- **Re-enable when:** LinkedIn ads resume + new signal query filter confirmed

### 7. Departed Backfill / Follow (`departed_backfill`, `departed_follow`)
- **What:** Contacts flagged as departed by Cargo verification
- **How it arrives:** Enrichment detects job change → creates departed record
- **Why it exists:** Track champion movements for re-engagement
- **Volume:** 10 + 2 contacts
- **Lead type:** `outbound`

### 8. Other Legacy Sources
- `company_discovery` (16 contacts) — Prospector-discovered contacts from pipeline
- `website_visitor` (15 contacts) — Pre-Syft website visitor flow
- `linkedin_ad_engagement` (22 contacts) — Pre-Fibbler LinkedIn tracking
- `linkedin_engagement` (6 contacts) — Direct LinkedIn tracking
- `clay` (4 contacts) — Old Clay pipeline remnants
- `contact_refresh` (4 contacts) — Octave-era refresh cycle
- `deal_created` (1 contact) — Pre-rename of hubspot_deal_created
- `null` (9 contacts) — Unknown origin, 7 in HubSpot

---

## Intake → Enrichment → Scoring → Push Rules

```
                    INTAKE RULES                    ENRICHMENT              SCORING                  PUSH GATES
                    ════════════                    ══════════              ═══════                  ══════════

syft_website ──▶  normalize.ts:                    enrich-company:         ICP (0-125):             Company gate:
syft_linkedin     • valid domain?                  • LeadMagic primary     • vertical_fit (0-35)    • ICP >= 50
                  • not .edu/.gov?                 • Apify fallback        • headcount (0-15)       • SLED sub_market
                  • not internal?                  • website-fetch last    • stage (0-30)           • not enterprise
                  • not enterprise?                                        • sales_org (0-50)
                  • not blocklisted?               enrich-contact:                                  Contact gate:
                           │                       • Cargo verify (URL)    Intent (0-120):          • has email
                           ▼                       • email waterfall       • purchase_intent (0-20) • buyer title
                     raw_signals                   • phone lookup          • engagement (0-25)      • hot/warm tier
                                                                           • direct_action (0-35)     OR company_discovery
                                                                           • referral (0-10)          OR tam_import bypass
                                                                           • page_intent (0-30)
                                                                           • decay (7d/14d/30d/60d)

tam_import ──▶    No normalize gate                tam-enrich:             TAM ICP (0-175):         Company gate:
                  (already curated)                • LeadMagic company     • vertical_fit (0-35)    • same as above
                           │                       • LeadMagic employees   • headcount (0-15)
                           ▼                       • Claude classifier     • stage (0-30)           Contact gate:
                     companies                     • Claude summary        • sales_org (0-50)       • BYPASSES tier check
                     (direct upsert)                                       • funding (0-30)           at gates.ts:308
                                                   discover-contact:       • tech_stack (0-15)      • still needs email
                                                   → enrich-contact                                 • still needs SLED

hs_backfill ──▶   No intake gate                   hubspot-enrich-new:     ICP only                 Updates only
                  (already in HubSpot)             • Cargo verify          (no intent — no signal)  (already in HubSpot)
                           │                       • email/phone/LinkedIn
                           ▼
                     contacts + companies
                     (with hubspot IDs set)

hs_deal ──▶       No intake gate                   enrich-deal-contact:    ICP only                 No gates
                  (deal = the signal)              • Cargo primary         (deal is the intent)     (deal contacts are
                           │                       • No gates                                        already in HubSpot)
                           ▼
                     contacts
```

---

## The Full Picture

```
╔══════════════════╗                                          ╔══════════════════╗
║  SIGNAL SOURCES  ║                                          ║    HUBSPOT CRM   ║
╚════════╤═════════╝                                          ╚════════╤═════════╝
         │                                                             │
    Syft webhooks                                              5 active workflows
    Syft 30m poll                                              311 company props
    HubSpot deal sync                                          445 contact props
    TAM CSV imports                                            2 deal pipelines
    HubSpot backfill                                           13 owners
         │                                                             ▲
         ▼                                                             │
╔════════════════════════════════════════════════════════════════════════╪═════════╗
║                              SUPABASE                                │         ║
║                                                                      │         ║
║  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐         │         ║
║  │ raw_signals  │────▶│  companies   │────▶│  push_log    │─────────┘         ║
║  │ (1,424)      │     │  (2,312)     │     │  (1,090)     │  writes to HS     ║
║  └──────┬───────┘     └──────┬───────┘     └──────────────┘                   ║
║         │                    │                     ▲                           ║
║         │             ┌──────┴───────┐             │                           ║
║         │             │   contacts   │─────────────┘                           ║
║         │             │  (1,978)     │  writes to HS                           ║
║         │             └──────┬───────┘                                         ║
║         │                    │                                                 ║
║         ▼                    ▼                                                 ║
║  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                   ║
║  │   signals    │     │enrichment_log│     │  audit_*     │                   ║
║  │  (1,916)     │     │  (2,167)     │     │ (drift det.) │                   ║
║  └──────────────┘     └──────────────┘     └──────────────┘                   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
         ▲                     ▲
         │                     │
    ┌────┴────┐          ┌─────┴─────┐
    │  Syft   │          │  Cargo    │
    │LeadMagic│          │ LeadMagic │
    │  Apify  │          │  Claude   │
    └─────────┘          └───────────┘
    company data         people data
```

---

## Cross-System Entity Map

### Companies: Supabase ↔ HubSpot

```
SUPABASE companies              LINK                    HUBSPOT Companies
══════════════════              ════                    ═════════════════
id (uuid, PK)                                          id (numeric string)
                          hubspot_company_id ──────▶   id
domain (UQ)               ═══ matched by ═══          domain
name                      ──────push──────▶           name
employee_count            ──────push──────▶           numberofemployees
sub_market                ──────push──────▶           sub_market
icp_score                 ──────push──────▶           icp_score
lead_tier                 ──────push──────▶           lead_tier
lead_temp (derived)       ──────push──────▶           lead_temp ──▶ triggers workflows #4,#5
lead_origin (derived)     ──────push──────▶           lead_origin
total_score               ──────push──────▶           total_score
lead_summary              ──────push──────▶           lead_summary
sales_org_summary         ──────push──────▶           sales_org_summary
icp_tier (derived)        ──────push──────▶           icp_tier
funding_stage             ──────push──────▶           funding_stage
                                                      ────────────────────
ae_owner                  NOT PUSHED                  (no company owner in HS)
tam_tier                  NOT PUSHED                  (no HS property)
tam_icp_raw               NOT PUSHED                  (internal scoring)
enriched_at               NOT PUSHED                  (internal tracking)
lead_source               NOT PUSHED                  (internal routing)
                                                      ────────────────────
                          ◀──── read ────             lifecyclestage
                          ◀── Syft writes ──          syft_* (30+ props)
                          ◀── Fibbler ──              fibbler_* (6 props, DISABLED)
```

### Contacts: Supabase ↔ HubSpot

```
SUPABASE contacts               LINK                   HUBSPOT Contacts
═════════════════               ════                   ════════════════
id (uuid, PK)                                          id (numeric string)
                          hubspot_contact_id ─────▶    id
email (UQ)                ═══ matched by ═══           email
first_name                ──────push──────▶            firstname
last_name                 ──────push──────▶            lastname
title                     ──────push──────▶            jobtitle
phone                     ──────push──────▶            phone
linkedin_url (UQ)         ──────push──────▶            hs_linkedin_url
tier                      ──────push──────▶            lead_tier (Cold→"")
lead_temp (derived)       ──────push──────▶            lead_temp (Cool→Cold) ──▶ workflows
lead_origin (derived)     ──────push──────▶            lead_origin
lead_type                 ──────push──────▶            lead_type
lead_source               ──────push──────▶            clay_lead_source
icp_score                 ──────push──────▶            icp_score
intent_score              ──────push──────▶            intent_score
total_score               ──────push──────▶            total_score
lead_summary              ──────push──────▶            lead_summary
sales_org_summary         ──────push──────▶            sales_org_summary
sub_market                ──────push──────▶            sub_market
icp_tier (derived)        ──────push──────▶            icp_tier
                                                       ────────────────────
                          SIGNAL ATTRIBUTION:
signal_date (from signal) ──────push──────▶            signal_date
signal_pages (from signal)──────push──────▶            signal_pages_visited
signal_sessions           ──────push──────▶            signal_sessions
signal_time               ──────push──────▶            signal_time_on_site
signal_type (derived)     ──────push──────▶            signal_type
                                                       ────────────────────
                          TAM ACTIVATION:
ae_owner → AE_OWNERS[]   ──────push──────▶            hubspot_owner_id ──▶ workflow #3
is_mql → "mql"           ──────push──────▶            lifecyclestage ──▶ workflow #3
                                                       ────────────────────
ae_owner                  NOT PUSHED (as text)         (pushed as hubspot_owner_id)
tier                      NOT PUSHED (raw)             (pushed as lead_tier w/ mapping)
company_id                NOT PUSHED                   (HS uses association)
has_intent_signal         NOT PUSHED                   (internal flag)
                                                       ────────────────────
                          ◀── Syft writes ──           syft_* (30+ props)
                          ◀── HubSpot ──               engagements_last_meeting_booked ──▶ wf #1,#2
```

### Deals: HubSpot-only (Supabase reads, doesn't write)

```
HUBSPOT Deals                            SUPABASE
═════════════                            ════════
id                                       (no deals table)
pipeline: "Acme GTM Sales"
stages: Pre-meeting → Closed Won/Lost
────────────────────
Created by: workflow #1 (Meeting Booked)   raw_signals.deal_id ◀── deal-sync reads
Amount: $8,000 (hard-coded default)
Owner: inherited from contact owner
────────────────────
Custom props: deal_origin, partner_sourced,
  service_type, number_of_sdrs_needed
```

---

## HubSpot Workflows That Consume Our Data

```
WORKFLOW                              TRIGGERS ON               WHAT IT DOES
════════                              ═══════════               ════════════

#1 Meeting Booked → Deal             engagements_last_          Creates $8K deal
   (29245269, ACTIVE)                meeting_booked             in default pipeline

#2 Meeting → Follow-Up Task          (all contacts)             Creates 3-day
   (29284169, ACTIVE)                                           follow-up task

#3 MQL → Auto-Assign RepA            lifecyclestage = MQL       Sets hubspot_owner_id
   (29283830, ACTIVE) ⚠️             AND owner IS EMPTY         = 162280197 (RepA)
                                                                 NO territory filter

#4 Hot Lead → Slack Alert            lead_temp = "Hot"          Fires Slack extension
   (29444265, ACTIVE)                AND not customer            (currently broken —
                                                                 Slack webhook null'd)

#5 Cold Lead → Nurture               lead_temp = "Cold"         Sets lifecycle = lead
   (29444250, ACTIVE)                AND not customer            Sets status = Nurture
```

**Critical:** Workflows #3-#5 fire on properties WE push. If we push `lead_temp = "Hot"` on a TAM contact, workflow #4 fires (Slack alert for a cold outbound). If we push `lifecyclestage = "marketingqualifiedlead"` without `hubspot_owner_id`, workflow #3 assigns to RepA regardless of territory.

---

## Source of Truth by Field

Who owns each piece of data? Where should you look to find the "real" value?

| Data | Source of Truth | Why |
|------|----------------|-----|
| Company firmographics (name, size, industry) | **Supabase** | LeadMagic-enriched, fresher than HS |
| Company ICP score / tier | **Supabase** | Computed locally, pushed to HS |
| Company sub_market | **Supabase** | Claude-classified, pushed to HS |
| Contact email / phone / title | **Supabase** | Cargo-verified, pushed to HS |
| Contact LinkedIn URL | **Supabase** | Enriched via Cargo/LeadMagic |
| Contact ownership (which AE) | **HubSpot** | `hubspot_owner_id` is authoritative; Supabase `ae_owner` is a routing hint |
| Contact lifecycle stage | **HubSpot** | Workflows modify this; Supabase doesn't track changes |
| Deal status / stage | **HubSpot** | Supabase reads via deal-sync but doesn't write |
| Deal amount / close date | **HubSpot** | Set by workflow #1 or manually by AE |
| Signal data (page views, sessions) | **Supabase** | Syft → raw_signals → signals; pushed to HS as attribution |
| Meeting booked | **HubSpot** | HS native tracking, not in Supabase |
| UTM / attribution | **HubSpot** | Syft writes directly; we only write on contact create |
| Enrichment history | **Supabase** | enrichment_log; HS has no equivalent |
| Push success/failure | **Supabase** | push_log; HS doesn't know about failures |

---

## Drift Risk Points

These are the seams where Supabase and HubSpot can disagree:

| Risk | What drifts | Detection |
|------|-------------|-----------|
| **Company exists in SB, not HS** | TAM companies (954 RepB, 222 RepA) | `companies WHERE hubspot_company_id IS NULL` |
| **Contact exists in SB, not HS** | TAM contacts (650 RepB, 251 RepA) | `contacts WHERE hubspot_contact_id IS NULL AND lead_source = 'tam_import'` |
| **Contact exists in HS, not SB** | Manual adds, old Clay imports | `audit_hs_contacts_snapshot` vs contacts table |
| **Score differs SB vs HS** | Score updated in SB, push failed | `push_log WHERE action = 'score_update' AND NOT success` |
| **Owner differs SB vs HS** | Workflow #3 reassigns, SB doesn't know | Query HS API for `hubspot_owner_id` vs Supabase `ae_owner` |
| **Lifecycle differs** | Workflow #5 downgrades to lead, SB doesn't track | Query HS API for `lifecyclestage` |
| **Contact departed** | Cargo flags departure, HS still active | `enrichment_log WHERE result->>'departed' = 'true'` vs HS |
| **lead_temp triggers wrong workflow** | TAM contact gets Hot → fires Slack alert | `contacts WHERE lead_source = 'tam_import' AND lead_temp IS NOT NULL` |

---

## Supabase Internal Relationships

### Foreign Key Map

```
companies.id
  ├──← contacts.company_id          (1:many — 1,978 contacts across 2,312 companies)
  ├──← raw_signals.company_id       (1:many — inbound signal intake)
  ├──← signals.company_id           (1:many — scored signal records)
  ├──← enrichment_log.company_id    (1:many — enrichment audit trail)
  ├──← octave_results.company_id    (1:many — DEPRECATED, Octave removed Apr 15)
  └──← outbound_sequences.company_id (1:many — 0 rows, future LemList)

contacts.id
  ├──← raw_signals.contact_id       (1:many — signal → contact linkage)
  ├──← signals.contact_id           (1:many — scored signal → contact)
  ├──← enrichment_log.contact_id    (1:many — contact enrichment audit)
  └──← outbound_sequences.contact_id (1:many — 0 rows, future LemList)

raw_signals.id
  └──← signals.raw_signal_id        (1:1 — raw intake → scored signal)

enrichment_log.id
  └──← enrichment_dedup_cache.enrichment_log_id (1:1 — dedup guard)
```

### Unique Constraints (Natural Keys)

| Table | Column(s) | Meaning |
|-------|-----------|---------|
| companies | `domain` | One company per domain |
| contacts | `email` | One contact per email |
| contacts | `linkedin_url` | One contact per LinkedIn profile |
| domain_blocklist | `domain` | Blocklist is domain-unique |
| enrichment_credits | `date + provider + operation + trigger_source` | One rollup per day/provider/op/source |
| enrichment_dedup_cache | `provider + operation + lookup_key` | Prevents duplicate enrichment calls |

---

## External Provider Data Flow

```
PROVIDER        WHAT IT GIVES US             WHERE IT LANDS              COST
════════        ════════════════             ══════════════              ════
Syft            Website visits, LinkedIn     raw_signals → companies     Free (webhook)
                engagement, UTMs, sessions   + direct to HS (syft_*)

LeadMagic       Company firmographics,       companies (enrichment)      ~$0.01/call
                employee lists, emails,      contacts (discovery)        43K credits left
                technographics               enrichment_log

Cargo           Employment verification,     contacts (verification)     ~$0.50/workflow
                LinkedIn profiles, phones,   enrichment_log              TAPPED (0 credits)
                email finding

Claude API      Sub-market classification,   companies.sub_market        ~$0.01/call
                lead summaries, pitch        companies.lead_summary
                angles                       companies.pitch_angle

Apify           Website scraping fallback    companies (via waterfall)   Per-run pricing

HubSpot         Deals, meetings, lifecycle,  raw_signals (deal-sync)     API (free tier)
                owner changes                audit_hs_*_snapshot
```

---

## Standalone / Audit Tables

| Table | Rows | Purpose |
|-------|------|---------|
| `tam_list_staging` | 880 | RepB's TAM list review snapshot. No FKs. |
| `audit_parity_runs` | 5 | Weekly HubSpot↔Supabase audit summaries |
| `audit_hs_companies_snapshot` | 23,018 | Full HubSpot company snapshot for drift detection |
| `audit_hs_contacts_snapshot` | 3,798 | Full HubSpot contact snapshot for drift detection |
| `audit_dedup_groups` | 117 | Duplicate detection groups |
| `audit_archive_candidates` | 5,116 | Records flagged for archival |
| `audit_enrichment_gaps` | 865 | Missing enrichment flagged for fix |
| `audit_cleanup_actions_log` | 0 | Cleanup log (unused) |
| `enrichment_credits` | 4 | Daily credit rollup |
| `domain_blocklist` | 50 | Enterprise/internal domains to skip |
| `octave_results` | 852 | DEPRECATED — frozen data |
| `tam_cleanup_backup_2026_04_06` | 247 | Ad-hoc backup |
| `outbound_sequences` | 0 | Future LemList (not yet used) |
| `scheduled_runs` | 0 | Future scheduling (not yet used) |

---

## Cardinality Reality Check (Apr 22)

| Relationship | Expected | Actual | Gap |
|-------------|----------|--------|-----|
| Companies with >= 1 contact | Most | **1,252 of 2,312** (54%) | 1,060 empty (1,056 TAM) |
| Contacts with company_id | All | **1,950 of 1,978** (99%) | 27 orphans |
| Companies in HubSpot | All SLED + ICP >= 50 | ~500 of 2,312 | TAM not pushed |
| Contacts in HubSpot | All qualified SLED | **939 of 1,978** (47%) | TAM blocked |
| Enrichment log coverage | All enriched | 324 co (14%), 244 ct (12%) | Logging added mid-stream |
| Signals per raw_signal | 1:1 | 1,916 from 1,424 | Some raw → multiple scored |
| Push log failures | 0 | 145 failed pushes | 44 co create, 16 ct create, 59 deal_enrich, etc. |
