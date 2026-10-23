> **⚠️ ARCHIVED — superseded by [`docs/architecture.md`](docs/architecture.md) on 2026-04-20.**
>
> This file references Octave (removed 2026-04-15) and predates the HubSpot deal pipeline / SLED gate / Cargo-first rule. Kept for historical context only. Do not rely on it for current-state architecture.

---

# Signal Pipeline Architecture

Supabase (data) + Trigger.dev (orchestration) + Octave (enrichment/qualification) + HubSpot (CRM) + Slack (alerts).

---

## What This Replaces

| Killed | What it did | Why it dies |
|--------|------------|-------------|
| **Clay** (4 tables + workbook) | Enrichment, scoring, AI summaries, HubSpot push | Charging for orchestration. Dependency graph corruption. 38% dupe rate. |
| **growth-ops crons** (4 scripts) | Deal enrichment, contact refresh, PostHog sync, company-contact sync | Becomes Trigger.dev scheduled tasks |
| **Railway clay-refresh** | HTTP API for returning visitors | Supabase scheduled task |

**What stays:** HubSpot workflows (9 live), Syft (capture layer — repoint webhooks), PostHog (tracking).

---

## Data Flow (Current)

```
Syft website visitor ──────────┐
Syft LinkedIn activity ────────┤──→ syft-webhook task ──→ raw_signals
                               │
                               ▼
                         normalize task
                    (validate, blocklist, dedup)
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       enrich-company    enrich-contact    score-intent
       (new company)     (new contact)     (returning signal)
              │                │                │
              │          email waterfall         │
              │          (Findymail +            │
              │           LeadMagic)             │
              │                │                │
       Octave QUALIFY    ┌─────┘          intent scoring
       (async callback)  │               (5 components,
              │          │                0 API calls)
       discover-contact  │                     │
       (Octave PROSPECTOR)                     │
              │          │                     │
              └──────────┴─────────────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              HubSpot     Slack       Supabase
              push        alerts      (companies,
                                       contacts,
                                       signals)
```

---

## Task Pipeline (7 Trigger.dev tasks)

### syft-webhook
**Input:** Syft payload `{ account, lead, session?, linkedin? }`
**Output:** Insert into `raw_signals`, trigger normalize

Extracts ~40 fields from Syft webhook. Field names verified against actual payloads in `~/projects/acme-syft/payloads/`. Key gotchas:
- LinkedIn URLs at `lead.linkedin` (not `linkedinUrl`)
- Page views at `account.pageViews` (not in session)
- Visitor count at `account.visitors` (not `visitorCount`)
- ICP match at `account.icps` (array, joined to string)

### normalize
**Input:** `{ raw_signal_id }`
**Output:** Routes to enrich-company, enrich-contact, or score-intent

Validation gates:
1. Domain exists and is valid
2. `pageViews > 0` for website signals (LinkedIn skips this)
3. Not on enterprise blocklist (39 domains) or domain_blocklist table
4. Not an existing customer (HubSpot lifecycle check)
5. Dedup: no in-flight enrichment for same domain in last 10 min

### enrich-company
**Input:** `{ raw_signal_id, domain }`
**Output:** Company upserted in Supabase + pushed to HubSpot

11-step pipeline:
1. Octave QUALIFY_COMPANY (async callback — 3 credits, 10-30s)
2. Extract funding from `crunchBaseFunding[]` array
3. Sub-market classification (Claude Haiku — 19 categories)
4. Octave PROSPECTOR for decision makers (size-aware: CEO <30 emp, Sales/CRO 30+)
5. AI lead summary + sales org summary
6. ICP scoring: Octave score mapped to 0-125 + funding overlay (0-30 pts)
7. Gates: Octave score >= 5, not "Other B2B", US-based, < 500 employees
8. Upsert to `companies` table (onConflict: domain)
9. Push to HubSpot (20 properties)
10. Trigger discover-contact for qualified companies
11. Store audit trail in `octave_results`

### discover-contact
**Input:** `{ company_id, domain, employee_count }`
**Output:** Triggers enrich-contact for each discovered person

Fires Octave PROSPECTOR (async callback):
- `< 30 employees` → PROSPECTOR CEO agent (1 credit)
- `30+ employees` → PROSPECTOR Sales/CRO agent (2 credits)

### enrich-contact
**Input:** `{ raw_signal_id?, company_id, contact data }`
**Output:** Contact upserted in Supabase + pushed to HubSpot + Slack alert

Steps:
1. Email waterfall (5 steps: Findymail validate → Findymail find → LeadMagic validate → LeadMagic find → LeadMagic re-validate)
2. Phone lookup (LeadMagic, if has LinkedIn URL)
3. ICP score lookup from company
4. AI contact lead summary
5. Gates: email verified, title not blocked, ICP >= threshold
6. Upsert to `contacts` table (onConflict: email or linkedin_url)
7. Push to HubSpot (25 properties including attribution)
8. Slack alert for Hot leads → #growth

### score-intent
**Input:** `{ raw_signal_id }`
**Output:** Signal scored and inserted into `signals` table

5-component intent scoring (0-120, zero API calls):
- `purchase_intent_score` (0-20): Very High/High=20, Medium=10
- `engagement_depth_score` (0-25): pageViews>=3→15, sessions>=2→10, activeTime>=300→10, visitors>3→5
- `direct_action_score` (0-35): form/message/dm=35, comment=15, like/reaction=5
- `referral_source_score` (0-10): linkedin=10, paid/google=5
- `page_intent_score` (0-30): pricing/results/case-study=30, about/services=15

### octave-callback
**Input:** Octave POST `{ callbackUrl, data: { data: { ... } } }`
**Output:** Updates `octave_results` row from pending → completed

Double-nested `data.data` is the actual result. Callback fires 10-30s after agent request.

---

## Octave Integration

**CALLBACK-ONLY. No polling endpoint exists.**

```
enrich-company/discover-contact
    │
    ├─ POST /v2/async/agent/run (with callbackUrl)
    ├─ INSERT pending row in octave_results
    │
    │   ... 10-30s ...
    │
    ├─ octave-callback receives POST from Octave
    ├─ UPDATE octave_results: status=completed, output_payload=result
    │
    └─ waterfall.ts polls Supabase octave_results until completed
```

| Agent | ID | Credits | Used In |
|-------|-----|---------|---------|
| QUALIFY_COMPANY (SDR) | `ca_RpJ0919pHFMnKyHZ6zWNX` | 3 | enrich-company |
| QUALIFY_COMPANY (EdTech) | `ca_jDmrYV8ZaUQZPVOIRpeHB` | 2 | (future) |
| PROSPECTOR (CEO) | `ca_HCCAnbwMDjhm6VbDuoS2E` | 1 | discover-contact (<30 emp) |
| PROSPECTOR (Sales/CRO) | `ca_Niy1kPDwM60PcMpCiN32j` | 2 | discover-contact (30+ emp) |
| CALL_PREP (K12) | `ca_yDslZakjteTkqKE2mSltK` | 5 | Phase 3 |
| EMAIL (K12 SDR) | `ca_bJxgq0x642IAV6oXtRToo` | 9 | Phase 3 |
| EMAIL (PE GTM OS) | `ca_PWKBPzBAtjh41uGost0wf` | 9 | Phase 3 |

**Credit budget:** 475K/month. At ~5-6 cr per lead, supports ~80K leads/month. Current volume: ~50-100/week.

---

## Enrichment Providers

| Provider | Role | Phase |
|----------|------|-------|
| **Octave** | Company enrichment, qualification, funding, people search | 1 (built) |
| **Findymail** | Email discovery + validation | 1 (built) |
| **LeadMagic** | Email fallback + phone numbers | 1 (built) |
| **Starbridge** | Public sector buyer data, contracts, competitor presence | 5 (not built) |
| **Claude API** | Sub-market classification, lead summaries | 1 (built) |

---

## ICP Scoring (Dual Mode)

**Primary (Octave path):** Octave 1-10 score mapped to 0-125 via `mapOctaveToICP()` + funding overlay (0-30 pts from `scoreFunding()`).

**Fallback (formula path):** 4-component formula for non-Octave companies (CSV imports, backfill):
- Vertical fit: 0-35 (from sub_market)
- Headcount: 0-15 (from employee_count)
- Company stage: 0-30 (from annual_revenue)
- Sales team: 0-50 (from outbound_need_score)

Both paths produce the same `icp_score` (0-125) that maps to `lead_temp`:
- Hot: >= 100
- Warm: >= 60
- Cold: < 60

Funding scoring: Seed=15, Series A=30, Series B=25, Series C+=10, Bootstrap/None=5.

---

## HubSpot Compatibility

All 9 live workflows verified compatible (Mar 15). Property names, enum values, and filter conditions match Clay's current push.

**`lead_origin` = "Clay"** — hardcoded constant. 9 workflows filter on this. Change only at coordinated cutover.

**Exact enum values (MUST match):**
- `lead_temp`: "Hot", "Warm", "Cold" (capitalized)
- `lead_tier`: "Hot", "Warm", "Cool", "" (empty string for Cold)
- `signal_type`: "Company Intent", "LinkedIn Engagement", "Deal Created"

---

## Decisions Made (Mar 15)

| Decision | Answer |
|----------|--------|
| Octave score → ICP mapping | Map 1-10 to 0-125 scale. Linear interpolation + funding overlay. |
| Keep Claude AI summaries? | NO for companies (Octave rationale = lead_summary). YES for sub-market classification. |
| Funding scoring weight | 0-30 pts. Seed=15, A=30, B=25, C+=10, Bootstrap=5. |
| Octave async pattern | Callback-only. Fire → pending row → callback updates → waterfall polls Supabase. |
| `lead_origin` value | "Clay" until coordinated cutover. |

---

## What's Not Built Yet

### Phase 2 — Absorb Crons (required for cutover)
- `deal-sync` — hourly, pull new HubSpot deals, enrich companies, set lead_tier=Hot
- `contact-backfill` — hourly, find contacts missing icp_score, copy from company
- `stale-refresh` — hourly, re-score contacts with new signals
- `posthog-webhook` — PostHog $identify → upgrade signal_type
- `rep_c-digest` — weekly Mon 8am summary
- `pipe-health` — audit Supabase + Trigger.dev + HubSpot state

### Phase 3 — Outbound
- Octave EMAIL agent → personalized sequences
- LemList auto-enrollment
- RepA call prep (Octave CALL_PREP → HubSpot note)

### Phase 4 — Parallel Run + Cutover
- Dual webhooks (Clay + Signal Pipeline), comparison testing
- Repoint Syft → Trigger.dev only, kill Clay auto-run, kill crons

### Phase 5 — Starbridge + TAM + Dishwasher
- Starbridge API client (Auth0 JWT, buyer search, competitor presence)
- Starbridge signal poller (scheduled task, pull-based — no webhooks)
- HubSpot dishwasher (5K unscored companies through Octave QUALIFY)
- TAM map (cross-reference HubSpot + Starbridge + CSVs)
