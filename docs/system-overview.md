# Signal Pipeline — System Overview

> For onboarding new team members and GTME leadership. Covers what the system does, how scoring works, what TAM exists, and current state. Updated Apr 30, 2026.

---

## What GTMOS does

GTMOS (Growth-to-Market Operating System) is ACME's pipeline automation. It replaces Clay + manual ops with a Supabase + Trigger.dev stack. Three pipelines:

### 1. Inbound Signal Pipeline (Syft → HubSpot)
- **Source:** Syft tracks website visitors and LinkedIn engagement, identifies companies + contacts
- **Flow:** Syft webhook/poll → normalize → score intent → enrich company → find decision maker → enrich contact → push to HubSpot → Slack MQL alert
- **Runs:** Continuously (webhook) + 30min poll
- **Output:** Scored, enriched contacts in HubSpot with Slack alerts for MQLs

### 2. HubSpot Deal Pipeline
- **Source:** Hourly poll of new HubSpot deals
- **Flow:** New deal → find associated contacts → enrich via Cargo → backfill LinkedIn/phone/email
- **Purpose:** Every deal contact must have LinkedIn URL + phone for RepC's plays
- **Runs:** Hourly cron

### 3. TAM Batch Pipeline
- **Source:** AE-driven target account lists
- **Flow:** `tam-enrich` (company enrichment + scoring) → `tam-activate` (contact discovery + HubSpot push)
- **Runs:** Manual trigger only (not on a cron)
- **Purpose:** Outbound target lists — ICP-scored companies with decision maker contacts

---

## How scoring works

### ICP Score (0–100) — "Is this company a fit?"
All local math, zero API calls. Components:
- **Sub-market fit (0–40):** K12 EdTech SaaS = 40, Higher Ed = 30, Government = 25, Corporate L&D = 15, everything else = 0
- **Employee count (0–25):** Sweet spot 11–200. Under 10 or over 500 = low score
- **Sales team composition (0–20):** Has AEs but no SDRs = high. Already has SDR team = low. Founder selling = medium
- **Funding stage (0–15):** Series A/B = high. Pre-seed = low. Public = 0

### Intent Score (0–120) — "Are they showing buying behavior?"
Scored on every Syft signal. Five components:
- **Purchase intent (0–20):** Syft's purchase intent classification
- **Engagement depth (0–25):** Page views, sessions, time on site
- **Direct action (0–35):** LinkedIn form submit = 35, comment = 15, like = 5
- **Referral source (0–10):** LinkedIn = 10, direct/organic = 5
- **Page intent (0–30):** /pricing = 30, /services = 15, homepage = 5

### Total Score = ICP + Intent
| Tier | Score | Meaning |
|------|-------|---------|
| Hot  | 100+  | High fit + active intent |
| Warm | 60–99 | Decent fit or moderate intent |
| Cool | 30–59 | Low fit or weak intent |
| Cold | <30   | Not a fit or no signal |

### MQL Qualification (as of v20260430.2)
A contact becomes an MQL when ALL of these are true:
1. **Inbound** — signal-driven (Syft website/LinkedIn), not outbound TAM
2. **Hot or Warm** tier (total score ≥ 60)
3. **Buyer title** — CEO, Founder, CRO, VP Sales, Head of Sales, Director of Sales, President, Managing Director, General Manager (allowlist, not blocklist)
4. **SLED sub-market** — K12 EdTech SaaS, Higher Ed, or Government & Public Sector
5. **Intent > 0** — must have actual engagement, not just ICP fit

MQL triggers: Slack alert to AE (@RepA for K12, @RepB for Higher Ed/Gov), HubSpot lifecycle = MQL, LemList enrollment (if enabled).

---

## Sub-market classifier

GTMOS classifies every company into a sub-market using Claude API. The classifier answers: **"Who does this company sell to?"** — not "What is this company?"

A `.edu` domain (university) = "Not SLED" because the university is an institution, not a vendor selling to education.

**SLED categories (pipeline active):**
- K12 EdTech SaaS → RepA's territory
- Higher Ed → RepB's territory
- Government & Public Sector → RepB's territory

**Non-SLED (filtered out at gates):**
- Not SLED, B2B SaaS, Professional Services, Consumer/B2C, Financial Services, etc.
- These companies get scored and stored but don't push to HubSpot or fire alerts

---

## Enrichment providers

| Provider | Role | What it provides |
|----------|------|-----------------|
| **Cargo** (primary) | People enrichment | LinkedIn URL, employment verification, email, phone. Uses LinkedIn/Sales Nav data. ~75% accurate on URL-based verification |
| **LeadMagic** (fallback) | Company enrichment + people fallback | Company data (employee count, industry, revenue, funding). Employee finder (~67% accurate, ~33% departed contacts). Used when Cargo returns 0 |
| **Claude API** | Classification + summaries | Sub-market classification, sales team analysis, lead summary narratives for AE call briefs |

**Credit economics:** Cargo Find Stakeholders = 6.5 credits per domain. LeadMagic employee finder = 1.5 credits. Claude API = ~$0.01-0.03 per call. Discovery runs are gated to avoid burning credits on companies with no sales org.

---

## TAM mapping — current state

### RepB Higher Ed TAM
- **Source:** Shane manually curated from industry knowledge + Syft signal history + Sales Nav research
- **Process:** Company list → `tam-enrich` (ICP scoring + sales team analysis) → `coalesce-rep_b-final.mts` (buyer title filtering + dedup) → Google Sheets delivery → RepB review
- **State:** 173 companies, 223 contacts pushed to HubSpot (Apr 22). `lead_type: outbound`, `owner: RepB`, `lifecycle: lead`. Full enrichment (lead_summary, sales_org_summary, ICP scores)
- **Google Sheet:** "RepB Outbound List V1 - Higher Ed" (live, service account shared)
- **Pending:** RepB review stalled (concussion). HubSpot push complete but RepB hasn't started working the list

### RepA K12 TAM
- **Source:** Not yet built. Planned as next TAM list after RepB's
- **State:** RepA has existing K12 contacts in HubSpot from Clay era. Full audit needed before building new list (152 zero-intent TAM contacts already removed Apr 22)
- **Blocked on:** RepA K12 HubSpot audit (reconcile Clay-era contacts vs GTMOS)

### How TAM lists are sourced
1. **Signal history** — companies that visited acmegtm.com or engaged on LinkedIn (Syft data). Proves market awareness
2. **Industry research** — Shane identifies companies selling to K12/Higher Ed/Gov (EdTech conferences, competitor analysis, LinkedIn searches)
3. **Sales Nav** — RepB/RepA identify companies through their network
4. **Referrals** — Starbridge re-introductions, partner leads

TAM lists are NOT auto-generated by the pipeline. They're manually curated, then enriched and scored by GTMOS.

---

## Current system state (Apr 30, 2026)

### What's running
| Component | Schedule | What it does |
|-----------|----------|--------------|
| Syft inbound pipeline | Webhook + 30min poll | Signal → enrich → score → HubSpot + Slack |
| HubSpot deal enrichment | Hourly cron | New deals → contact enrichment |
| Contact backfill | Hourly cron | Fill gaps on existing contacts |
| Deal sync | Hourly cron | Sync deal data |
| UTM backfill | Every 6h | Attribution data |
| Parity audit | Weekly (Sun 10am) | Supabase ↔ HubSpot consistency check |

### What's NOT running
| Component | Why |
|-----------|-----|
| TAM batch | Manual trigger only — no cron |
| Fibbler sync | Cron disabled Apr 21. Not running LinkedIn ads. Fibbler was overwriting real attribution |
| Pipe-health Slack | Logs only. Shane's preference — MQL alerts + rep_c-digest are live |
| Company/contact/deal refresh | Stubbed since Octave removal. Cargo verification covers departures |

### Volume (last 30 days)
- **~2,000 signals** processed
- **1,000 companies** in database (392 SLED)
- **1,889 contacts** (976 in HubSpot)
- **~100 MQLs** (needs cleanup — 66 are non-SLED from before the gate fix)
- **1,535 successful HubSpot pushes**, 111 gate rejections

### Deployed version
`v20260430.2` — MQL buyer title allowlist + SLED gate + discovery cooldown + sales org data fix.

---

## What a GTME needs to know

### If you're building TAM lists
- GTMOS enriches and scores them, it doesn't source them. You bring the company list, GTMOS tells you ICP score, sales org composition, sub-market, and finds decision makers
- Use `tam-enrich` → `tam-activate` flow. Manual trigger, not automated
- Buyer title allowlist matters: only CEO/Founder/VP Sales/CRO/Director Sales get MQL'd from inbound signals. TAM contacts get `lead_type: outbound` and bypass MQL workflows entirely
- Territory: K12 → RepA (HubSpot owner 162280197), Higher Ed + Gov → RepB (163458119)

### If you're adjusting scoring
- All scoring is local math in `src/scoring/`. Zero API calls. Changes deploy instantly
- Sub-market weights are in `src/scoring/tam-icp.ts`
- Intent scoring is in `src/scoring/intent.ts`
- MQL gate is in `src/lib/gates.ts` → `isMql()` function
- **Run `npx tsx scripts/smoke-test-mql-gate.mts` before deploying any scoring changes** — it proves the gate against real data

### If you're looking at HubSpot
- GTMOS owns MQL lifecycle upstream. All 17 HubSpot workflows are OFF
- Properties GTMOS writes: `lead_tier`, `lead_temp`, `total_score`, `icp_score`, `intent_score`, `lead_summary`, `sales_org_summary`, `sub_market`, `signal_type`, `lead_origin`, `lead_type`
- Ground truth for HubSpot state: `docs/hubspot-schema/` (version-controlled, regenerate with `npm run audit:hubspot-schema`)

### Known gaps
- `acmegtm.com` missing HubSpot tracking pixel — marketing-ops fix
- 66 stale `is_mql=true` contacts in Supabase from before the title gate fix (won't fire alerts, but data is wrong)
- Contact discovery uses regex title matching — fails for companies where the buyer has a non-standard title (Carnegie incident). Claude-powered buyer identification is the planned fix
- RepA K12 HubSpot audit still pending

---

## Key files

| File | What it is |
|------|-----------|
| `src/triggers/normalize.ts` | Entry point — validates, dedupes, routes signals |
| `src/triggers/enrich-company.ts` | Company enrichment + ICP scoring + sub-market classification |
| `src/triggers/enrich-contact.ts` | Contact enrichment + MQL determination + HubSpot push + Slack alert |
| `src/triggers/discover-contact.ts` | Find decision makers at a company (Cargo + LeadMagic) |
| `src/lib/gates.ts` | All gates — push gates, MQL gate, discovery gate, title blocklist/allowlist |
| `src/scoring/intent.ts` | Intent scoring formulas |
| `src/scoring/tam-icp.ts` | ICP scoring formulas |
| `src/lib/constants.ts` | Territory routing, lead type derivation |
| `src/lib/slack.ts` | Slack alert formatting |
| `src/lib/summaries.ts` | Claude-generated lead summaries |
| `scripts/smoke-test-mql-gate.mts` | Verify MQL gate against real data before deploy |
