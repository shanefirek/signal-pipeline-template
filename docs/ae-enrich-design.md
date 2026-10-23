# AE Enrich — On-Demand Enrichment for Sales Nav Prospects

## Problem

AEs (RepA, RepB) find prospects in LinkedIn Sales Navigator. Today there's no way to get those prospects enriched and into HubSpot without manual data entry or waiting for a Syft signal. They need a "drop it in, get it enriched" workflow.

## Core Concept

One Trigger.dev task: `ae-enrich`. Takes a LinkedIn URL + requesting AE. Figures out what state the person/company is in, does the right enrichment, pushes to HubSpot. AE doesn't need to know what exists already — the system resolves it.

## Input

```typescript
{
  linkedin_url: string;       // required — the Sales Nav find
  ae: "rep_a" | "rep_b";         // who's requesting
  notes?: string;             // optional — AE context ("met at conference", etc.)
}
```

LinkedIn URL is the universal key. Cargo `enrichProfile` extracts everything from it.

## State Resolution

```
LinkedIn URL → Cargo enrichProfile → get email, name, title, company domain

1. Lookup company by domain in Supabase
   → exists? Use it. Missing enrichment? Refresh.
   → new? Full company enrich (LeadMagic company + classify + score)

2. Lookup contact by email OR linkedin_url in Supabase
   → exists in Supabase + HubSpot? Update scores, verify not departed
   → exists in Supabase, not in HubSpot? Push to HubSpot
   → new? Create in Supabase + push to HubSpot

3. Push to HubSpot
   → lead_source: "salesnav_import"
   → lead_type: "outbound" (AE-sourced, not inbound signal)
   → hubspot_owner_id: requesting AE
   → Do NOT set lead_temp (outbound contacts don't trigger MQL workflows)
   → Do NOT set lifecyclestage to MQL (no inbound signal = not an MQL)
   → lifecyclestage: "lead"
```

## What Gets Enriched

| Data | Source | When |
|------|--------|------|
| Name, title, email, phone | Cargo enrichProfile | Always (1 credit) |
| Company firmographics | LeadMagic company-search | If company is new or stale (>30d) |
| Sub-market classification | Claude Haiku classifier | If company has no sub_market or stale version |
| ICP score | Local scoring | Always (free) |
| Sales org analysis | Cargo Find Stakeholders | If company is new |
| Lead summary | Claude API | Always for new contacts |

## What It Does NOT Do

- Does NOT mark as MQL (outbound ≠ MQL)
- Does NOT set lead_temp (avoids triggering inbound workflows)
- Does NOT overwrite AE notes or existing HubSpot activity
- Does NOT bypass the domain blocklist (clients are still blocked)
- Does NOT trigger Slack MQL alerts (not an MQL)

## Front Door Options (pick one to start)

### Google Sheet (recommended for v1)
- Shared sheet, one row per prospect
- Columns: LinkedIn URL, AE, Notes, Status (auto-filled)
- 5-minute cron polls for new rows, triggers `ae-enrich` for each
- AE sees status update in the sheet when done
- Pros: Zero setup for AEs, familiar, works from mobile
- Cons: Not real-time (up to 5min lag)

### Slack Command (v2)
- `/enrich https://linkedin.com/in/someone`
- Triggers `ae-enrich`, DMs the AE with result
- Pros: Real-time, in their workflow
- Cons: Need Slack app interactivity (slash commands), more to build

### Webhook / API (v3)
- POST endpoint that any tool can hit
- Could wire to browser extension, Zapier, etc.
- Pros: Most flexible
- Cons: Need auth, need a client to call it

## Existing Primitives to Reuse

| Primitive | File | Notes |
|-----------|------|-------|
| Cargo enrichProfile | `src/lib/cargo.ts` | Already wired, returns email+phone+title |
| Company enrichment | `src/triggers/enrich-company.ts` | Full company pipeline |
| Contact creation | `src/triggers/enrich-contact.ts` | Reference, but ae-enrich should be standalone |
| Sub-market classifier | `src/lib/sub-market-classifier.ts` | v2.0.0, SLED-only |
| ICP scoring | `src/scoring/icp.ts` | Local math, zero API calls |
| HubSpot push | `src/lib/hubspot.ts` | Contact + company create/update |
| Lead summary | `src/lib/summaries.ts` | Claude API |
| Territory routing | `src/lib/constants.ts` | `deriveAeOwner()` |
| Google Sheets | `acme-analytics/credentials/` | Service account already shared |

## Architecture

```
[Front Door] → ae-enrich task
                ├── Cargo enrichProfile (LinkedIn → person data)
                ├── Supabase lookup (company + contact state)
                ├── enrich-company (if new/stale)
                ├── classify sub-market (if missing)
                ├── score ICP (always)
                ├── generate lead summary (if new contact)
                ├── HubSpot push (create or update)
                └── Response back to front door
```

Standalone task like `enrich-deal-contact` — calls primitives, no gates, no Syft dependency. See `memory/project_enrich_deal_contact.md` for the pattern.

## Estimated Effort

- `ae-enrich` task: Medium (state resolution is the complexity)
- Google Sheet cron: Small (reference: `scripts/push-rep_b-to-hubspot.mts`)
- Testing: Need to cover all 4 state matrix scenarios

## Open Questions

1. Should AE-enriched contacts get intent scoring from historical Syft signals? (If company already has signals, the contact would inherit intent_score)
2. Rate limit per AE? (Cargo credits aren't free — maybe 20/day cap?)
3. Should we notify the AE when enrichment fails? (Bad LinkedIn URL, departed contact, blocked domain)
4. Do we want a "bulk mode" for Sales Nav list exports, or always piecemeal?
