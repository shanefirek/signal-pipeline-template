---
name: enrich-on-demand
description: Resolve mystery contacts AND synthesize full deal context in one command. Cargo for raw enrichment + Claude for persona/deal synthesis. Updates HubSpot, surfaces in Slack.
status: design
owner: Shane
created: 2026-04-16
revised: 2026-04-16 (refactored from contact-only to deal-first)
---

# Enrich On Demand — Spec

## Goal

**By 2026-04-23**, AEs can paste a deal ID (or contact email) into Slack and get back a full deal brief + persona-level context for every contact in **under 30 seconds**, with HubSpot auto-updated.

Measured by: time from `/enrich-deal [id]` to formatted Slack reply with all contacts enriched + deal-level synthesis.

## Why this exists

**Real friction, validated today (Apr 16) with WQ Learning:**

Deal stalled 8 days. Mystery `user@example.com` CC'd starting Apr 2. RepA theorized "John is the real decision maker." Manual investigation: 3 minutes (LinkedIn + web search + HubSpot lookup). Result: John = CEO of WorldQuant Learning. Julie escalating for sign-off.

But knowing John's name isn't the actual unlock. **The unlock is knowing what to do about it.**

**What an AE needs in 30 seconds before opening a stalled deal:**
1. Who's on this deal (and who got added recently)
2. Who's the real decision maker vs the champion
3. What changed since last activity
4. What the deal context is (referral source, rejected scope, etc.)
5. What to do next

Today they get none of this without manual digging.

## Two motions

### Primary: `/enrich-deal [deal_id]`

Full deal brief. Synthesizes everything across all contacts.

### Secondary: `/enrich [email]`

Lightweight single-contact lookup. Used when:
- Mystery email shows up before there's a deal
- Quick "who is this" check
- Bulk enrichment isn't needed

Both share the same Cargo + Claude synthesis primitives.

## Scope

### In scope (Phase 1)

1. **Trigger.dev tasks:**
   - `enrich-deal` — primary motion
   - `enrich-contact` — secondary motion (called by deal-enrich for each contact)
2. **Cargo enrichment** — single API for "who is this person"
3. **Claude persona synthesis** — turns raw Cargo data into "how to approach this person"
4. **Claude deal synthesis** — combines all contacts + deal history into a brief
5. **HubSpot updates** — push contact enrichment + per-contact summaries
6. **Deal association** — link enriched mystery contacts to their deals
7. **Slack slash commands:**
   - `/enrich-deal [deal_id_or_url]`
   - `/enrich [email]`
8. **Slack output format** — clean Block Kit with all the synthesis

### Out of scope (Phase 2+)

- Auto-trigger on new HubSpot contact creation (background)
- Auto-trigger on deal stage changes
- Web search fallback for Cargo misses
- LinkedIn message draft generation
- LemList enrollment from deal-enrich output
- HubSpot button / web UI

## Specific deliverables

| Deliverable | File | LOC est |
|-------------|------|---------|
| Cargo `enrichPerson` fn | extend `src/enrichment/providers/cargo.ts` | +30 |
| Claude persona synthesis | `src/lib/persona-synthesis.ts` | ~80 |
| Claude deal synthesis | `src/lib/deal-synthesis.ts` | ~100 |
| `enrich-contact` task | `src/triggers/enrich-mystery-contact.ts` | ~120 |
| `enrich-deal` task | `src/triggers/enrich-deal.ts` | ~180 |
| HubSpot helpers (find deal by domain, associate, update contact summary) | extend `src/lib/hubspot.ts` | +50 |
| Slack message format (deal brief + contact card types) | extend `src/lib/slack.ts` | +120 |
| Slack slash command webhook handler | `src/triggers/slack-enrich-command.ts` | ~100 |

Total: ~780 LOC. No new dependencies.

## API contract

### `enrich-deal` task

**Input:**
```ts
{
  deal_id: string;              // HubSpot deal ID or full URL
  triggered_by_user?: string;   // Slack user ID
  force_refresh?: boolean;      // Re-synthesize even if recently done
}
```

**Output:**
```ts
{
  deal_id: string;
  deal_name: string;
  contacts: Array<{
    email: string;
    name: string;
    title: string;
    role_assessment: "decision_maker" | "champion" | "influencer" | "blocker" | "unknown";
    persona_summary: string;    // 2-3 sentences from Claude
    linkedin_url: string | null;
    enriched: boolean;
  }>;
  deal_brief: string;           // Multi-paragraph Claude synthesis
  suggested_next_step: string;  // One sentence, specific
  cargo_credits_used: number;
  duration_ms: number;
}
```

### Slack output (`/enrich-deal`)

```
🔍 Deal: WorldQuant Learning Julie Kelleher
   $7.5K · stage_0 · stalled 8 days · close date passed (Apr 15)

👥 Contacts on deal:

   ⭐ John Endrud — CEO @ WorldQuant Learning  (DECISION MAKER)
      linkedin.com/in/johnendrud · Denver, CO
      Joined Dec 2023, 25+ yrs higher ed leadership. Background in market
      strategy and partnerships — evaluates vendors strategically. CC pattern
      since Apr 2 indicates Julie is escalating for executive sign-off.

   🤝 Julie Kelleher — [unknown title]  (CHAMPION)
      Engaged since Mar 31. Operations or programs role likely.
      ⚠️ Title unknown — Cargo did not return a hit.

📋 Deal context:
Starbridge AE (Zac) touched this account before ACME. WQ went to Starbridge
directly, came back. Now silent. SOW sent twice without reply.

→ Suggested next step:
RepC founder-to-founder LinkedIn connect on Endrud. He is the gate.
Reference WorldQuant University's free-degree mission as the conversation hook.

Open in HubSpot · Cargo credits used: 1 · 12.4s
```

### Slack output (`/enrich [email]`)

Lighter — just the contact card from above plus "Already on deal X" link if applicable.

## Success metrics

Phase 1 ships when ALL of these are true:

| Metric | Target | How measured |
|--------|--------|--------------|
| `/enrich-deal` p95 latency | < 30 sec | task duration_ms |
| `/enrich [email]` p95 latency | < 15 sec | task duration_ms |
| Cargo hit rate | > 80% | (enriched contacts) / (total attempted) |
| HubSpot update success | > 99% | push_log table |
| Suggested next step rated useful | > 60% in week 1 | manual AE survey, 5 deals |
| AE adoption | 8+ uses across team in week 1 | Slack command logs |

If any target misses by >20%, no Phase 2 until fixed.

## Timeline (honest)

**Total: 5-8 hours, single sitting if uninterrupted.**

| Block | Hours | Deliverable |
|-------|-------|-------------|
| 1 | 0.5 | Cargo `enrichPerson` extracted from existing code |
| 2 | 1.0 | Claude persona synthesis prompt + function (test against John) |
| 3 | 1.5 | `enrich-deal` task: pull contacts, enrich each, synthesize |
| 4 | 1.0 | Claude deal synthesis prompt + function |
| 5 | 1.0 | HubSpot helpers + push contact summaries |
| 6 | 1.0 | Slack message format (deal brief block kit) |
| 7 | 1.5 | Slack slash command setup (the wildcard — could blow up) |
| 8 | 0.5 | Deploy + test on 3 real deals |

**Slack slash command is still the wildcard.** If you've never set one up, add 1-2 hours.

**Faster MVP path (skip Slack slash command):**

```bash
npx tsx scripts/enrich-deal.mts 318643221239
```

CLI script — outputs the brief to terminal. AE pings you, you run it, paste result. Half the time (3 hours), tests the whole synthesis pipeline. Slack command becomes Phase 1.5 once we know the synthesis is good.

## Non-goals (explicitly skip)

- ❌ Building a UI dashboard
- ❌ Caching enrichment results (Cargo is the cache)
- ❌ Multi-language
- ❌ Permission/rate limiting per AE
- ❌ Retry beyond Trigger.dev defaults
- ❌ Sentiment analysis on email threads (separate problem)
- ❌ Auto-drafting LinkedIn connect messages (Phase 2)
- ❌ Auto-enrolling enriched contacts into LemList (separate motion)

## Risks

| Risk | Mitigation |
|------|-----------|
| Cargo runs out of credits | Track in `push_log`. Alert at 500 remaining. ~2,842 estimated today. Deal-enrich uses ~1-3 credits per call. ~900 deals worth of headroom. |
| Claude generates generic synthesis | Prompt engineer with John/Julie example as gold standard. Iterate based on AE feedback in week 1. |
| Slack slash command setup is unknown territory | MVP via CLI first. Slack command after synthesis is validated. |
| Mystery contact at different domain than email (user@example.com → wqu.edu) | Use Cargo's `companyDomain` from output, not email-derived domain, for deal association lookup. |
| Cargo returns wrong John (common name) | Pass `firstName` from email + `companyDomain`. If multi-match, take highest LinkedIn followers + verified employment. |
| Personal emails (gmail) come through | Hard fail with: "Cannot enrich personal emails. Need work email." |
| Deal has 10+ contacts (rare but happens) | Cap at 8 contacts max. Sort by engagement recency, drop the rest. |
| Claude API hiccup | Already handle this — `maxRetries: 6` in summaries.ts. Reuse pattern. |

## Open decisions (need answer before code)

1. **Slack channel:** Reply in same channel where command was run, or always to a dedicated `#deal-enrichment` channel?
2. **Permissions:** Anyone in ACME Slack can run, or restrict to AE/admin?
3. **CLI-first or Slack-first:** Ship MVP via CLI then add Slack? Or block on Slack from day 1?
4. **Refresh policy:** If a deal was enriched <24h ago, return cached or re-synthesize?
5. **RepC/founder mention:** Should suggested_next_step ever name RepC specifically (e.g., for high-stakes founder plays)?

## Anti-busywork checks

Before building, verify each ✓:

- ✓ Solves a real, named problem (WQ Learning + John at minimum)
- ✓ Measurable time savings + deal velocity impact
- ✓ Single purpose — not a "platform"
- ✓ Reuses existing infra (Trigger.dev, Cargo, HubSpot lib, Claude SDK, Slack lib)
- ✓ MVP ships in one focused work block
- ✓ Specific success criteria evaluable in week 1
- ✓ AEs will use it (validated by today's friction + RepA's "who's John" question)

If any becomes false during build, kill it.

## Phase 2 triggers (only if Phase 1 hits metrics)

Earn the right to Phase 2 by AEs running `/enrich-deal` 10+ times in week 1 AND >60% finding the brief useful.

Then consider:
- Auto-fire on deal stage transitions (especially → stage_0 stalled, → presentation scheduled)
- LinkedIn connect message draft generation
- LemList enrollment for deal contacts who need warming
- "Why this deal stalled" automatic analysis from email engagement timeline
- Pattern detection across deals: "3 referral deals this month escalated to CEO — pattern?"

## Quick reference: LemList access (for Phase 2 planning)

Verified today — full Acme GTM team access:
- `cam_g3WzYQH9wGqbeDPsG` — LinkedIn Only Campaign (RepC) [paused]
- `cam_gHCXaNB3bqdN4f2qo` — EdTech Week [running]
- `cam_drenSnqFHM3PzAPAn` — RepA K-12 EdTech Outbound [draft]
- (4 other drafts)

Don't need to ask RepC for access. Need to decide which campaigns to use for which deal-state plays.
