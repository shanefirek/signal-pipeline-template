# Signal Pipeline — Triggers, Lib, Providers

**Last verified against code:** 2026-04-20

Full map of every Trigger.dev task, lib module, and enrichment provider in `src/`. Grouped by role so you can find what you need without grepping.

For the higher-level flow, see [architecture.md](./architecture.md).

---

## Triggers (29 total, in `src/triggers/`)

### Intake (3)
| File | Task ID | Trigger | What |
|------|---------|---------|------|
| `syft-webhook.ts` | `syft-webhook` | HTTP webhook | Syft pixel payload → `raw_signals` |
| `syft-poll.ts` | `syft-poll` | Cron `*/30 * * * *` | Pulls Syft API every 30m → `raw_signals` |
| `posthog-identify.ts` | `posthog-identify` | HTTP webhook | Upgrades "Company Intent" → "Identified Visitor" when PostHog identifies a visitor |

### Normalize & route (1)
| File | Task ID | What |
|------|---------|------|
| `normalize.ts` | `normalize` | Domain validation, blocklists, dedup, routes to enrich-company / discover-contact / score-intent |

### Company enrichment (1)
| File | Task ID | What |
|------|---------|------|
| `enrich-company.ts` | `enrich-company` | LeadMagic firmographics + Claude sub-market classifier → ICP scoring → HubSpot push |

### Contact discovery & enrichment (3)
| File | Task ID | What |
|------|---------|------|
| `discover-contact.ts` | `discover-contact` | LeadMagic employee finder → triggers enrich-contact per candidate. Skips if company has open deal. |
| `enrich-contact.ts` | `enrich-contact` | **Syft path.** Cargo verification (env-gated via `CARGO_VERIFY_ENABLED`) + LeadMagic email + phone → HubSpot push |
| `enrich-deal-contact.ts` | `enrich-deal-contact` | **Deal path (isolated).** Cargo primary → LeadMagic fallback → Claude summary → HubSpot push. No gates. |

### Scoring (2)
| File | Task ID | What |
|------|---------|------|
| `score-intent.ts` | `score-intent` | 5-component intent scoring (local math, zero API calls) → `lead_tier` |
| `score-cascade.ts` | `score-cascade` | Fires when a company's ICP score changes on re-qualification → re-scores every contact at that domain → re-pushes |

### HubSpot sync (4)
| File | Task ID | Trigger | What |
|------|---------|---------|------|
| `update-hubspot.ts` | `update-hubspot` | Called post-scoring | Pushes company + contact updates to HubSpot after enrichment finishes |
| `deal-sync.ts` | `deal-sync` | Cron `0 * * * *` | Hourly HubSpot deals poll → triggers `enrich-deal-contact` per new deal |
| `hubspot-enrich-new.ts` | `hubspot-enrich-new` | Cron `45 * * * *` | Sweeps HubSpot for new contacts not yet in Supabase, seeds them |
| `hubspot-parity-audit.ts` | `hubspot-parity-audit` | Cron (weekly Sun 10am UTC) | Snapshots HubSpot, runs drift detection SQL, writes to `audit_parity_runs`. No Slack/DMs — review via SQL. |

### Refresh / backfill crons (6)
| File | Task ID | Trigger | What |
|------|---------|---------|------|
| `stale-refresh.ts` | `stale-refresh` | Cron `0 */12 * * *` | Re-scores intent with decay, re-pushes if tier changed |
| `contact-backfill.ts` | `contact-backfill` | Cron `15 * * * *` | Copies company ICP/summary to orphan contacts |
| `fibbler-sync.ts` | `fibbler-sync` | Cron `30 */6 * * *` | Pulls Fibbler from HubSpot → signals + tag contacts |
| `utm-backfill.ts` | `utm-backfill` | Cron `0 */6 * * *` | Parses `hs_analytics_first_url` → writes utm_* props (meetings pages don't auto-populate) |
| `backfill-contacts.ts` | `backfill-contacts` | Manual (task) | Enriches raw-imported HubSpot contacts (e.g. RepD's Red Rows) |
| `mql-summary-backfill.ts` | `mql-summary-backfill` | Manual (one-shot) | Rebuilds old-format `lead_summary` for MQL contacts. No Claude calls — structured template. |

### Alerts (2, both currently OFF)
| File | Task ID | Trigger | What |
|------|---------|---------|------|
| `pipe-health.ts` | `pipe-health` | Cron `0 */6 * * *` | 5 health checks → Slack (hard-null'd 2026-04-17) |
| `rep_c-digest.ts` | `rep_c-digest` | Cron `0 13 * * 1` | Weekly Mon 8am ET pipe stats → Slack (hard-null'd 2026-04-17) |

### Batch / manual (3)
| File | Task ID | What |
|------|---------|------|
| `tam-enrich.ts` | `tam-enrich` | AE CSV batch → enriched `companies` rows. Works with LeadMagic only post-Octave. |
| `tam-activate.ts` | `tam-activate` | Activates enriched TAM companies into contacts (+ optional HubSpot push) |
| `rep_a-contact-cleanup.ts` | `rep_a-contact-cleanup` | One-time full-enrichment pass over RepA's 308 contacts |

### External sync (1)
| File | Task ID | What |
|------|---------|------|
| `apify-linkedin-sync.ts` | `apify-linkedin-sync` | Scrapes RepC's LinkedIn posts via Apify, matches commenters/reactors to contacts/companies → `linkedin_post_engagement` signals |

### Stubbed / disabled (3 — Octave removed 2026-04-15)
| File | Task ID | Status |
|------|---------|--------|
| `company-refresh.ts` | `company-refresh` | No-op. Was Octave QUALIFY_COMPANY. Needs LeadMagic-based replacement. |
| `contact-refresh.ts` | `contact-refresh` | No-op. Was Octave PROSPECTOR. Cargo verification in enrich-contact covers departures. |
| `deal-refresh.ts` | `deal-refresh` | No-op. Was Octave QUALIFY_COMPANY for deal companies. |

---

## Lib (`src/lib/`)

| File | What |
|------|------|
| `constants.ts` | `LEAD_ORIGIN` ("Clay" until cutover), `deriveLeadOrigin()`, `isMQL()` rule (inbound + Hot/Warm) |
| `gates.ts` | All domain / push / discovery / SLED gates. Single source of truth for "does this push?" |
| `hubspot.ts` | HubSpot push functions (company, contact create/update, lookups). `isHubSpotPushEnabled()` env flag. |
| `supabase.ts` | Supabase client (service key) |
| `slack.ts` | Slack webhook alerts — **currently null'd**. All message-building intact, only POST short-circuited. |
| `blocklists.ts` | Enterprise domains, internal domains, blocked title patterns |
| `funding.ts` | Funding stage derivation from LeadMagic data |
| `summaries.ts` | Claude-powered `generateLeadSummary()` |
| `sub-market-classifier.ts` | Claude-powered sub-market classifier (K12 / Higher Ed / Gov / Other B2B / Not B2B) |
| `lemlist.ts` | LemList helpers (auto-enrollment not yet wired to triggers) |
| `audit-parity.ts` | HubSpot ↔ Supabase parity audit helpers (used by `hubspot-parity-audit`) |
| `refresh-deltas.ts` | Delta computation for refresh tasks (compare pre/post enrichment state) |

---

## Scoring (`src/scoring/`)

| File | What |
|------|------|
| `icp.ts` | ICP scoring — vertical_fit + headcount + funding_stage + sales_org_size = 0-125 → `lead_temp` |
| `intent.ts` | 5-component intent (purchase_intent, engagement_depth, direct_action, referral_source, page_intent) = 0-120 → `lead_tier` + Fibbler engagement bonus |
| `tam-icp.ts` | `computeTamICP()` — deterministic TAM scoring formula used by `tam-enrich` |

All scoring is local math. Zero external API calls.

---

## Enrichment (`src/enrichment/`)

### Waterfalls
| File | What |
|------|------|
| `company-data-waterfall.ts` | Single entry point for company enrichment. Tier order: LeadMagic → Apify website-content-crawler → plain website-fetch. |
| `email-waterfall.ts` | **Cargo-first** email finder, LeadMagic fallback (per `feedback_cargo_default.md`, hard rule). |
| `types.ts` | Shared enrichment types |

### Providers (`src/enrichment/providers/`)
| File | Role | Credits / Cost |
|------|------|----------------|
| `cargo.ts` | **Primary** for people/employment/LinkedIn/title/phone/email. Uses LinkedIn enrichment under hood. | 0.5 credits/contact |
| `leadmagic.ts` | Email validate + find + mobile phone. Fallback when Cargo misses. | ~1 credit per lookup |
| `leadmagic-company.ts` | Company firmographics, employees, jobs, technographics | ~1 credit/company |
| `apify-company.ts` | Fallback company data — website-content-crawler actor | ~$0.0015/company (3 pages) |
| `website-fetch.ts` | Final fallback — plain `fetch()` + regex on `<title>`/`<meta>`/OG tags. Free. | free |

See [stack.md](./stack.md) for provider roles and why Cargo is primary.
