# Signal Pipeline — Stack & Provider Roles

**Last verified against code:** 2026-04-20

What each external service does and where it's called from. If a new workflow needs a provider, pick from this list — don't add a new one without a reason.

---

## Data plane

### Supabase
- Primary datastore. Service-key access from triggers (`src/lib/supabase.ts`).
- Tables in `supabase/migrations/` — see [`SCHEMA.md`](../SCHEMA.md) for the full column-by-column map.
- All scoring reads/writes here. HubSpot is a derived view, not source of truth for contact/company state.
- Exception: for **HubSpot state questions**, query HubSpot API directly — Supabase drifts (see `feedback_hubspot_ground_truth.md`).

### Trigger.dev
- Orchestration layer. Tasks in `src/triggers/` (29 files, 29 task IDs — see [triggers.md](./triggers.md)).
- Project ref: `<your-trigger-project-ref>`.
- Prod deploys: `npx trigger.dev deploy`.

---

## Enrichment providers

The **Cargo-first rule** (`feedback_cargo_default.md`, hard rule): Cargo is the default for anything involving a person — employment verification, LinkedIn URL, title, phone, email. LeadMagic is fallback only. The deal pipeline (`enrich-deal-contact`) honors this. The Syft pipeline (`enrich-contact`) gates Cargo behind `CARGO_VERIFY_ENABLED=true` for historical reasons.

### Cargo (`src/enrichment/providers/cargo.ts`)
- **Role:** primary for people/employment/LinkedIn/title/phone/email
- **API:** `https://api.getcargo.io/v1`, uses LinkedIn enrichment under hood
- **Auth:** `CARGO_API_KEY` env var
- **Used by:** `enrich-deal-contact` (primary), `enrich-contact` (if env flag on), `email-waterfall.ts`
- **Credits:** ~2,845 remaining as of audit (see `docs/providers/cargo.md`)

**Cargo verification chain (critical — learned 2026-04-21):**

The contact verification chain MUST follow this order:

1. **Discovery** — LeadMagic employeeFinder (primary) → Cargo findStakeholders (fallback, 6.5 credits). Gets name + title + sometimes LinkedIn URL.
2. **LinkedIn URL acquisition** — If discovery didn't return a LinkedIn URL, the contact CANNOT be reliably verified. Name-based search (`enrichProfileFromName`, workflow `1ca01822`) has a **56% error rate** — it fails on common names, slight LinkedIn name variations, or sparse profiles.
3. **Verification by URL** — Use `enrichProfile` (workflow `53f31647`, 0.5 credits) with the LinkedIn URL. This is direct profile enrichment — returns current company/title with high reliability. **Always prefer URL-based over name-based verification.**
4. **Domain comparison** — `domainsMatch()` in `cargo.ts` handles rebrands (tophat.com ↔ toph.at etc). Match = confirmed, mismatch = departed.

**Key rule: LinkedIn URL first, verification second.** Without a LinkedIn URL, Cargo verification is unreliable. The pipeline should ensure every contact gets a LinkedIn URL during discovery before attempting verification. Run URL-based verification in parallel (20 concurrent is safe) for speed.

| Workflow | Input | Cost | Reliability | Use when |
|----------|-------|------|-------------|----------|
| `enrichProfileFromName` (`1ca01822`) | firstName, lastName, companyDomain | 0.5 | ~44% | No LinkedIn URL available (last resort) |
| `enrichProfile` (`53f31647`) | linkedinUrl | 0.5 | ~75% | Have LinkedIn URL (always prefer this) |
| `findStakeholders` (`4b29f36e`) | companyDomain, titles | 6.5 | Varies | Discovery fallback when LeadMagic returns 0 |

### LeadMagic (two modules)
#### `providers/leadmagic.ts` — People
- Email validate, email find, mobile phone lookup
- **Auth:** `LEADMAGIC_API_KEY` env var, `X-API-Key` header (NOT Bearer)
- **Role:** fallback behind Cargo for email/phone
- **Note:** employee-finder is ~67% accurate per RepB — needs Cargo verification layer

#### `providers/leadmagic-company.ts` — Firmographics
- Company data, employees, jobs, technographics
- **Role:** primary for company-level data (not people)
- **Used by:** `enrich-company`, `discover-contact`, `company-data-waterfall`, `tam-enrich`

### Apify (`src/enrichment/providers/apify-company.ts`)
- **Role:** company data fallback when LeadMagic misses. Website-content-crawler actor.
- **Also used by:** `apify-linkedin-sync` (separate actor: `harvestapi/linkedin-profile-posts`) — scrapes RepC's LinkedIn post engagement

### Website-fetch (`src/enrichment/providers/website-fetch.ts`)
- **Role:** final fallback — plain `fetch()` + regex. Free. Good enough for static marketing sites LeadMagic missed.

### Claude API (Anthropic)
- **Role:** sub-market classification (K12 / Higher Ed / Gov / Other B2B / Not B2B) + lead summary generation. That's it. No scoring, no extraction.
- **Called from:** `src/lib/sub-market-classifier.ts`, `src/lib/summaries.ts`
- **Model:** Sonnet 4.6
- **Env:** `ANTHROPIC_API_KEY`

---

## Delivery plane

### HubSpot
- CRM target. All pushes go through `src/lib/hubspot.ts`.
- 9 live workflows filter on `lead_origin = "Clay"` — `LEAD_ORIGIN` constant stays "Clay" until coordinated cutover.
- **Env flag:** `HUBSPOT_PUSH_ENABLED` — `isHubSpotPushEnabled()` gates every push.
- **Enum values that MUST stay exact:**
  - `lead_temp`: Hot / Warm / Cold (capitalized)
  - `lead_tier`: Hot / Warm / Cool / "" (empty for Cold)
  - `signal_type`: "Company Intent" / "LinkedIn Engagement" / "Deal Created"

### Slack
- Alert channel. **Currently OFF** — `SLACK_WEBHOOK_URL` hard-coded to `null` in `src/lib/slack.ts`, `pipe-health.ts`, `rep_c-digest.ts` (2026-04-17). Old webhook pointed at wrong channel.
- Message-building code is intact. Only the POST is short-circuited.
- Don't re-enable without confirming correct channel + new webhook.

### LemList
- Helpers in `src/lib/lemlist.ts`. Auto-enrollment for Hot leads is NOT yet wired to triggers — stubbed for future.

---

## Env flags that change behavior

| Flag | Where | Effect |
|------|-------|--------|
| `CARGO_VERIFY_ENABLED` | `src/triggers/enrich-contact.ts:168` | Gates Cargo verification on the Syft path. When off, Syft pipeline uses LeadMagic only (violates Cargo-first rule). Deal path ignores this flag. |
| `HUBSPOT_PUSH_ENABLED` | `src/lib/hubspot.ts` | Master kill-switch for all HubSpot writes |
| `SLACK_WEBHOOK_URL` | `src/lib/slack.ts` | Currently null'd — don't un-null without new channel |
| `LEAD_ORIGIN` (constant, not env) | `src/lib/constants.ts` | Hard-coded "Clay" — changing requires coordinated HubSpot workflow cutover |

---

## Why this shape

- **Supabase + Trigger.dev** — replaces Clay (4 tables + workbook) + growth-ops cron jobs + Railway clay-refresh service.
- **Cargo-first** — LeadMagic employee-finder is ~67% accurate. Cargo's LinkedIn-backed verification catches departures and confirms employment. Clean CRM > cheap enrichment.
- **Claude for classification only** — scoring is deterministic formulas (`src/scoring/`). Don't add Claude calls to scoring paths without a damn good reason.
- **HubSpot as derived view** — Supabase is source of truth for enrichment/scoring. HubSpot is the AE-facing projection. Querying HubSpot directly is correct when you need to know "what does the AE see right now."
