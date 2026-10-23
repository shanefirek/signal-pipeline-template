# Signal Pipeline — Architecture

**Last verified against code:** 2026-04-21

**Stack:** Supabase (data) + Trigger.dev (orchestration) + LeadMagic + Cargo + Apify + Claude API (Sonnet 4.6) + HubSpot (CRM) + Slack (alerts, currently OFF — see CLAUDE.md).

---

## Three pipelines

The system runs three separate pipelines. They share enrichment/scoring/push primitives but have different intake paths and different gates.

### 1. Inbound signal pipeline (Syft website + LinkedIn)

```
Syft API ──poll every 30m──→ syft-poll ──→ raw_signals
                                              │
                                         normalize
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
              enrich-company           discover-contact            score-intent
           (LeadMagic + Claude)     (LeadMagic employees →      (5-component,
                     │                Cargo verification)          zero API calls)
                     │                        │                        │
                     └──────→ enrich-contact ←┘                        │
                              (Cargo primary,                          │
                               LeadMagic fallback)                     │
                                       │                               │
                                       ├───────── update-hubspot ──────┘
                                       │
                                       └──────→ HubSpot push
                                                (SLED gate: K12/Higher Ed/Gov only)
```

**Key tasks:** `syft-poll`, `syft-webhook`, `normalize`, `enrich-company`, `discover-contact`, `enrich-contact`, `score-intent`, `update-hubspot`, `score-cascade`.

**Behavior:** `score-cascade` fires when a company's ICP score changes on re-qualification — re-scores every contact at that domain and pushes updates to HubSpot. See `src/triggers/score-cascade.ts`.

### 2. HubSpot deal pipeline (isolated, added 2026-04-17)

```
HubSpot deals ──hourly poll──→ deal-sync ──per new deal──→ enrich-deal-contact
                                                              │
                                           Cargo (primary) ───┤
                                           LeadMagic (fallback)│
                                           Claude summary ────┤
                                                              ▼
                                                      HubSpot push (no gates)
```

**Key tasks:** `deal-sync`, `enrich-deal-contact`.

**Behavior:** This pipeline is isolated from the Syft gates. See `memory/project_enrich_deal_contact.md`. No ICP/SLED filtering — AEs manually created the deal, so we trust it. Cargo is the clear primary here (`enrich-deal-contact.ts:370` — "Per feedback_cargo_default.md: Cargo is default for people/employment/LinkedIn").

### 3. TAM batch pipeline (manual, AE-driven)

```
AE CSV ──→ tam-enrich (batch) ──→ companies table
                                       │
                            tam-activate ──→ contacts + optional HubSpot push
```

**Key tasks:** `tam-enrich`, `tam-activate`.

**Behavior:** Used for RepB/RepA TAM lists. Enriches then optionally pushes. Separate from Syft gates.

---

## Supporting crons

| Task | Schedule | What |
|------|----------|------|
| `contact-backfill` | Hourly | Copy company ICP/summary to orphan contacts |
| `deal-sync` | Hourly | Detect new HubSpot deals → trigger enrich-deal-contact |
| `fibbler-sync` | OFF (was 6h) | Pull Fibbler from HubSpot → signals. Disabled 2026-04-21, not running ads. |
| `hubspot-enrich-new` | Hourly | Sweep HubSpot for new contacts missing from Supabase |
| `posthog-identify` | Webhook | Upgrade "Company Intent" → "Identified Visitor" |
| `stale-refresh` | Every 12h | Re-score intent with decay, re-push if tier changed |
| `pipe-health` | Every 6h | 5 health checks → Slack alerts (OFF) |
| `rep_c-digest` | Weekly Mon 8am ET | Pipe stats → #growth (OFF) |
| `apify-linkedin-sync` | (cron) | LinkedIn engagement sync via Apify |
| `utm-backfill` | (manual) | Backfill UTM attribution on contacts |

---

## Gates (the things that decide what pushes)

All gate functions live in `src/lib/gates.ts`. In order:

1. **Domain validation** — real domain, not enterprise, not internal, not in blocklist
2. **Dedup** — not an in-flight duplicate
3. **Company push gate** — ICP ≥ 50, has vertical_fit, not enterprise, not "Not B2B" or "Other B2B"
4. **SLED gate** (added 2026-04-16) — only `sub_market` in (K12, Higher Ed, Gov) push to HubSpot
5. **Contact push gate** — has email, not blocked title, tier in (Hot, Warm) OR `company_discovery` with vertical_fit OR `tam_import` (bypasses tier), company passes gate
6. **Discovery gate** — company doesn't already have an open deal (added 2026-04-16)

---

## Scoring

All scoring is local math, zero API calls.

- **ICP** (`src/scoring/icp.ts`) — vertical_fit + headcount + funding_stage + sales_org_size = 0-125. Produces `lead_temp` (Hot/Warm/Cold).
- **Intent** (`src/scoring/intent.ts`) — 5 components (purchase_intent, engagement_depth, direct_action, referral_source, page_intent) = 0-120. Produces `lead_tier` (Hot/Warm/Cool).
- **MQL rule** (`src/lib/constants.ts:150` `isMQL()`) — `lead_source` inbound AND tier in (Hot, Warm). See `memory/project_mql_system_healthy.md`.

---

## For more detail

- **Every file/trigger:** `docs/triggers.md`
- **Every provider + role:** `docs/stack.md`
- **Schema:** `SCHEMA.md`
- **Upstream/downstream field mapping:** `DATA-CONTRACTS.md`
- **Cron task specs:** `PHASE2-SPEC.md`
- **Known edge cases:** `docs/operational-gotchas.md`
