# Signal Pipeline — Dependency Map & Fragility Assessment

Generated: Apr 30, 2026

## The Pipeline in Plain English

```
Syft sends signals (webhook + 30min poll)
    |
    v
normalize.ts — validates, dedupes, then fires THREE tasks IN PARALLEL:
    |
    +---> score-intent        (scores the signal, triggers update-hubspot)
    +---> enrich-company      (if new company: LeadMagic + Claude + HubSpot push)
    |         |
    |         +---> discover-contact  (finds people at company via Cargo)
    |                   |
    |                   +---> enrich-contact (up to 3x, one per person found)
    |
    +---> enrich-contact      (if contact is new/stale: verify + enrich + HubSpot push + Slack MQL alert)
```

The "done" problem: all three parallel branches must finish, and the LAST one to finish
is supposed to call tryMarkSignalDone(). If any branch exits early without calling it,
the signal stays stuck in "scoring" forever. There is no sweep or safety net.

## Trigger Call Graph

```
ENTRY POINTS (external / cron)              WHAT THEY TRIGGER
─────────────────────────────               ──────────────────
syft-webhook ──────────────────────────────> normalize
syft-poll (30min) ─────────────────────────> normalize
posthog-identify (webhook) ────────────────> normalize

normalize ─────────────────────────────────> score-intent (always)
                                           > enrich-company (if company new)
                                           > enrich-contact (if contact new/stale)
                                           > discover-contact (if existing SLED, <3 contacts, 24h cooldown)

score-intent ──────────────────────────────> update-hubspot
enrich-company ────────────────────────────> discover-contact (if passes gate)
                                           > update-hubspot (early exit path)
enrich-contact ────────────────────────────> update-hubspot (early exit path)
discover-contact ──────────────────────────> enrich-contact (up to 3x)

deal-sync (hourly) ────────────────────────> enrich-deal-contact
hubspot-enrich-new (hourly) ───────────────> enrich-company

STANDALONE CRONS (no downstream triggers)
─────────────────────────────────────────
contact-backfill (hourly)      — patches HubSpot scores
stale-refresh (12h)            — refreshes stale HubSpot data
utm-backfill (6h)              — patches UTM attribution
pipe-health (6h)               — health checks (logs only, no Slack)
hubspot-parity-audit (weekly)  — drift detection
rep_c-digest (weekly Mon)      — AE summary

MANUAL ONLY
───────────
tam-enrich                     — batch TAM enrichment
tam-activate                   — push TAM to HubSpot
score-cascade                  — recompute all scores
```

Max depth: 5 hops (syft-webhook > normalize > enrich-company > discover-contact > enrich-contact)

## The Three Most Dangerous Files

### 1. enrich-contact.ts — 835 lines, 12 imports, 6 external APIs

This one function does: HubSpot lookup, Cargo verification, email waterfall,
phone lookup, company ICP fetch, intent score fetch, MQL determination,
contact upsert, departure detection, push gate check, Claude summary,
HubSpot push, Slack MQL alert, LemList enrollment.

It has 4 return paths. Until today's fix, only 1 of them called tryMarkSignalDone().
Every new feature adds another branch, another place things can silently fail.

### 2. gates.ts — 12 triggers depend on it

Every gate decision (push to HubSpot? MQL? discovery?) lives here.
One wrong regex in the title allowlist = AEs get noise or miss real leads.
The MQL gate bug (old isMQL vs new isMql) lived here for 2 weeks.

### 3. hubspot.ts — 18 files import it

Every HubSpot read/write goes through this file. The signal_date bug
(INVALID_DATE for 2 weeks) was a one-line error here that silently
broke every contact push.

## Shared Mutable State (What Causes Race Conditions)

### raw_signals.status — 6 writers, no locking

| Writer | Sets to | When |
|--------|---------|------|
| normalize | "enriching" | Start of processing |
| normalize | "filtered" | Fails validation |
| normalize | "scoring" | Before triggering downstream |
| tryMarkSignalDone | "done" | When all branches complete |
| enrich-company | "error" | Data quality failure |
| hubspot-enrich-new | "done" | Bulk override (dangerous) |

### contacts.icp_score — 4 writers, no coordination

| Writer | When |
|--------|------|
| enrich-contact | Contact upsert |
| score-intent | Parallel with enrich-contact (reads stale ICP=0 for new companies) |
| contact-backfill | Hourly cron (corrects stale values) |
| score-cascade | Manual recompute |

## Silent Failure Points

These are places where errors are caught and swallowed — the system
continues as if nothing went wrong:

| File | Line | What fails silently |
|------|------|---------------------|
| enrich-contact | 738-748 | HubSpot push fails, but Slack MQL alert STILL FIRES. AE gets notification with no HubSpot contact. |
| enrich-contact | 481 | raw_signals.update(contact_id) — result not checked. If this fails, signal stuck forever. |
| hubspot-enrich-new | 220 | Bare `catch {}` swallows Claude API failures. Contact pushed to HubSpot with no summary. Zero log. |
| contact-backfill | 111 | `backfilled++` increments even when HubSpot push failed. Reports false success count. |
| normalize | 43-173 | All raw_signals.update() calls — results never checked. Silent state corruption. |
| score-intent | 198-207 | Contact score updates — results never checked. |

## What Actually Needs to Happen

### Immediate (make it stop breaking)

1. **Signal lifecycle sweep** — scheduled task every 15min that finds signals
   stuck in "scoring" >30min and resolves them. This is the safety net that
   makes the system self-healing instead of accumulating stuck signals.

2. **Check Supabase write results** — the 6 unchecked writes in enrich-contact
   and normalize are the #1 source of silent state corruption. Add error checks
   and logging. 30 minutes of work.

### Medium-term (make it trustworthy)

3. **Integration test before deploy** — a script that feeds a known signal
   through the full pipeline and asserts: company created, contact created,
   HubSpot push succeeded, signal marked done. If this passes, deploy. If not, don't.

4. **Break up enrich-contact.ts** — 835 lines is not maintainable. The function
   should be: verify contact > enrich contact > push to HubSpot > alert.
   Four steps, four functions, each with clear inputs and outputs.

### What's actually working fine

- Scoring (all local math, well-tested, 412 unit tests pass)
- Gates (isMql, push gates — correctly blocking bad contacts since v20260430.2)
- Company enrichment (LeadMagic + Claude summary pipeline)
- HubSpot push (when it gets there — the writes themselves work)
- Slack alerts (only fire for real buyer titles at SLED companies)
- Crons (deal-sync, contact-backfill, utm-backfill all running clean)

## File-Level Dependency Counts

### Libs by number of importers (blast radius)

| File | Importers | Touch with extreme care |
|------|-----------|------------------------|
| supabase.ts | 22+ | Never |
| hubspot.ts | 18 | signal_date bug lived here |
| gates.ts | 12 | MQL gate bug lived here |
| summaries.ts | 8 | Prompt changes affect all AE briefs |
| constants.ts | 8 | AE owner IDs, lead origin logic |
| scoring/intent.ts | 8 | computeTier, scoreIntent |
| signal-lifecycle.ts | 3 | tryMarkSignalDone |
| slack.ts | 3 | MQL alerts |
| lemlist.ts | 1 | Safe to change |
| audit-parity.ts | 1 | Safe to change |

### Triggers by complexity

| Trigger | Lines | External APIs | Downstream triggers |
|---------|-------|---------------|---------------------|
| enrich-contact | 835 | 6 (Cargo, LeadMagic, Claude, HubSpot, Slack, LemList) | 1 (update-hubspot) |
| enrich-company | 455 | 5 (LeadMagic x4, Cargo, Claude, HubSpot) | 2 (discover-contact, update-hubspot) |
| tam-enrich | 333 | 4 (LeadMagic, Cargo, Claude x2) | 0 |
| normalize | 335 | 1 (HubSpot lookup) | 4 (score-intent, enrich-company, enrich-contact, discover-contact) |
| hubspot-enrich-new | 277 | 3 (HubSpot, LeadMagic, Claude) | 1 (enrich-company) |

## Gate Coverage — Where Each Check Runs

Every gate needs to be checked at EVERY place it matters. If a gate is missing,
bad data gets through. This table is the audit trail.

### Domain Blocklist (`isDomainBlocked` — Supabase `domain_blocklist` table)

| Trigger | Checks blocklist? | Consequence if missing |
|---------|-------------------|----------------------|
| normalize | YES | Blocked domains never enter pipeline |
| deal-sync | YES | Blocked domains skip deal enrichment |
| update-hubspot | YES | Blocked domains don't fire tier upgrade Slack alerts |
| enrich-contact | No — relies on normalize | OK: normalize already filtered |
| enrich-company | No — relies on normalize | OK: normalize already filtered |
| score-intent | No — scores everything | OK: scoring is internal, no external push |
| hubspot-enrich-new | NO — checks INTERNAL_DOMAINS only | GAP: backfill cron could enrich blocked domains |
| contact-backfill | NO | GAP: patches existing contacts at blocked domains |
| tam-enrich | Enterprise list only, not Supabase table | PARTIAL: hardcoded list, not dynamic |

### SLED Gate (`isSledSubMarket`)

| Trigger | Checks SLED? | Consequence if missing |
|---------|-------------|----------------------|
| enrich-company push gate | YES | Non-SLED companies don't reach HubSpot |
| enrich-contact push gate | YES | Non-SLED contacts don't reach HubSpot |
| update-hubspot tier alerts | YES | Non-SLED tier changes don't fire Slack |
| isMql (gates.ts) | YES | Non-SLED contacts can't be MQL |
| discover-contact | YES (via normalize) | Only discovers for SLED companies |
| score-intent | NO | Scores everything — correct, scoring is internal |

### MQL Gate (`isMql` from gates.ts)

| Check | Where | What it requires |
|-------|-------|-----------------|
| Buyer title | MQL_BUYER_PATTERNS regex | CEO, Founder, VP Sales, CRO, etc. |
| SLED sub_market | isSledSubMarket() | K12 EdTech SaaS, Higher Ed, Gov & Public Sector |
| Inbound | lead_type === "inbound" | Not TAM, not outbound |
| Hot/Warm tier | lead_tier | Must be hot or warm |
| Intent > 0 | Checked in enrich-contact, not in isMql() | Separate check at call site |

Fires in: `enrich-contact.ts` only. Sets `is_mql` on contact + `lifecyclestage=marketingqualifiedlead` in HubSpot + Slack alert (if push gate also passes).
