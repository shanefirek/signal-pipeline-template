> **⚠️ ARCHIVED — superseded by [`architecture.md`](architecture.md) on 2026-04-20.**
>
> Pre-dates the HubSpot deal pipeline / SLED gate / Cargo-first rule. Kept for diagram reference only.

---

# Signal Pipeline — Growth Operating System

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ██████╗ ████████╗███╗   ███╗ ██████╗ ███████╗    ██╗   ██╗██████╗          ║
║  ██╔════╝ ╚══██╔══╝████╗ ████║██╔═══██╗██╔════╝    ██║   ██║╚════██╗         ║
║  ██║  ███╗   ██║   ██╔████╔██║██║   ██║███████╗    ██║   ██║ █████╔╝         ║
║  ██║   ██║   ██║   ██║╚██╔╝██║██║   ██║╚════██║    ╚██╗ ██╔╝██╔═══╝          ║
║  ╚██████╔╝   ██║   ██║ ╚═╝ ██║╚██████╔╝███████║     ╚████╔╝ ███████╗         ║
║   ╚═════╝    ╚═╝   ╚═╝     ╚═╝ ╚═════╝ ╚══════╝      ╚═══╝  ╚══════╝         ║
║                                                                               ║
║                    TAM → Target → Growth Operating System                     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## The Pipeline

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                              SIGNAL SOURCES                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

     🌐 WEBSITE                 💼 LINKEDIN                  📋 TAM LIST
    ━━━━━━━━━━━                ━━━━━━━━━━━━                 ━━━━━━━━━━━
    Anonymous visitor          RepC's engagement           AE's target list
    from Company X             (likes, comments,            (curated prospects)
                               follows, views)
          │                          │                            │
          │                          │                            │
          ▼                          ▼                            ▼
    ┌───────────┐              ┌───────────┐               ┌───────────┐
    │syft_website│             │syft_linkedin│              │ tam_import │
    └─────┬─────┘              └─────┬─────┘               └─────┬─────┘
          │                          │                            │
          └──────────────────────────┼────────────────────────────┘
                                     │
                                     ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                              INTAKE & VALIDATION                              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

                              ┌─────────────────┐
                              │  📡 NORMALIZE   │
                              │                 │
                              │  • Valid domain?│
                              │  • Not .edu?    │
                              │  • Not internal?│
                              └────────┬────────┘
                                       │
                            ┌──────────┴──────────┐
                            │                     │
                         ❌ DROP               ✅ PASS
                       (.edu, .gov,               │
                        internal)                 │
                                                  ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                              COMPANY ENRICHMENT                               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

                              ┌─────────────────┐
                              │ 🏢 ENRICH CO    │
                              │                 │
                              │  LeadMagic      │
                              │  + Octave AI    │
                              └────────┬────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │           ICP SCORING               │
                    │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
                    │  Employee Count    ████████░░  25  │
                    │  Sub-Market Fit    ███████████ 35  │
                    │  Funding Stage     █████░░░░░  15  │
                    │  Octave Analysis   ████████░░  25  │
                    │  ─────────────────────────────────  │
                    │  TOTAL                        100  │
                    └─────────────────┬───────────────────┘
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                      ICP < 50              ICP >= 50
                      or !SLED              + SLED vertical
                           │                     │
                           ▼                     ▼
                     ❌ SUPABASE            ✅ CONTINUE
                        ONLY                     │
                                                 │
                                                 ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                              CONTACT DISCOVERY                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

                              ┌─────────────────┐
                              │ 🔍 DISCOVER     │
                              │                 │
                              │  LeadMagic      │
                              │  Employee Search│
                              └────────┬────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │         TITLE ALLOWLIST             │
                    │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
                    │  ✅ CEO, Founder, President        │
                    │  ✅ CRO, VP Sales, Head of Sales   │
                    │  ✅ Sales Director, COO            │
                    │  ❌ CTO, CFO, CMO (not buyers)     │
                    │  ❌ Marketing, Engineering, HR     │
                    │  ❌ SDR, BDR, AE (we sell to them) │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                              CONTACT ENRICHMENT                               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

                              ┌─────────────────┐
                              │ 📧 ENRICH       │
                              │                 │
                              │  Cargo Verify   │
                              │  Email Waterfall│
                              │  Phone Lookup   │
                              └────────┬────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │           QUALITY GATES             │
                    │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
                    │  ☑️  Has verified email            │
                    │  ☑️  Buyer title (allowlist)       │
                    │  ☑️  SLED sub-market only          │
                    │  ☑️  US or Canada                  │
                    │  ☑️  Still employed (Cargo)        │
                    │  ☑️  Not already in HubSpot        │
                    └─────────────────┬───────────────────┘
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                      GATE FAIL             GATE PASS
                           │                     │
                           ▼                     ▼
                     ❌ SUPABASE            ✅ HUBSPOT
                        ONLY                     │
                                                 │
                                                 ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                  OUTPUTS                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

                              ┌─────────────────┐
                              │ 🎯 HUBSPOT      │
                              │                 │
                              │  Company +      │
                              │  Contact Created│
                              └────────┬────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │            MQL CHECK                │
                    │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
                    │  Inbound?        ✅                 │
                    │  Hot or Warm?    ✅                 │
                    │  Buyer title?    ✅                 │
                    │  SLED vertical?  ✅                 │
                    │  ─────────────────────────────────  │
                    │  = MQL ✅                           │
                    └─────────────────┬───────────────────┘
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                       NOT MQL                  MQL
                           │                     │
                           ▼                     ▼
                    ┌───────────┐         ┌───────────┐
                    │  Stays in │         │ 🔔 SLACK  │
                    │  HubSpot  │         │   ALERT   │
                    │  (nurture)│         └─────┬─────┘
                    └───────────┘               │
                                                ▼
                                         ┌───────────┐
                                         │ 📬 LEMLIST│
                                         │  SEQUENCE │
                                         └─────┬─────┘
                                               │
                                               ▼
                                         ┌───────────┐
                                         │ 📞 AE     │
                                         │   CALLS   │
                                         └───────────┘
```

---

## Scoring Matrix

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ICP SCORE (Company Fit)              INTENT SCORE (Buying Signals)        │
│   ━━━━━━━━━━━━━━━━━━━━━━              ━━━━━━━━━━━━━━━━━━━━━━━━━━           │
│                                                                             │
│   Employees (10-100)     +25           Page Views        +30 max            │
│   K12 EdTech            +35           Session Depth     +20 max            │
│   Higher Ed             +30           LinkedIn Action   +25 max            │
│   Government            +20           Recency Bonus     +15 max            │
│   Series A-B            +15           ────────────────────────              │
│   Octave AI Score       +25           Decays 50% after 7 days              │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   COMBINED SCORE = ICP + INTENT                                             │
│                                                                             │
│   🔥 HOT    130+ or (Intent 50+ AND ICP 60+)                               │
│   🟡 WARM   100-129                                                         │
│   🔵 COOL   70-99                                                           │
│   ⚪ COLD   <70                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## AE Territories

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────┐         ┌─────────────────────────┐          │
│   │                         │         │                         │          │
│   │   🎓 REP_A               │         │   🏛️ REP_B                │          │
│   │   K-12 EdTech           │         │   Higher Ed             │          │
│   │                         │         │   Government            │          │
│   │   • Branching Minds     │         │   • Yellowdig           │          │
│   │   • TCI                 │         │   • Novo Solutions      │          │
│   │   • Learning W/O Tears  │         │   • EduNav              │          │
│   │   • Hometown Ticketing  │         │   • Expert TA           │          │
│   │                         │         │                         │          │
│   └─────────────────────────┘         └─────────────────────────┘          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│    SYFT     │  │  TRIGGER    │  │  SUPABASE   │  │  HUBSPOT    │
│   Signals   │─▶│    .DEV     │─▶│  Database   │─▶│    CRM      │
│             │  │ Orchestration│  │             │  │             │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │ LEADMAGIC │  │   CARGO   │  │  OCTAVE   │
   │  Company  │  │  Verify   │  │    AI     │
   │  + Email  │  │Employment │  │Qualification│
   └───────────┘  └───────────┘  └───────────┘
```

---

## Status

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ✅ WORKING                          ⏳ NEEDS CONFIG                       │
│   ━━━━━━━━━━                          ━━━━━━━━━━━━━━                       │
│   • Syft intake                       • Slack alerts (need webhook)        │
│   • Company enrichment                • LemList (need API key)             │
│   • Contact discovery                                                       │
│   • Cargo verification                                                      │
│   • Title allowlist                   🔮 FUTURE                             │
│   • SLED + Geo gates                  ━━━━━━━━                              │
│   • HubSpot push                      • Octave EMAIL agent                 │
│   • Deal sync                         • RepB's LemList campaign             │
│   • MQL logic                         • Call prep AI                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
