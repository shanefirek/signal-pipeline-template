# ACME Cold Email System — Proposal

**Status:** Design / pre-implementation
**Date:** 2026-04-16
**Owner:** Shane
**Audience:** RepC, RepA, RepB, SDR (incoming)

---

## What this is

A proposed system to take qualified MQLs from our pipeline (GTMOS) and produce sequenced cold email campaigns at scale, ready to send via LemList or HubSpot Sequences.

The system is built from three pieces we already have, plus one new repo to glue them together.

---

## The four components

### 1. GTMOS (existing — `~/projects/acme-gtmos-v2/`)
**The pipeline. Identifies who.**

Already does:
- Pulls Syft signals (website + LinkedIn) and Fibbler engagement
- Enriches with LeadMagic, Cargo, Claude
- Scores ICP + intent
- Detects MQLs (inbound + qualified tier + SLED vertical)
- Routes to AE by territory (RepA=K12, RepB=Higher Ed/Gov)
- Pushes to HubSpot
- Fires Slack alerts

Produces, for every contact: name, title, company, sub_market, lead_summary, sales_team_data, intent_score, tier, AE owner.

### 2. Cold Email Agent (built by Kai — proposed new repo `~/projects/acme-cold-email/`)
**The writer. Decides what to say.**

Built on Claude Code's agent framework (`agent.md` + `lint.py`).

Pipeline:
1. Context loading (reads ACME's messaging house)
2. Name normalization (full legal names → short names: "USD Foundation" not "University of South Dakota Foundation & Alumni Association")
3. Micro-segmentation by *situation*, not title
4. Pre-writing per segment (situation, primary objection, best offer)
5. Copy generation (3-email sequence: Hook → Offer → Redirect)
6. Lint check (zero em dashes, no "we"/"I" openers, no time-asks in E1, etc.)
7. Output CSV

Strict aesthetic principles (Kai's rules):
- E1 is 3 sentences. Situation → shift → ask.
- E1 doesn't mention ACME in body — only signature.
- E2 leads with value (sample, stat, or diagnostic question — varied across segments).
- E3 acknowledges silence with dignity. Opt-out, redirect, door-open, or warm close.
- Subject lines lowercase, name the prospect's challenge (not our product).
- E2/E3 use `re:` threading.

### 3. ACME Messaging House (existing — `~/projects/acme-octave/`)
**The voice. Knows ACME's positioning.**

Already contains the full Octave workspace dump (`data/acme-workspace-2026-04-10.json`):
- 4 products: K12 SDR Services, GTM OS, GTM OS for Portfolio, PE Due Diligence
- 10 personas: VP Sales, CRO, RevOps, Sales Dev Manager, IT Decision Maker, etc.
- 4 segments: K-12 Pipeline-Driven, K-12 Growth Sales, K-12 Solution Providers, PE-Backed K-12
- 5 playbooks (outreach angles)
- 3 reference customers (proof points)

Each entry has rich text on pain points, capabilities, differentiated value, customer benefits, buying triggers. This is *exactly* what Kai's agent needs in `context/`.

**One-time work:** convert the JSON dump to markdown files in the new repo's `context/` folder. ~30 min of code.

### 4. LemList (existing integration — `src/lib/lemlist.ts`)
**The deliverer. Sends the emails.**

Already partially integrated in GTMOS. `enrollInCampaign()` function exists. Needs extension to consume the agent's output CSV format.

---

## The flow

```
[Syft signal / Fibbler engagement / form fill]
              ↓
         [GTMOS enriches]
              ↓
        [MQL fires + Slack alert to AE]
              ↓
       [Export CSV from GTMOS]
              ↓
       [Cold email agent runs]
              ↓
   [Output CSV with E1/E2/E3 per prospect]
              ↓
        [Push to LemList]
              ↓
   [Sequence sent — E1 day 1, E2 day 4, E3 day 9]
              ↓
       [Replies → HubSpot]
```

---

## Proposed repo structure

```
~/projects/
├── acme-gtmos-v2/                  ← existing pipeline
│   └── scripts/
│       └── export-for-cold-email.mts   ← TODO: query Supabase, write CSV
│
├── acme-cold-email/                ← NEW repo
│   ├── agent.md                   ← Kai's agent definition
│   ├── lint.py                    ← Quality enforcement
│   ├── examples/
│   │   └── ANNOTATED_EXAMPLES.md  ← Kai's reference examples
│   ├── context/                   ← ACME messaging house (from acme-octave)
│   │   ├── products/
│   │   │   ├── k12-sdr-services.md
│   │   │   ├── gtm-os.md
│   │   │   ├── gtm-os-portfolio.md
│   │   │   └── pe-due-diligence.md
│   │   ├── personas/              ← 10 persona files
│   │   ├── segments/              ← 4 segment files
│   │   ├── playbooks/             ← 5 angle files
│   │   └── references/            ← proof-points.md
│   ├── inputs/                    ← CSV exports from GTMOS land here
│   └── outputs/                   ← Generated sequences
│
└── acme-octave/                    ← existing source of messaging
    └── data/
        └── acme-workspace-2026-04-10.json
```

---

## Sample dry run — Dee Bohne at SchoolAI

Pulled from real GTMOS data.

### Input
- **Dionne 'Dee' Bohne** — Vice President of Sales - Higher Education
- **SchoolAI** — K-12 EdTech SaaS, Series A $25M, 1,279 employees, Lehi UT
- Hot tier, ICP 87, intent 55
- Sales org: 0 AEs, 0 SDRs, no active hiring

### Segment (of 1)
"VP-level sales leader building a new function (Higher Ed) at a fast-growing K-12 EdTech with no existing sales team"

### Pre-writing
1. **Situation:** Dee was hired to lead Higher Ed sales at SchoolAI but has no SDRs feeding her pipeline yet.
2. **Hell-no objection:** "We're product-led, our growth comes from teacher adoption, we don't need outbound."
3. **Best offer:** A look at how other K-12 EdTech companies expanded into Higher Ed and what their early outbound playbook looked like.
4. **Register:** Consultative (senior buyer)
5. **CTA approach:** Peer-to-peer "swap notes" — never a time ask in E1.

### Generated sequence

**E1 — `building higher ed pipeline at schoolai`**

> Dee, when you're standing up a new sales function at a K-12 company expanding into higher ed, the part that usually breaks first is having someone consistently feeding qualified meetings while you're getting the motion right.
>
> Some EdTech companies have figured out how to ramp outbound to higher ed institutions in 60 days without hiring SDRs internally first. Curious how you're thinking about it.
>
> RepA [Last]
> K12 AE, Acme GTM

**E2 — `re: building higher ed pipeline at schoolai`**

> Dee, would it help to see what the first 90 days of higher ed pipeline looks like for an EdTech expanding from K-12? I can share a quick playbook that walks through the institutional buying patterns and the specific titles to lead with at universities.
>
> It's the kind of thing that's useful whether or not we ever work together.

**E3 — `re: building higher ed pipeline at schoolai`**

> Dee, last note. If higher ed expansion is more on the back burner for now, no response needed.
>
> If someone else at SchoolAI is leading the institutional sales build, happy to be pointed their way.

### Lint pass
- ✓ No "we" / "I" openers
- ✓ No em dashes
- ✓ No time commitment in E1
- ✓ Brand only in signature
- ✓ "Some EdTech companies" not "70+ on Acme GTM"
- ✓ E2 is sample offer, E3 is opt-out + redirect (varied angles)
- ✓ E2/E3 no signature, threaded with `re:`
- ✓ Subject names her challenge (higher ed pipeline), not ACME's product

### Edge case caught
Dee is Higher Ed–focused but our system routed her to RepA because SchoolAI is K-12. Real-world finding: routing should consider title + company together, not just company sub_market. Easy fix.

---

## LemList delivery — how it actually works

1. **Agent output CSV** has columns:
   - Email, First Name, Last Name, Title, Employer
   - Tier, Segment, Sub-Market
   - E1_Subject, E1_Body, E2_Subject, E2_Body, E3_Subject, E3_Body

2. **GTMOS pushes to LemList** via `enrollInCampaign()`:
   - Creates / uses existing campaign per AE territory
   - Adds each prospect with custom variables for E1/E2/E3 content
   - LemList sends on schedule (configurable: E1 day 1, E2 day 4, E3 day 9)

3. **Replies route back to HubSpot** via LemList webhook:
   - Creates engagement on the contact
   - Updates `lead_status` to "Replied"
   - Triggers AE notification

---

## Implementation phases

### Phase 1: Manual proof (this week)
- [ ] Scaffold `acme-cold-email/` repo
- [ ] Write JSON → markdown converter (`acme-octave/data/*.json` → `acme-cold-email/context/*.md`)
- [ ] Hand-pick 20 SLED MQLs, export from Supabase manually
- [ ] Run agent, review output as a team
- [ ] Hand-deliver CSV to AE for review (don't send yet)

### Phase 2: SDR-driven (week of SDR start, ~2 weeks out)
- [ ] Build export script in GTMOS: `scripts/export-for-cold-email.mts`
- [ ] SDR runs the agent themselves
- [ ] SDR loads output into LemList
- [ ] Iterate copy with AE feedback

### Phase 3: Triggered (week 3+)
- [ ] SLED MQL → auto-export → notification to SDR with link to generated CSV
- [ ] Or weekly cron exports the queue Monday morning
- [ ] Eventually: auto-load to LemList without human in the loop

---

## What's missing / open questions

1. **Routing edge case:** Should `deriveAeOwner()` consider contact title (e.g., "Higher Ed VP" → RepB even if company is K-12)?
2. **LemList vs HubSpot Sequences:** LemList = better cold email tooling. HubSpot Sequences = AE already lives there. Need to decide which becomes the default.
3. **Reply handling:** When a prospect replies, AE needs to be alerted in real-time. Currently LemList handles this via webhook → HubSpot.
4. **Sender variation:** Should we send from RepC for senior buyers (CRO/VP Sales) and RepA/RepB for mid-level (Director)?
5. **Sequence variation:** Should each playbook have its own LemList campaign, or one campaign with custom variables?

---

## Why this is the right approach

- **Reuses existing infra.** GTMOS produces the data, acme-octave has the messaging, LemList delivers. We're connecting pieces, not building new ones.
- **Keeps concerns separated.** GTMOS = data ops. Cold email agent = content. LemList = delivery. Each can iterate independently.
- **Quality gate before scale.** The agent's lint enforces craft. SDR can't push spammy copy by accident.
- **AE gets time back.** Right now RepA/RepB would have to write every sequence. Agent does the first 80%, human reviews.
- **Testable.** We can dry-run on 1 contact today (already did, see Dee above), then 20, then full automation.
