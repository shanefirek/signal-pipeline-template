# Signal Pipeline Template

**Stack:** Supabase + Trigger.dev + Cargo + LeadMagic + Claude API + HubSpot + Slack

## Quick start

```bash
npm run build          # TypeScript compile
npm run test           # unit tests (412 tests)
npx trigger.dev deploy # Deploy to prod (<your-trigger-project-ref>)
```

**Env:** `.env` — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `HUBSPOT_API_KEY`, `LEADMAGIC_API_KEY`, `CARGO_API_KEY`, `ANTHROPIC_API_KEY`. Flags: `CARGO_VERIFY_ENABLED`, `HUBSPOT_PUSH_ENABLED`.

## Context — read the right doc, not memory

| Doc | When to read |
|-----|--------------|
| [`docs/pipeline-spec.md`](docs/pipeline-spec.md) | **THE SPEC** — what "working" means, step by step. Verify against this before and after every deploy. |
| [`docs/system-overview.md`](docs/system-overview.md) | What GTMOS does, pipelines, scoring, MQL rules |
| [`docs/dependency-map.md`](docs/dependency-map.md) | Trigger call graph, shared state, fragility points, silent failures |
| [`docs/working-agreements.md`](docs/working-agreements.md) | How Shane wants this built — workflow, code rules, provider rules, HubSpot rules |
| [`docs/providers/leadmagic.md`](docs/providers/leadmagic.md) | **Ground truth** for LeadMagic — all 19 endpoints, real response shapes, credit costs, Cargo migration map. Verified 2026-05-06. |
| [`docs/providers/cargo.md`](docs/providers/cargo.md) | **DEPRECATED** — Cargo is out of credits, not renewing. Historical reference only. |
| [`docs/architecture.md`](docs/architecture.md) | Three pipelines (Syft inbound, HubSpot deal, TAM batch), gates, scoring |
| [`docs/hubspot-schema/`](docs/hubspot-schema/) | HubSpot properties, workflows, pipelines. Regenerate: `npm run audit:hubspot-schema` |
| [`SCHEMA.md`](SCHEMA.md) | All Supabase tables, columns, indexes, constraints |
| [`tasks.md`](tasks.md) | Session handoff — **read `## Session handoff` first every session** |
| [`open-threads.md`](open-threads.md) | Open decisions, punted items |

## Hard rules

1. **Never `forceRun: true`** on HubSpot push — bypasses gates.
2. **MQL is `isMql()` from `gates.ts`**, NOT `isMQL()` from `constants.ts`. The gates.ts version checks buyer title allowlist + SLED. The constants.ts version is legacy/unused.
3. **LeadMagic is the only enrichment provider.** Cargo is deprecated (out of credits). See `docs/providers/leadmagic.md`.
4. **Never call something a bug from docs alone.** Test with a real API call first. CLAUDE.md hard rule.
5. **Before editing `src/`**: what changes? who reads downstream? blast radius? rollback? Hook enforces this.
6. **Before committing `src/`**: `[reviewed]` or `[trivial: <why>]` in message. Hook enforces this.
7. **Before deploying MQL changes**: `npx tsx scripts/smoke-test-mql-gate.mts`
7b. **Never deploy without explicit Shane approval.** Always ask and wait for confirmation before running `npx trigger.dev deploy` or any deploy command.
7c. **Before deploying, prove the fix works locally.** Run the changed logic against real raw payloads or real Supabase data. Show the actual output. Unit tests passing is not proof. "Slack is muted" is not permission. Deploy is Shane's call, not yours.
8. **Never edit AI prompts** without mapping full downstream impact.
9. **All scoring is local math.** Zero API calls in `src/scoring/`.
10. **Slack alerts are live.** MQL + rep_c-digest fire. pipe-health is logs-only.
11. **Cache ALL LeadMagic responses.** Every API call to LeadMagic must store the full raw response — in enrichment_log, in the output JSON, or both. Never discard LinkedIn URLs, titles, or any field from a response. Credits are real money; if we paid for data, we keep it.

## What's running (v20260518.2)

- **Syft pipeline** — webhooks + 30m poll → enrich → score → HubSpot (SLED gate)
- **HubSpot deal pipeline** — hourly → `enrich-deal-contact` (LeadMagic, no gates)
- **TAM batch** — `tam-enrich` + `tam-activate` (manual trigger)
- **Crons**: contact-backfill (1h), deal-sync (1h), hubspot-enrich-new (1h), utm-backfill (6h), pipe-health (6h), hubspot-parity-audit (weekly)

## What's NOT running (intentional)

- **pipe-health Slack** — logs only, not posting (Shane's preference)
- **fibbler-sync** — disabled, not running LinkedIn ads
- **company/contact/deal-refresh** — stubbed since Octave removal

## Known issues

See `tasks.md` and `open-threads.md` for current state. Key items:
- `acmegtm.com` HubSpot tracking pixel missing (marketing-ops)
- Syft sourceId mismatch (unverified)
- RepA K12 TAM audit pending
- ~20 stale `is_mql=true` contacts in Supabase from before title gate fix
- 5 unlogged enrichment operations in tam-enrich (company_search, jobs_finder, technographics, classify_sales_team, generate_summary)

## Territory routing

RepA (162280197): K12. RepB (163458119): Higher Ed + Gov. Via `deriveAeOwner()` in `constants.ts`.

## Data quality

- LeadMagic employee-finder ~67% accurate (~33% departed contacts). Use profile-search to verify before HubSpot push.
- LeadMagic profile-search replaces Cargo verifyEmploymentByUrl — 1 credit, <3s (was 0.5 credits, 45-136s).
- LeadMagic role-finder replaces Cargo findStakeholders — 2 credits/title with LinkedIn URLs (was 6.5 credits flat).
- Clean CRM > cheap enrichment.
