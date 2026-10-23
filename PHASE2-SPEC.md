# Phase 2 Spec — Absorb Crons + Live Inputs

Replaces 5 Python scripts in `Acme GTM/growth-ops` with Trigger.dev tasks + Supabase.

---

## Decision: What Runs Where

| Task | Runtime | Why |
|------|---------|-----|
| **deal-sync** | Trigger.dev scheduled task (every 1h) | Needs HubSpot API + Supabase + enrich-company pipeline. Trigger.dev has native schedules + retries. |
| **contact-backfill** | Trigger.dev scheduled task (every 1h) | Pure HubSpot + Supabase. Light. Could be Supabase pg_cron + edge function, but keeping all orchestration in Trigger.dev for single deployment. |
| **stale-refresh** | Trigger.dev scheduled task (every 1h) | Re-scores + re-pushes. Needs existing enrich-contact/score-intent tasks. |
| **posthog-identify** | **Trigger.dev webhook task (real-time)** | PostHog supports webhooks via Actions. NO MORE POLLING. Syft is real-time, PostHog should be too. |
| **mql-summary-backfill** | Trigger.dev one-shot task (manual trigger) | Orphaned MQL contacts with stale summaries. Run once, then the pipe handles it. Not recurring. |

**PostHog decision:** PostHog Actions can POST a webhook on any event. Set up an Action on `$identify` event → POST to Trigger.dev HTTP endpoint. Kills the cron entirely. Living, breathing — same as Syft.

---

## Schema Changes Required

Add to `supabase/migrations/004_phase2.sql`:

```sql
-- Stale refresh tracking (contacts table)
ALTER TABLE contacts ADD COLUMN last_refreshed_at timestamptz;

-- Deal tracking (companies table)
ALTER TABLE companies ADD COLUMN hubspot_deal_id text;
ALTER TABLE companies ADD COLUMN deal_created_at timestamptz;

-- Index for stale detection query
CREATE INDEX idx_contacts_stale
  ON contacts(last_signal_date DESC)
  WHERE needs_refresh = true AND last_refreshed_at IS NULL
     OR last_signal_date > last_refreshed_at;
```

---

## Task 1: deal-sync

**Replaces:** `deal-enrichment-trigger.py` (hourly + daily 6am full sweep)
**File:** `src/triggers/deal-sync.ts`
**Schedule:** Every 1 hour via Trigger.dev `schedules.task()`

### What It Does (Current Script)

1. Search HubSpot for deals created in last 2 hours (or all open deals on daily sweep)
2. For each deal: get associated company domain + contact email
3. Skip if domain is on blocklist
4. PATCH company in HubSpot: `lead_tier=Hot`
5. PATCH contact in HubSpot: `lead_tier=Hot`, `lead_origin=meeting_booked`, backfill `icp_score` + `sub_market` from company
6. POST to Clay webhook intake (if company has no icp_score, or contact has no email verified)

### Signal Pipeline Replacement

```
Trigger.dev schedule (hourly)
│
├─ HubSpot search: deals created in last 2h
│  Properties: dealname, dealstage, pipeline, createdate, amount
│  Filter: NOT closed_lost, NOT closed_won
│
├─ For each deal:
│   ├─ GET associated company (v4 associations)
│   │  Properties: domain, name, icp_score, lead_tier, sub_market,
│   │             lead_summary, numberofemployees, industry
│   │
│   ├─ GET associated contact (v4 associations)
│   │  Properties: email, firstname, lastname, jobtitle, lead_tier,
│   │             lead_origin, icp_score, sub_market
│   │
│   ├─ Skip if domain blocked (Supabase domain_blocklist lookup)
│   │
│   ├─ ALWAYS: PATCH company in HubSpot
│   │  lead_tier = "Hot"
│   │
│   ├─ ALWAYS: PATCH contact in HubSpot
│   │  lead_tier = "Hot"
│   │  lead_origin = LEAD_ORIGIN (still "Clay")
│   │  Backfill from company if contact is missing:
│   │    icp_score, sub_market, lead_summary
│   │
│   ├─ IF company has NO icp_score in HubSpot:
│   │  → Check Supabase companies table by domain
│   │  → If not in Supabase: trigger enrich-company task
│   │    (reuse existing pipeline — Octave QUALIFY, scoring, etc.)
│   │  → If in Supabase but not pushed: push to HubSpot
│   │
│   └─ IF contact has no email OR no icp_score:
│      → Check Supabase contacts by email
│      → If not in Supabase: trigger enrich-contact task
│      → If in Supabase but not pushed: push to HubSpot
│
└─ Log to scheduled_runs table
   { task_name: "deal-sync", records_processed, records_created, records_updated }
```

### Reads

| Source | What | How |
|--------|------|-----|
| HubSpot | Deals (last 2h), associated companies + contacts | Search API + Associations v4 |
| Supabase | `domain_blocklist`, `companies` (by domain), `contacts` (by email) | SELECT |

### Writes

| Destination | What | How |
|-------------|------|-----|
| HubSpot | Company `lead_tier=Hot` | PATCH company |
| HubSpot | Contact `lead_tier=Hot` + backfill | PATCH contact |
| Supabase | `scheduled_runs` row | INSERT |
| Trigger.dev | `enrich-company` task (if unscored) | `.trigger()` |
| Trigger.dev | `enrich-contact` task (if no contact) | `.trigger()` |

### Env Vars

`HUBSPOT_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

### Key Difference from Current Script

Current script POSTs to Clay webhook. Signal Pipeline triggers enrich-company directly — same pipe, no Clay middleman. The `signal_source` for deal-originated enrichments = `hubspot_deal_created`.

---

## Task 2: contact-backfill

**Replaces:** `company-contact-sync.py` (hourly @ :30)
**File:** `src/triggers/contact-backfill.ts`
**Schedule:** Every 1 hour via Trigger.dev `schedules.task()`

### What It Does (Current Script)

1. Search HubSpot for contacts where `(lead_tier=Hot OR lifecyclestage=opportunity) AND icp_score IS EMPTY`
2. For each: get associated company
3. If company has `icp_score`, `sub_market`, or `lead_summary` that contact lacks → PATCH contact

### Signal Pipeline Replacement

```
Trigger.dev schedule (hourly)
│
├─ Supabase query:
│  SELECT contacts.* FROM contacts
│  JOIN companies ON contacts.company_id = companies.id
│  WHERE contacts.icp_score = 0
│    AND companies.icp_score > 0
│
├─ For each contact missing data:
│   ├─ Copy from company: icp_score, sub_market, lead_summary,
│   │  sales_org_summary, city, state
│   │
│   ├─ Recalculate tier: computeTier(icp_score + intent_score)
│   │
│   ├─ UPDATE Supabase contacts row
│   │
│   └─ IF contact has hubspot_contact_id:
│      PATCH HubSpot contact with same fields
│
└─ Log to scheduled_runs table
```

### Why Supabase-First

Current script queries HubSpot directly. Signal Pipeline has all the data in Supabase already — companies and contacts are both upserted during enrichment. Query Supabase (fast, free, no rate limits), then push deltas to HubSpot.

### Reads

| Source | What |
|--------|------|
| Supabase | `contacts` joined to `companies` WHERE icp_score mismatch |

### Writes

| Destination | What |
|-------------|------|
| Supabase | `contacts` rows (icp_score, sub_market, lead_summary, tier) |
| HubSpot | Contact PATCH (only if has hubspot_contact_id) |
| Supabase | `scheduled_runs` row |

---

## Task 3: stale-refresh

**Replaces:** `refresh-contacts.py` (hourly @ :30) + Railway `clay-refresh` service
**File:** `src/triggers/stale-refresh.ts`
**Schedule:** Every 1 hour via Trigger.dev `schedules.task()`

### What It Does (Current Script)

1. List all Contact Profiles rows in Clay
2. Filter where `Needs Refresh = true` (formula: Last Signal Date > Refresh Trigger timestamp)
3. For each stale contact: re-run Intent Lookup enrichment (forceRun=true)
4. This cascades: Intent Lookup → recalculates scores → updates Lead Summary → re-pushes to HubSpot
5. Stamp Refresh Trigger field to clear the stale flag

### Signal Pipeline Replacement

```
Trigger.dev schedule (hourly)
│
├─ Supabase query:
│  SELECT * FROM contacts
│  WHERE needs_refresh = true
│    AND (last_refreshed_at IS NULL OR last_signal_date > last_refreshed_at)
│  ORDER BY last_signal_date DESC
│  LIMIT 100  -- batch cap per run
│
├─ For each stale contact:
│   │
│   ├─ Re-score intent:
│   │  Get latest signal for this domain from signals table
│   │  Recalculate: intent_score = max(all signals for domain)
│   │
│   ├─ Re-lookup company ICP:
│   │  Get company by domain → icp_score
│   │  (company may have been re-scored since contact was created)
│   │
│   ├─ Recalculate total + tier:
│   │  total_score = icp_score + intent_score
│   │  tier = computeTier(total_score)
│   │
│   ├─ UPDATE Supabase contacts:
│   │  icp_score, intent_score, tier,
│   │  needs_refresh = false,
│   │  last_refreshed_at = now()
│   │
│   ├─ IF tier changed AND has hubspot_contact_id:
│   │  PATCH HubSpot contact:
│   │    intent_score, icp_score, total_score, lead_tier, lead_temp
│   │
│   └─ IF tier upgraded to Hot:
│      Slack alert → #growth
│
└─ Log to scheduled_runs table
```

### What stale-refresh Does NOT Do

- **Does NOT re-run email waterfall.** Email doesn't change. Too expensive to re-run.
- **Does NOT re-run Octave.** Company qualification doesn't change on a returning visit.
- **Does NOT regenerate lead_summary.** Summary is from Octave rationale — stable.

It ONLY re-scores intent (from new signals) and re-pushes if tier changed. This is what the Clay version does too — Intent Lookup is a formula recalculation, not a re-enrichment.

### Staleness Detection

Current Clay: formula compares `Last Signal Date > Refresh Trigger` timestamp.

Signal Pipeline: `score-intent.ts` already sets `needs_refresh = true` and `last_signal_date = now()` on the contact when a new signal arrives (line 139). stale-refresh clears it by setting `needs_refresh = false` and `last_refreshed_at = now()`.

### Reads

| Source | What |
|--------|------|
| Supabase | `contacts` WHERE needs_refresh = true |
| Supabase | `signals` (max intent for domain) |
| Supabase | `companies` (current icp_score) |

### Writes

| Destination | What |
|-------------|------|
| Supabase | `contacts` (scores, tier, needs_refresh, last_refreshed_at) |
| HubSpot | Contact PATCH (only if tier changed + has hubspot_contact_id) |
| Slack | Hot lead alert (only if tier upgraded to hot) |
| Supabase | `scheduled_runs` row |

---

## Task 4: posthog-identify (WEBHOOK — not cron)

**Replaces:** `posthog-signal-upgrade.py` (hourly @ :45)
**File:** `src/triggers/posthog-identify.ts`
**Runtime:** Trigger.dev webhook task (real-time HTTP endpoint)

### Why Webhook, Not Cron

Syft sends webhooks → we process in real-time. PostHog should work the same way. PostHog Actions support "Send webhook" on any event. Configure:

```
PostHog → Settings → Actions → New Action
  Name: "GTMOS Identify Webhook"
  Match: event name = "$identify"
  Action: Send webhook to POST {TRIGGER_DEV_URL}/posthog/identify
```

This kills the hourly polling cron. Identity resolution happens in seconds, not up to 60 minutes later.

### What It Does (Current Script)

1. Query PostHog for `$identify` events in last 2h
2. Extract email from `distinct_id` or `$set.email`
3. Find matching HubSpot contact
4. If `signal_type = "Company Intent"` → upgrade to `"Identified Visitor"`
5. Optionally backfill UTM data from PostHog session

### Signal Pipeline Replacement

```
Trigger.dev webhook endpoint: POST /posthog/identify
│
├─ Extract from PostHog webhook payload:
│  email = event.distinct_id OR event.properties.$set.email
│  Skip if no valid email (contains @, not "anonymous")
│
├─ Supabase: lookup contact by email
│  SELECT id, signal_type, hubspot_contact_id, tier
│  FROM contacts WHERE email = {email}
│
├─ IF contact exists AND signal_type = "Company Intent":
│   │
│   ├─ UPDATE Supabase contacts:
│   │  signal_type = "Identified Visitor"
│   │
│   └─ IF has hubspot_contact_id:
│      PATCH HubSpot contact:
│        signal_type = "Identified Visitor"
│
├─ IF contact does NOT exist:
│   │
│   ├─ Try to find domain from PostHog person properties
│   │  (PostHog $identify includes $current_url → extract domain)
│   │
│   └─ Insert raw_signal with source = "posthog_identify"
│      → triggers normalize → enrichment pipeline
│      (this is the "living, breathing" part — new PostHog
│       identities enter the same pipe as Syft signals)
│
└─ Log to push_log (signal_type upgrade)
```

### PostHog Webhook Payload

PostHog Actions send this structure:
```json
{
  "event": "$identify",
  "distinct_id": "user@company.com",
  "properties": {
    "$set": { "email": "user@company.com", "name": "..." },
    "$current_url": "https://acmegtm.com/pricing",
    "$referrer": "https://linkedin.com/...",
    "utm_source": "linkedin",
    "utm_medium": "paid",
    "utm_campaign": "k12-q1"
  },
  "timestamp": "2026-03-15T..."
}
```

### Reads

| Source | What |
|--------|------|
| PostHog (webhook payload) | email, UTM data, current URL |
| Supabase | `contacts` by email |

### Writes

| Destination | What |
|-------------|------|
| Supabase | `contacts.signal_type` upgrade |
| HubSpot | Contact PATCH signal_type (if has hubspot_contact_id) |
| Supabase | `raw_signals` INSERT (if new contact → enters pipe) |

### Env Vars

None new. Uses existing `SUPABASE_*` + `HUBSPOT_API_KEY`. PostHog webhook is inbound — no PostHog API key needed.

**Kill:** `POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID` env vars. No longer polling.

---

## Task 5: mql-summary-backfill (ONE-SHOT)

**Replaces:** `refresh-mql-summaries.py` (manual)
**File:** `src/triggers/mql-summary-backfill.ts`
**Runtime:** Trigger.dev task (manual trigger only — not scheduled)

### What It Does

Orphaned MQL contacts in HubSpot that have old-format or missing `lead_summary`. These contacts went through HubSpot workflows but never through the enrichment pipe.

### Signal Pipeline Replacement

```
Manual trigger (run once after cutover, then as-needed)
│
├─ HubSpot search:
│  lifecyclestage = marketingqualifiedlead
│  AND hs_lead_status != UNQUALIFIED
│  Properties: email, firstname, lastname, jobtitle, company,
│              lead_summary, icp_score, sub_market
│
├─ Filter: contacts where lead_summary is empty
│  OR lead_summary contains old-format markers
│  ("key decision-maker", "key contact for", "partnership opportunities")
│
├─ For each:
│   ├─ GET associated company from HubSpot
│   │  Properties: name, description, numberofemployees,
│   │             icp_score, sub_market, sales_org_summary, city, state
│   │
│   ├─ Check Supabase companies table (may have Octave data)
│   │  If Supabase has richer data → use Octave rationale
│   │
│   ├─ Build lead_summary:
│   │  "{name} ({title}) at {company}. {octave_rationale OR company_description}"
│   │  (Same pattern as enrich-contact line 176 — no Claude call)
│   │
│   └─ PATCH HubSpot contact: lead_summary
│
└─ Log to scheduled_runs table
```

### Why No Claude

Current script uses Claude Sonnet to generate summaries. Signal Pipeline builds summaries from Octave rationale (already on the company row). For companies not in Supabase, fall back to HubSpot company description. Good enough for MQL contacts — they're already in the funnel.

---

## Task 6: pipe-health (NEW)

**File:** `src/triggers/pipe-health.ts`
**Schedule:** Every 6 hours via Trigger.dev `schedules.task()`

No current equivalent. Replaces manual monitoring.

```
Trigger.dev schedule (every 6h)
│
├─ Check 1: Supabase raw_signals stuck in "enriching"
│  SELECT count(*) FROM raw_signals
│  WHERE status = 'enriching' AND created_at < now() - interval '1 hour'
│  → If > 0: Slack alert "N signals stuck in enriching"
│
├─ Check 2: Octave callbacks not arriving
│  SELECT count(*) FROM octave_results
│  WHERE status = 'pending' AND created_at < now() - interval '30 minutes'
│  → If > 0: Slack alert "N Octave callbacks pending > 30min"
│
├─ Check 3: HubSpot push failures
│  SELECT count(*) FROM push_log
│  WHERE success = false AND created_at > now() - interval '6 hours'
│  → If > 5: Slack alert "N HubSpot push failures in last 6h"
│
├─ Check 4: Volume sanity
│  SELECT count(*) FROM raw_signals
│  WHERE created_at > now() - interval '24 hours'
│  → If 0: Slack alert "Zero signals in 24h — Syft webhook may be down"
│  → If > 500: Slack alert "Unusual volume: N signals in 24h"
│
├─ Check 5: Stale contacts piling up
│  SELECT count(*) FROM contacts WHERE needs_refresh = true
│  → If > 50: Slack alert "N contacts need refresh — stale-refresh may be failing"
│
└─ Log to scheduled_runs table
```

### Writes

| Destination | What |
|-------------|------|
| Slack (#growth-ops) | Alert if any check fails |
| Supabase | `scheduled_runs` row |

---

## Task 7: rep_c-digest (NEW)

**File:** `src/triggers/rep_c-digest.ts`
**Schedule:** Weekly, Monday 8am ET via Trigger.dev `schedules.task()`

```
Trigger.dev schedule (weekly Mon 8am ET)
│
├─ Supabase queries (last 7 days):
│  - New companies enriched (count + top 5 by icp_score)
│  - New contacts pushed to HubSpot (count)
│  - Hot leads generated (count + names)
│  - Signals processed (count by source)
│  - HubSpot push success rate
│  - Octave credits used (sum from octave_results)
│
├─ Format Slack message:
│  "📊 Weekly Pipe Digest (Mar 10-17)
│   Companies enriched: 23 (top: exampleco.com 98, newsela.com 87...)
│   Contacts pushed: 41
│   Hot leads: 3 (Shane @ exampleco, ...)
│   Signals: 156 (website: 134, linkedin: 22)
│   HubSpot push: 98% success
│   Octave credits: 127 (of 475K budget)"
│
└─ POST to Slack #growth
```

---

## Blocklist Migration

Current: `growth-ops/blocklist.json` (50 domains across 4 categories).
Signal Pipeline: `domain_blocklist` table in Supabase.

**Action:** Add `supabase/seed/blocklist.sql` with INSERT for all 50 domains from blocklist.json. Run once during Supabase project setup.

The `normalize.ts` task already checks `isDomainBlocked()` against this table (line 70). The current seed data just needs to be populated.

---

## Build Order

| # | Task | Deps | Effort |
|---|------|------|--------|
| 1 | `004_phase2.sql` migration | None | 10 min |
| 2 | `blocklist.sql` seed | Supabase project | 15 min |
| 3 | `contact-backfill.ts` | Supabase + HubSpot | Small — pure data sync |
| 4 | `stale-refresh.ts` | Supabase + HubSpot | Small — re-score + push |
| 5 | `deal-sync.ts` | Supabase + HubSpot + enrich-company | Medium — reuses existing pipeline |
| 6 | `posthog-identify.ts` | Supabase + HubSpot | Small — webhook handler |
| 7 | `pipe-health.ts` | Supabase + Slack | Small — queries + alerts |
| 8 | `rep_c-digest.ts` | Supabase + Slack | Small — queries + formatting |
| 9 | `mql-summary-backfill.ts` | HubSpot + Supabase | Small — one-shot |
| 10 | PostHog Action config | PostHog admin | 5 min — UI config |

Tasks 3-4 are pure Supabase → HubSpot sync. Build first, test offline.
Task 5 reuses enrich-company pipeline. Build after core pipe is deployed.
Task 6 is the only new real-time input. Build + test with PostHog Action.
Tasks 7-9 are monitoring/reporting. Build last.

---

## What Dies at Cutover

| Kill | Why |
|------|-----|
| `deal-enrichment-trigger.py` | Replaced by deal-sync task |
| `refresh-contacts.py` | Replaced by stale-refresh task |
| `company-contact-sync.py` | Replaced by contact-backfill task |
| `posthog-signal-upgrade.py` | Replaced by posthog-identify webhook |
| `refresh-mql-summaries.py` | Replaced by mql-summary-backfill task |
| GitHub Actions workflows (4) | All replaced by Trigger.dev schedules |
| `CLAY_SESSION_COOKIE` secret | No more Clay API calls |
| `POSTHOG_API_KEY` env var | Webhook inbound, no polling |
| Railway clay-refresh service | stale-refresh handles this |
