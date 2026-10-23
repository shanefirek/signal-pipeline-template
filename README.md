# Signal Pipeline Template

A signal-to-CRM pipeline you can point at any intent source. Events come in by webhook, get normalized into a canonical signal, enriched through a provider waterfall, scored against ICP and intent rules, and pushed to the CRM with a Slack digest. Built on Supabase (Postgres + edge functions) and Trigger.dev (durable task graph).

This is a scrubbed template extracted from a production deployment. Client data, credentials, team member references, and one-off operational scripts have been removed. Vendor integrations are kept as working examples of the adapter pattern; swap or delete the ones you do not use.

## Shape

```
webhook (Supabase edge fn)
  → syft-webhook / syft-poll     intake: raw payload → raw_signals row
  → normalize                    canonical signal: company, person, source, type
  → enrich-company / enrich-contact   provider waterfall (LeadMagic, Cargo, Apify, website fetch)
  → score-intent / score-cascade      ICP fit + intent decay + sub-market classifier (Claude)
  → update-hubspot               CRM write with gates (dedupe, blocklists, parity audit)
  → slack digest / pipe-health   observability
```

- `src/triggers/` — every Trigger.dev task. One file per stage.
- `src/enrichment/` — provider adapters and the waterfall. Add a provider by implementing the `Provider` type and appending it to the waterfall order.
- `src/scoring/` — ICP, intent, and TAM scoring. Pure functions, unit tested.
- `src/lib/` — HubSpot client, Supabase client, gates, blocklists, summaries, Slack.
- `supabase/migrations/` — schema. `supabase/functions/` — the public intake endpoints.
- `docs/` — architecture, data flow, ERD, data contracts, operational gotchas. Read `docs/operational-gotchas.md` before touching intake.

## Run it

```bash
cp .env.example .env            # fill in what you have; missing providers are skipped
npm install
npm run build
npm test                        # unit tests for scoring, gates, summaries
supabase link --project-ref <ref>
supabase db push                # apply migrations
supabase functions deploy syft-webhook
supabase secrets set TRIGGER_SECRET_KEY=<key>
npx trigger.dev deploy          # set `project` in trigger.config.ts first
```

Point your signal source's webhook at `https://<ref>.supabase.co/functions/v1/syft-webhook`.

## Adapting it

- **New signal source:** copy `src/triggers/syft-webhook.ts`, change the payload mapping in the intake section, keep the handoff to `normalize`.
- **New CRM:** `src/lib/hubspot.ts` is the only file that knows HubSpot. `update-hubspot.ts` calls it through a small surface.
- **Scoring:** rules live in `src/scoring/`. The sub-market classifier prompt is in `src/lib/sub-market-classifier.ts`; rewrite the category list for your market.
- **Placeholders:** `rep_a`, `rep_b`, `rep_c` stand in for named sales reps in routing and Slack mentions. `Acme GTM` stands in for the operating company in prompts.

## What was removed in the scrub

Client HubSpot schema exports, audit reports, exported contact lists, rep-specific backfill scripts, and the Trigger.dev project reference. `package-lock.json` is kept so installs are reproducible.
