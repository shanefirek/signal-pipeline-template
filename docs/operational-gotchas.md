# V2 Operational Gotchas

> **Read this before touching the pipeline.** Every item below is a bug that took hours (or weeks) to find. Fix or work around — don't re-discover.

Last updated: April 8, 2026

---

## Table of contents

1. [Syft webhook ingestion](#syft-webhook-ingestion)
2. [Supabase schema quirks](#supabase-schema-quirks)
3. [HubSpot push layer](#hubspot-push-layer)
4. [External API gotchas](#external-api-gotchas)
5. [Scripts and backfills](#scripts-and-backfills)
6. [Scoring and gates](#scoring-and-gates)

---

## Syft webhook ingestion

### Two distinct webhook payload shapes

Syft sends **two entirely different payload shapes** to our webhook, and `src/triggers/syft-webhook.ts` must handle both.

**Shape A — "LinkedIn Activity" webhook**
```json
{
  "account":  { "domain", "name", "lastSeen", "syft_latest_utm_channel", ... },
  "lead":     { "firstName", "lastName", "linkedin", "title", ... },
  "session":  { "start_time", "pages_visited", ... },       // optional
  "linkedin": { "action": "Profile View", "timestamp" }     // explicit action field
}
```
Fires on direct LinkedIn engagement events (Profile View, Connection Request, New Follower, Sent Message, etc). Human-readable `linkedin.action` string.

**Shape A variant** — some Shape A payloads send `visitor` instead of `lead`:
```json
{
  "account":  {...},
  "visitor":  {...},  // same shape as lead
  "linkedin": {...}
}
```
The syft-webhook extractor checks for `lead` first, then `visitor`. Both resolve to the same extracted fields.

**Shape B — "Lead Identified" webhook**
```json
{
  "id", "domain", "name",
  "contacts":  [{ "properties": { "fullName", "title", "linkedin", "employments" }, ... }],
  "vendorProps": { "cb": { "tech", "raised", "fundingEvents", "description" } },
  "matchedICPs": [...],
  "matchedIPersonaDetails": [...],
  "lastSeenVisitorDetail": { "lastActionType": "linkedin_new_follower" },
  "firstTouchSource", "touchChannels", "suggestedLeads"
}
```
Fires with Syft's pre-enriched lead record. Action lives in `lastSeenVisitorDetail.lastActionType` in snake_case form. Contact is under `contacts[0].properties`. Company is at the top level.

**Detection rule:** `!data.linkedin && Array.isArray(data.contacts)` → Shape B, else Shape A.

**Action mapping:** Shape B ships snake_case like `linkedin_new_follower` / `linkedin_profile_view`. `humanizeShapeBAction()` in `syft-webhook.ts` maps these to Shape A's title-case format so downstream scoring (`scoreDirectAction`) recognizes them.

**Impact when broken:** Apr 8 2026 — 18+ Shape B events from Mar 23 to Apr 8 dropped silently because the extractor only knew Shape A. Lost including Phil Tallman (VP Partnerships @ Mantra Health — active deal) following RepC Mar 31.

### Float coercion required

Syft sends **floats for integer-typed columns**. Every integer field in the extractor must be wrapped in `Math.round()`:
- `timeSpent` (e.g. 9.5 = 9:30 min)
- `pageViews`
- `sessions`
- `visitors`
- `highIntentSessions`

Without rounding, Postgres rejects the insert with `22P02: invalid input syntax for type integer: "9.5"` and the entire raw_signal fails to land.

Apr 8 2026: Yoseph Tesfaye's LinkedIn post view on acmegtm.com caused 3 consecutive syft-webhook failures (9 retries total) until we added `Math.round()` on all integer-typed fields.

### Duplicate webhook dedup via `last_seen`

Syft fires **2-3 webhooks per event** (different `creationTrigger` values, same underlying action) within **16-200ms** of each other. This is expected behavior — each webhook has a different payload shape, not different data.

**Dedup mechanism:** partial unique index `raw_signals_syft_dedup_idx` on `(domain, source, last_seen) WHERE last_seen IS NOT NULL AND source IN ('syft_website', 'syft_linkedin')`.

The dedup key is `last_seen`. Syft sends the same `account.lastSeen` value on every webhook describing the same event.

**Critical: `last_seen` fallback chain.** Not every Syft payload has `account.lastSeen`. The extractor falls through:
```
account.lastSeen
  → account.syft_last_seen
  → lead.lastSeen
  → lead.syft_last_seen
  → linkedin.timestamp       (always present on Shape A linkedin events)
  → session.end_time
  → session.start_time
  → null
```

If `last_seen` is null, the partial index doesn't cover the row and duplicates CAN slip through.

**App-level time-window dedup does NOT work for this.** Syft's webhooks arrive within ~100ms, both queries run before either has inserted, neither sees the other, both insert. The DB-level unique constraint is the only reliable answer.

**Conflict handling:** `syft-webhook.ts` catches Postgres `23505` (unique violation) and merges lead identity fields (`contact_name`, `email`, `linkedin_url`, `title`, `first_name`, `last_name`) from the conflicting payload into the existing row. The in-flight normalize run picks up the merged data.

### Every `raw_signals` insert must set `source` AND `lead_source`

This is the most painful silent-failure pattern in the codebase.

`gates.ts::passesValidationGate` and `gates.ts::isNotCustomer` check `data.lead_source === "hubspot_deal_created"` (and similar strings) to fire bypass logic. If an inserter sets `source` but leaves `lead_source` null, the bypass never fires, the signal fails validation, and nothing downstream runs.

**Rule:** every inserter that writes to `raw_signals` must set BOTH columns, and they should be identical:
```ts
.from("raw_signals").insert({
  source: "hubspot_deal_created",
  lead_source: "hubspot_deal_created",
  ...
})
```

**Inserters to audit:**
- `syft-webhook.ts` — sets `lead_source: source` ✅
- `syft-poll.ts` — sets `lead_source: source` ✅
- `deal-sync.ts` — FIXED Apr 8 (was the original bug)
- `posthog-identify.ts` — FIXED Apr 8 (was missing)
- `backfill-contacts.ts` — explicit `lead_source: "hubspot_backfill"` ✅

Any future inserter added without `lead_source` will silently drop at the validation gate.

### Internal domain early-return

`syft-webhook.ts` calls `validateDomain()` immediately after extracting the domain, before any DB write. Blocks `acmegtm.com`, `starbridge.ai`, `digital-made.com`, `octave.is` per `INTERNAL_DOMAINS` in `blocklists.ts`.

Without this guard, internal-domain signals get inserted → fail at normalize's validation gate → waste DB writes → can crash the insert if the payload has Syft's float timeSpent (see above).

**Employee-level block is separate and currently scaffolded but empty.** `INTERNAL_EMPLOYEES_LINKEDIN` and `INTERNAL_EMPLOYEES_EMAIL` sets exist in `blocklists.ts` for blocking specific people (e.g., a ACME employee's former domain). Not yet used by any gate — pending integration into `syft-webhook.ts` or `normalize.ts`.

**Never add an employee's former company domain to `INTERNAL_DOMAINS`.** Other real prospects may share the domain. Block the individual instead via `INTERNAL_EMPLOYEES_*`.

### UTM source parsing from `syft_visited_pages`

Syft does NOT send `utm_source` as a top-level field in the webhook. Raw UTM params (source / medium / campaign / term / content / gclid) live inside the URL string at `account.syft_visited_pages`, e.g.:
```
https://acmegtm.com/?utm_source=google&utm_medium=cpc&utm_campaign=23627361993&...
```

`syft-webhook.ts::parseUtmsFromUrl()` extracts them via URLSearchParams. Without this, `raw_signals.utm_sources` is always null even for paid traffic.

Syft DOES send `syft_latest_utm_medium` and `syft_latest_utm_campaign` as top-level fields. These are used as fallbacks but the URL parse takes priority.

`syft_latest_utm_source` does NOT exist. Attempting to read it returns undefined. Do not use it.

**`utm_channel` in our DB is Syft's 5-category enum**, not raw UTM source. Values: `Direct`, `Paid Search`, `Referral`, `linkedin_organic`, `Paid Other`. For the raw `utm_source` ("google" / "linkedin" / etc), look at `utm_sources` (singular source, plural-named column for historical reasons).

---

## Supabase schema quirks

### Enums are lowercase
- `lead_tier`: `hot` / `warm` / `cool` / `cold` — lowercase only. Querying with `Hot` returns a validation error.
- `signal_source`: `syft_website`, `syft_linkedin`, `fibbler_engagement`, `hubspot_deal_created`, `company_discovery`, `tam_import`, `hubspot_backfill`, `posthog_identify` — enum, can't be set to arbitrary strings.
- `processing_status`: enum with specific valid values — check migration files before setting.

### Foreign key cascade behavior
`signals.raw_signal_id REFERENCES raw_signals(id) NO ACTION` — deleting a raw_signal that has any signals row referencing it fails with 23503. Delete dependents first, then the parent.

Same pattern for `octave_results.company_id → companies` and `contacts.company_id → companies`. Cleanup order: `octave_results` → `signals` → `raw_signals` → `contacts` → `companies`.

### IN query filter syntax
`in.(value1,value2)` for IN queries via the REST API. No spaces after commas. Quoted strings not required for primitives.

---

## HubSpot push layer

### Conditional-spread pattern can SET but cannot CLEAR

`src/lib/hubspot.ts::updateHubSpotContact` uses this pattern:
```ts
...(data.signal_type && { signal_type: data.signal_type }),
```

Passing `""` or `null` as `data.signal_type` evaluates falsy and the field is **not included in the PATCH at all**. HubSpot keeps the old value forever.

**Consequence:** V2 can never CLEAR HubSpot enum properties via `updateHubSpotContact`. Only `createHubSpotContact` (initial contact creation) or a direct API call bypassing the wrapper can clear.

**Affected fields:** `signal_type`, `clay_lead_source`, `hs_linkedin_url`, `lead_summary`, `sales_org_summary`, `sub_market`, `city`, `state`, `first_touch_channel`, `phone`, `company`, `jobtitle`.

**Not affected (unconditional write):** `lead_origin` — written unconditionally via `||` fallback. Passing a value always overwrites HubSpot. Passing nothing writes `deriveLeadOrigin(undefined) = "V2 Enriched"`.

**Workaround for clearing:** call HubSpot API directly:
```ts
await hubspot.crm.contacts.basicApi.update(contactId, {
  properties: { signal_type: "" }  // empty string clears enum properties
});
```
See `scripts/backfill-hubspot-signal-type-clear.mts` for the pattern.

### Six callers of `updateHubSpotContact`, all pass partial payloads

Callers:
1. `src/triggers/update-hubspot.ts:101` — scores + tier only
2. `src/triggers/backfill-contacts.ts:225`
3. `src/triggers/contact-backfill.ts:56`
4. `src/triggers/score-cascade.ts:49`
5. `src/triggers/posthog-identify.ts:60`
6. `src/triggers/stale-refresh.ts:125`

Each caller selects a different subset of fields. None reliably pass V2-owned fields like `lead_origin`, `signal_type`, `lead_tier` together. Result: HubSpot sees inconsistent partial updates across refresh paths.

**If you add a 7th caller:** decide explicitly which V2-owned fields should travel with your update, pass them all, and accept that if you don't pass them they stay stale.

### `lead_origin` default fallback is `"V2 Enriched"`

`deriveLeadOrigin(undefined)` returns the literal string `"V2 Enriched"`. Any caller that doesn't pass `lead_origin` or `clay_lead_source` will write this placeholder into HubSpot. Not a bug, but a sign the caller forgot to pass attribution.

Three contacts had this value in HubSpot as of Apr 8 (fixed via direct UPDATE). If you see it, trace the caller and fix the missing attribution.

### `clay_lead_source` is deprecated but still being written

Per Shane (Apr 7 2026), `clay_lead_source` is a Clay-era field that shouldn't be used going forward. V2 still writes it on every contact create + update in `lib/hubspot.ts` lines 156, 195, 225 and in `enrich-contact.ts` lines 424-426. Remove as part of the next HubSpot push layer rewrite.

### LinkedIn URL format mismatch on dedup lookup

`createHubSpotContact` writes the full URL (`https://www.linkedin.com/in/jane-doe/`) to `hs_linkedin_url`. `lookupHubSpotContactEarly` searches with `CONTAINS_TOKEN` on just the slug (`jane-doe`). HubSpot's URL property tokenizer does not reliably break on hyphens inside LinkedIn slugs, so dedup misses are possible.

**Workaround** (Apr 8): `lookupHubSpotContactEarly` now tries multiple format variants sequentially — full URL EQ, full URL CONTAINS_TOKEN, slug CONTAINS_TOKEN — and returns the first match. Still not perfectly robust but catches more cases.

---

## External API gotchas

### Octave
- **Callback-only.** No sync endpoint, no polling endpoint. `/api/v2/sync/agent/run` returns 404. MUST use `/api/v2/async/agent/run` with a callback URL. V2 uses a Supabase edge function as the callback relay, then polls its own `octave_results` table.
- **`x-request-id` header** is how you match callbacks to requests. Octave includes `requestId` in the POST body.
- **`callbackUrl` is required** even if you don't need callbacks. Pass a dummy like `https://httpbin.org/post`.
- **Budget:** ~4-5 credits per QUALIFY, ~1-2 per PROSPECTOR.
- **K-12 only as of Apr 6 2026.** Non-K-12 records skip Octave entirely (per `feedback_octave_k12_gate`). `enrich-company.ts` checks sub_market before firing.

### LeadMagic
- **Email finder field is `domain`, NOT `company_domain`.** Sending `company_domain` returns 400 silently. This bug existed from day one until Apr 4.
- **Email finder endpoint:** `POST /v1/people/email-finder` with `{ first_name, last_name, domain }`
- **Email validation endpoint:** `POST /v1/people/email-validation` with `{ email }`
- **Auth:** `X-API-Key` header. NOT Bearer token. NOT Basic auth.
- **Status "valid"** = deliverable. Anything else = don't use.
- **Cross-check gotcha (Apr 7 bug):** After email-finder returns `status: "valid"`, do NOT pass the email through email-validation as a second-stage check. The validation endpoint returns `deliverable: false` on emails the finder confidently found, causing the waterfall to discard valid emails. Trust the finder's own status. Only cross-check validation when the finder returned a non-valid status.
- **Employee Finder field is `company_domain`**, NOT `company_website`.
- **Employee Finder response uses `data` array**, NOT `employees` or `results`. Shape: `{ message, total_count, returned_count, credits_consumed, data: [...] }`.
- **`total_funding` returns formatted string** like `"172.4M"`, not a raw number. Parse before storing in numeric columns. `parseFundingAmount()` in `src/triggers/tam-enrich.ts` handles this.
- **Returns `credits_consumed: 0`** when it can't find — no waste on misses.

### LemList
- **Campaign sequence design is UI-only.** Cannot create/modify steps via API. POST to `/api/campaigns/{id}/sequences/{id}/steps` returns 405.
- **Adding senders is UI-only.** POST to `/api/campaigns/{id}/senders` returns 405.
- **Lead add works:** `POST /api/campaigns/{id}/leads/{email}` with JSON body.
- **Auth:** HTTP Basic with empty username and API key as password. `--user ":$KEY"`.
- **409 response = lead already exists in campaign.** Not an error.
- **Lead email is required** even for LinkedIn-only campaigns. Use a placeholder if no email.

### Apify
- **DEPRECATED for email finding.** `automation-lab/email-finder` actor returns unverified firstname.lastname@domain patterns with zero verification. Caused email bounces. REMOVED from the email waterfall Apr 4.
- If ever re-added, MUST cross-validate with LeadMagic before trusting any Apify email.

### Starbridge
- **Auth is Auth0 JWT from browser localStorage**, NOT API keys. Settings → API Keys are Zapier-only.
- **Tokens are short-lived** and don't auto-refresh in scripts. Pull fresh from the browser when a request returns 401.
- **Search uses `terms`, not `filters`.** Passing `{"filters": [...]}` is silently ignored and returns all 298K records unfiltered.
- **298K buyers = school districts / gov agencies, NOT EdTech companies.** Do NOT use for ACME's own outbound TAM.

### HubSpot
- **`lead_temp` triggers MQL workflows.** Setting `lead_temp=Hot` on a contact triggers lifecycle progression. Be careful with bulk updates — this is the field Rose's workflows fire on.
- **Contact email update can trigger dedup.** If the new email already exists on another contact, HubSpot may merge or reject the update.
- **`INTEGRATION` as `hs_object_source`** means the contact came from a connected integration (Sales Nav, Clay, etc.), not from organic site activity.
- **Meeting UTM fields** (`engagements_last_meeting_booked_source/medium/campaign`) only populate when the calendar link has UTM params. RepC's naked calendar links produce null attribution.
- **No deal attribution workflow exists.** Meeting UTMs do NOT auto-copy to deals. Must be built as a HubSpot workflow.

---

## Scripts and backfills

### Local `.env` `TRIGGER_SECRET_KEY` is DEV, not prod

Any script that uses `@trigger.dev/sdk`'s `tasks.trigger()` function authenticates against the key in `process.env.TRIGGER_SECRET_KEY`. The local `.env` in `acme-gtmos-v2/` has `TRIGGER_SECRET_KEY=tr_dev_...` — a dev environment key.

**Calls go to the DEV environment, which has no deployed worker.** The trigger returns without throwing an error, the task never runs, and the script has no signal that anything went wrong.

**Fix options:**
1. Use the MCP trigger tool (`mcp__trigger__trigger_task`) — authenticates via Claude Code's MCP session, routes to prod. This is what worked for the 9 orphan shell enrichment on Apr 8.
2. Override the env var explicitly in the script: `process.env.TRIGGER_SECRET_KEY = "tr_prod_..."` with a prod key.
3. Don't use `@trigger.dev/sdk` at all — write directly to Supabase and let the pipeline cron pick it up (doesn't work for event-driven paths).

**Apr 8 2026 fuckup:** `scripts/backfill-shape-b-linkedin-events.mts` used `tasks.trigger()` with the dev key, silently failed to reach prod, then proceeded to DELETE the 18 source rows. Lost 18 rows of Shape B engagement data including Phil Tallman @ Mantra Health.

### Never combine trigger + delete in a script loop without verification

The two-phase pattern is mandatory for destructive backfills:

```ts
// WRONG — silent failure deletes source data
for (const row of rows) {
  await triggerSomething(row.payload);  // might silently fail
  await deleteRow(row.id);               // runs regardless
}

// RIGHT — verify success before destruction
const triggered: { id: string; runId: string }[] = [];
for (const row of rows) {
  const run = await triggerSomething(row.payload);
  triggered.push({ id: row.id, runId: run.id });
}
// Verify each run actually landed
for (const { id, runId } of triggered) {
  const runExists = await checkRunExists(runId);
  if (!runExists) throw new Error(`Run ${runId} for row ${id} did not reach prod`);
}
// Only now delete
for (const { id } of triggered) {
  await deleteRow(id);
}
```

Even better: don't delete at all. Mark rows as "reprocessed" and keep them for audit. Let a separate cleanup job delete obsolete rows on a delay.

### Supabase service client instantiation in scripts

Scripts that use `src/lib/supabase.js` will fail at module load time because that file instantiates the client using `process.env.SUPABASE_URL` — if dotenv hasn't loaded yet, the client creation crashes.

**Pattern:** create a fresh Supabase client directly in the script, not via the shared lib:
```ts
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY!,
);
```

Or run with env vars pre-sourced: `set -a && source .env && set +a && npx tsx script.mts`.

---

## Scoring and gates

### `scorePageIntent` is keyword-based, not pattern-based

`src/scoring/intent.ts::scorePageIntent()` matches hard-coded substrings against `session_pages_visited`. The list is ACME-specific and verified against production URL structure (see function body for the canonical list as of Apr 8).

**If ACME adds a new high-intent page, the score won't update automatically.** Add the new URL substring to the 30-point or 15-point tier in the function body. Verify against real Syft data (query `signals.session_pages_visited` in Supabase) before committing.

**Null pages + page_views > 0 floor:** when `session_pages_visited` is null but `page_views > 0`, the function returns a 5-point floor. Without this fallback, signals with engagement metrics but no URL detail score 0 and get unfairly demoted.

### Title blocklist: CEO/Founder/VP Sales only

ACME sells SDR outsourcing. The ICP buyer is CEO, Founder, VP Sales, or CRO. Everything else is blocked in `blocklists.ts::TITLE_BLOCKLIST_PATTERNS` / `TITLE_BLOCKLIST_ACRONYMS`:
- HR, Marketing, Finance, Engineering, Product, Ops, Legal — blocked as wrong buyer
- SDR, BDR, AE — blocked as "they're the service we sell, not the buyer"
- Customer Success, Account Manager — blocked as post-sale roles

**AE was added to the blocklist Apr 8 2026.** Prior to that, AEs passed the gate and could be pushed as contacts, which violates the "not the buyer" rule. Sales Director, Head of Sales, Sales Manager still pass through — they're adjacent buyer titles at mid-market companies.

**Positive target:** no explicit allowlist. The blocklist is the constraint; anything not matching a blocked pattern passes. Ambiguous titles like "Executive Circle Member" or "Practice Leader" pass by default — acceptable permissiveness for mid-market motions.

### Validation gate requires engagement OR a bypass

`gates.ts::passesValidationGate` requires `page_views > 0 OR linkedin_action` to pass. Raw signals without either get dropped.

**Bypasses:**
- `data.lead_source === "hubspot_deal_created"` — deals don't have engagement metrics, they are signals themselves. **Bypass only fires if lead_source is set (see `raw_signals` insert requirements above).**

**Non-signal sources** that the validation gate does NOT bypass automatically:
- `tam_import` — TAM outbound sets page_views=0 explicitly; routes through `tam-enrich.ts` which bypasses normalize entirely
- `hubspot_backfill` — same, handled via `backfill-contacts.ts` which also bypasses normalize
- `posthog_identify` — doesn't bypass; relies on PostHog sending actual page_view events

---

## Related docs

- `CLAUDE.md` — repo entry point, read first
- `ARCHITECTURE.md` — high-level V2 architecture
- `../tasks.md` (in gtm repo) — active work + recent deploys
- Memory index at `~/.claude/projects/-Users-shanefirek-projects-acmegtm-gtm/memory/MEMORY.md` — people/business context that doesn't belong in this repo
