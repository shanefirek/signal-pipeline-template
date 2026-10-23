# Attribution Map — What Gets Pushed Downstream

Every HubSpot property we write, by flow, with exact source and transformation.

Updated: Apr 22, 2026

---

## Tier Systems (two distinct models)

GTMOS uses two separate tier systems. They are NOT interchangeable.

### Contact tier: `contacts.tier` (hot / warm / cool / cold)

Computed by `computeTier()` in `src/scoring/intent.ts` from `icp_score + intent_score` (total_score):

| total_score | tier |
|---|---|
| >= 100 | hot |
| >= 60 | warm |
| >= 30 | cool |
| < 30 | cold |

Pushed to HubSpot as `lead_tier` (title-cased, "Cold" mapped to empty string) and `lead_temp` (title-cased, "Cool" mapped to "Cold"). Used by both signal and TAM flows.

### Company TAM tier: `companies.tam_tier` (T1 / T2 / T3 / DQ)

Computed by `tamTier()` in `src/scoring/tam-icp.ts` from `tam_icp_raw` (raw 0-175 score, NOT normalized):

| tam_icp_raw | tam_tier |
|---|---|
| >= 120 | T1 |
| >= 80 | T2 |
| >= 50 | T3 |
| < 50 | DQ |

Only set by `tam-enrich`. Not pushed to HubSpot directly, but mapped to `icp_tier` HubSpot enum via `toIcpTierValue()` in `hubspot.ts` (T1=priority, T2=strong_fit, T3=high_potential, DQ=review).

### Company lead_temp: `companies.lead_temp` (Hot / Warm / Cold)

Computed by `companyLeadTemp()` in `src/scoring/icp.ts` from total_score:

| total_score | lead_temp |
|---|---|
| >= 100 | Hot |
| >= 60 | Warm |
| < 60 | Cold |

Set by `update-hubspot.ts` after signal scoring. NOT set for TAM companies (see TAM handling section below).

---

## AE Owner Derivation

`deriveAeOwner()` in `src/lib/constants.ts` routes contacts by territory based on `sub_market`:

| sub_market | ae_owner | HubSpot owner ID |
|---|---|---|
| "K12 EdTech SaaS" | rep_a | 162280197 |
| "Higher Ed" | rep_b | 163458119 |
| "Government & Public Sector" | rep_b | 163458119 |
| (anything else) | null | (HubSpot Auto-Assign handles) |

Loose fallback matching also catches legacy values (e.g., "k12", "higher ed", "public sector" substrings).

Called in `enrich-contact.ts` after company lookup. If `ae_owner` is explicitly set in the payload (from `tam-activate`), that takes precedence. For outbound sources with no territory match, defaults to RepA.

Owner is set on contacts only, not companies. The `hubspot_owner_id` is resolved from `AE_OWNERS` map at push time.

---

## Company Properties (pushed via `pushCompanyToHubSpot`)

| HubSpot Property | Supabase Source | Signal Flow | TAM Flow | Transformation |
|---|---|---|---|---|
| `domain` | `companies.domain` | Always | Always | Lowercased, cleaned |
| `name` | `companies.name` | From LeadMagic | From LeadMagic | Raw |
| `linkedin_company_page` | `companies.linkedin_url` | From LeadMagic | From LeadMagic | Raw |
| `numberofemployees` | `companies.employee_count` | From LeadMagic | From LeadMagic | Cast to string |
| `sub_market` | `companies.sub_market` | Claude classifier | Claude classifier | Raw (e.g., "Higher Ed", "K12 EdTech SaaS") |
| `icp_score` | `companies.icp_score` | Formula: vertical+headcount+stage+outbound+funding (0-125) | Formula: 6-component (0-175 normalized to 0-125) | Cast to string |
| `intent_score` | `companies.intent_score` | 5-component formula (0-120) | N/A — always 0 | Cast to string |
| `lead_tier` | `companies.lead_tier` | Hot/Warm/Cool/Cold from ICP+intent | Stored in Supabase but pushed as-is | Raw |
| `lead_temp` | `companies.lead_temp` | Hot (>=100), Warm (>=60), Cold (<60) | **NOT pushed for TAM** — would trigger MQL/nurture workflows | Raw |
| `lead_origin` | `deriveLeadOrigin(lead_source)` | "Website Visitor" / "LinkedIn Engagement" | "TAM Outbound" | Derived from `lead_source` at push time |
| `total_score` | `icp_score + intent_score` | Combined score | Same as icp_score (intent=0) | Cast to string |
| `first_touch_source` | `companies.first_touch_source` | From Syft webhook | Empty (no signal) | Raw |
| `touch_channels` | `companies.touch_channels` | From Syft webhook | Empty | Raw |
| `touch_campaigns` | `companies.touch_campaigns` | From Syft webhook | Empty | Raw |
| `syft_intent` | `companies.syft_intent_level` | From Syft webhook | Empty | "very high" → "high" mapping |
| `matched_intents` | `companies.matched_intents` | From Syft webhook | Empty | Raw |
| `utm_medium` | `companies.utm_medium` | From Syft webhook | Empty | Raw |
| `latest_source` | `companies.latest_source` | From Syft webhook | Empty | Raw |
| `lead_summary` | `companies.lead_summary` | AI-generated (Sonnet 4.6) | AI-generated (Sonnet 4.6) | Quotes escaped |
| `sales_org_summary` | `companies.sales_org_summary` | From LLM classifier | From LLM classifier (real LeadMagic data) | Quotes escaped |
| `description` | `companies.description` | From LeadMagic | From LeadMagic | Raw |
| `city` | `companies.city` | From LeadMagic | From LeadMagic | Raw |
| `state` | `companies.state` | From LeadMagic | From LeadMagic | Raw |
| `country` | `companies.country` | From LeadMagic | From LeadMagic | Raw |
| `funding_stage` | `companies.funding_stage` | From LeadMagic | From LeadMagic | Mapped via `toHubSpotFundingStage()` |
| `annualrevenue` | `companies.annual_revenue` | Rarely populated | Rarely populated | Cast to number |
| `total_money_raised` | `companies.funding_total` | From LeadMagic | From LeadMagic | Cast to string |
| `icp_tier` | `toIcpTierValue(tam_tier, icp_score)` | priority/strong_fit/high_potential/review | Same | Enum mapping |

### What TAM companies are MISSING vs signal companies
- `lead_temp` — deliberately omitted (would trigger MQL/nurture workflows)
- `first_touch_source`, `touch_channels`, `touch_campaigns` — no inbound signal exists
- `syft_intent`, `matched_intents` — no Syft data
- `utm_medium`, `latest_source` — no attribution trail
- `intent_score` — always 0 (no behavioral signal)

---

## Contact Properties (pushed via `createHubSpotContact`)

| HubSpot Property | Supabase Source | Signal Flow | TAM Flow | Transformation |
|---|---|---|---|---|
| `email` | `contacts.email` | From email waterfall (Findymail + LeadMagic) | Same | Required field |
| `firstname` | `contacts.first_name` | From Cargo/LeadMagic | Same | Raw |
| `lastname` | `contacts.last_name` | From Cargo/LeadMagic | Same | Raw |
| `jobtitle` | `contacts.title` | From Cargo/LeadMagic | Same | Raw |
| `company` | `companies.name` | Company name (not domain) | Same | Quotes escaped |
| `hs_linkedin_url` | `contacts.linkedin_url` | From Cargo/LeadMagic | Same | Raw |
| `lead_tier` | `contacts.tier` | Hot/Warm/Cool → Cold="" | **Skipped for outbound sources** (not set) | "Cold" → empty string |
| `lead_temp` | `contacts.tier` | Hot/Warm/Cool/Cold | **Skipped for outbound sources** (not set) | "Cool" → "Cold", defaults to "Cold" |
| `lead_origin` | `deriveLeadOrigin(lead_source)` | "Website Visitor" / "LinkedIn Engagement" | "TAM Outbound" | Derived at push time |
| `lead_type` | `deriveLeadType(lead_source)` | "inbound" | "outbound" | Derived at push time |
| `clay_lead_source` | `contacts.lead_source` | syft_website / syft_linkedin / company_discovery | tam_import | Raw |
| `signal_type` | `getSignalType(lead_source)` | "Company Intent" / "LinkedIn Engagement" | **null** (not set) | Returns null for TAM — property omitted |
| `total_score` | `icp_score + intent_score` | Combined | ICP only (intent=0) | Cast to string |
| `icp_score` | `contacts.icp_score` | From company lookup | Same | Cast to string |
| `intent_score` | `contacts.intent_score` | From signals table (max) | 0 | Cast to string |
| `lead_summary` | `contacts.lead_summary` | AI-generated contact brief | Same | Quotes escaped |
| `sales_org_summary` | `companies.sales_org_summary` | From company record | Same | Quotes escaped |
| `sub_market` | `companies.sub_market` | From company record | Same | Raw |
| `city` | `companies.city` | From company record | Same | Raw |
| `state` | `companies.state` | From company record | Same | Raw |
| `first_touch_channel` | `companies.first_touch_source` | From Syft | Empty for TAM | Raw |
| `utm_source` | `companies.utm_sources` | From Syft | Empty for TAM | Raw |
| `utm_medium` | `companies.utm_medium` | From Syft | Empty for TAM | Raw |
| `utm_campaign` | `companies.touch_campaigns` | From Syft | Empty for TAM | Raw |
| `phone` | `contacts.phone` | From LeadMagic phone lookup | Same | Raw |
| `signal_date` | `signals.created_at` | Latest signal with activity data | Empty for TAM | `toHubSpotDate()` → midnight UTC epoch ms |
| `signal_pages_visited` | `signals.session_pages_visited` | From latest signal | Empty for TAM | Raw (comma-separated URLs) |
| `signal_sessions` | `signals.sessions` | From latest signal | Empty for TAM | Cast to string |
| `signal_time_on_site` | `signals.active_time_seconds` | From latest signal | Empty for TAM | Cast to string |
| `hubspot_owner_id` | Set at push time | Territory-routed via `deriveAeOwner(sub_market)`, or HubSpot auto-assign | **Set to AE owner (RepB/RepA)** via `AE_OWNERS` map | Bypasses auto-assign workflow |
| `lifecyclestage` | Set at push time | MQL → "marketingqualifiedlead", else undefined (HubSpot default) | **"lead"** — bypasses MQL Progression workflow | Conditional on `isMQL()` |
| `icp_tier` | `toIcpTierValue(tam_tier, icp_score)` | priority/strong_fit/high_potential/review | Same | Enum mapping |

### What TAM contacts are MISSING vs signal contacts
- `signal_type` — null (intentional, TAM is not a signal)
- `lead_tier` and `lead_temp` — skipped for outbound sources. Prevents MQL Progression + Cold Lead Nurture workflows from firing on cold outbound contacts.
- `first_touch_channel`, `utm_source`, `utm_medium`, `utm_campaign` — no inbound attribution
- `signal_date`, `signal_pages_visited`, `signal_sessions`, `signal_time_on_site` — no behavioral signal data
- `intent_score` — always 0

### TAM Contact Gate Bypass (current state)

`src/lib/gates.ts:308` has a `tam_import` bypass in `passesContactPushGateWithReason()`. TAM contacts pass the contact push gate with zero intent as long as ICP >= 50 and SLED market, bypassing the hot/warm tier requirement that applies to signal contacts.

This caused 152 zero-intent contacts (95 RepA + 57 unowned) to land in HubSpot with nothing actionable. Cleaned out Apr 22.

The bypass is intentional for now: `tam-enrich` and `tam-activate` have no cron and are manual trigger only. The next TAM batch will hit the same issue. Architectural redesign (isolating TAM into its own workflow, separate from the signal pipeline) is tracked in `open-threads.md` under "TAM Contact Gate Bypass".

---

## Contact Properties (pushed via `updateHubSpotContact`)

Same as create EXCEPT:
- **UTMs are NEVER overwritten** on update (G14 fix — Syft owns these on existing contacts)
- `lead_origin` is always re-derived (overwrites with current source)
- `hs_linkedin_url` added to update path Apr 8 (was missing, legacy contacts never got LinkedIn URLs)
- **Signal attribution fields** (`signal_date`, `signal_pages_visited`, `signal_sessions`, `signal_time_on_site`) are pushed on score updates via `update-hubspot.ts`, so existing contacts get fresh signal data when they return
- **Lead summary** is regenerated on score updates when fresh signal data exists

---

## Enum Values That Trigger Workflows

| Property | Values | What triggers |
|---|---|---|
| `lead_temp` | "Hot" | MQL Progression (→ MQL lifecycle) + Hot Lead Slack Alert |
| `lead_temp` | "Warm" | MQL Progression (→ MQL lifecycle) |
| `lead_temp` | "Cold" | Cold Lead Nurture (→ Lead lifecycle + Nurture status) |
| `lifecyclestage` | "marketingqualifiedlead" | MQL Auto-Assign → RepA (unconditional, no territory filter) |
| `lead_tier` | "Hot" / "Warm" / "Cool" / "" | No workflow triggers (used for views/filters only) |
| `lead_origin` | Any value | **No workflow filters on this** (Apr 10 audit confirmed) |
| `signal_type` | "Company Intent" / "LinkedIn Engagement" / "Deal Created" | No workflow triggers (used for views/filters only) |
| `lead_type` | "inbound" / "outbound" / "referral" / "unknown" | No workflow triggers yet — intended for workflow rework (see `open-threads.md`) |

---

## MQL Determination

GTMOS owns MQL logic, not HubSpot workflows. `isMQL()` in `src/lib/constants.ts`:

1. Lead must be **inbound** (`deriveLeadType()` returns "inbound" for syft_website, syft_linkedin, fibbler_engagement, company_discovery, posthog_identify)
2. Lead must be **hot or warm** tier (`computeTier(total_score)`)

TAM outbound, departed contacts, HubSpot backfill, and referrals are NEVER MQLs regardless of score.

When MQL is true:
- `is_mql = true` + `mql_at = now()` written to Supabase
- `lifecyclestage = "marketingqualifiedlead"` pushed to HubSpot
- Slack alert fires (currently disabled — webhook hard-null'd)

---

## RepB's "Before the Call" Checklist — Data Coverage

| Field RepB wants | HubSpot property | Populated for TAM? | Gap |
|---|---|---|---|
| Funding stage | `funding_stage` | Yes (from LeadMagic) | None |
| Employee count | `numberofemployees` | Yes | None |
| Outbound motion visible? | `sales_org_summary` | Yes (human-readable: "3 AEs, no SDRs") | None — read the field |
| Vertical | `sub_market` | Yes | None |
| Lead source | `lead_origin` | Yes ("TAM Outbound") | None |
| Contact tier (DM/Influencer/Champion) | **Does not exist** | No | Tracked in `open-threads.md` under "AE Attribution Gaps" |
| Role confirmed on LinkedIn | **Does not exist** | No | Cargo verifies employment but no HubSpot property surfaces this. Tracked in `open-threads.md` under "AE Attribution Gaps" |

---

## lead_origin Values (complete list)

| lead_source (Supabase) | lead_origin (HubSpot) | When |
|---|---|---|
| `syft_website` | "Website Visitor" | Syft website visitor webhook |
| `syft_linkedin` | "LinkedIn Engagement" | Syft LinkedIn activity webhook |
| `tam_import` | "TAM Outbound" | TAM enrichment + activate |
| `salesnav_import` | "Sales Nav" | RepB's Sales Nav imports |
| `starbridge_referral` | "Starbridge Referral" | Phase 5 |
| `hubspot_backfill` | "HubSpot Backfill" | Legacy CRM records |
| `hubspot_deal_created` | "Deal Created" | Deal sync |
| `company_discovery` | "Company Discovery" | Prospector-found contacts |
| `fibbler_engagement` | "LinkedIn Ad Engagement" | Fibbler attribution sync — **DISABLED** (cron off Apr 21, was overwriting real attribution with zeros) |
| `departed_follow` | "Departed Follow" | Contact followed to new company after departure detected |
| `departed_backfill` | "Departed Backfill" | Backfill of contacts flagged as departed |
| (default) | "V2 Enriched" | Fallback for any unrecognized lead_source |

---

## Fibbler — DISABLED (Apr 21, 2026)

Fibbler sync cron disabled Apr 21. Not running LinkedIn ads. Fibbler zero-data signals were overwriting real website attribution in the signals table. `fibbler_engagement` lead_source still exists in `deriveLeadOrigin()` and `getSignalType()` for historical records, but no new Fibbler signals are being created. Re-enable when LinkedIn ads resume.

Signal scoring query in `enrich-contact.ts` and `update-hubspot.ts` filters to signals with `page_views > 0 OR sessions > 0 OR linkedin_action IS NOT NULL`, which prevents empty Fibbler rows from overwriting real attribution even if stale rows remain.

---

## TAM Flow Summary

1. **`tam-enrich`** — LeadMagic company enrichment + TAM ICP scoring. Writes to `companies` table only. No HubSpot push. No contact discovery. Manual trigger only (no cron).
2. **`tam-activate`** — Reads enriched company from Supabase, pushes company to HubSpot (skips `lead_temp`), then triggers `discover-contact` with `lead_source: "tam_import"` and `lead_type: "outbound"`.
3. **`discover-contact`** → **`enrich-contact`** — Cargo finds stakeholders, email waterfall runs, contact pushed to HubSpot with `lead_tier`/`lead_temp` **skipped** for outbound sources, `lifecyclestage: "lead"`, and `hubspot_owner_id` set to the AE.
4. Contact push gate bypass at `gates.ts:308` lets `tam_import` contacts through without hot/warm tier. This is the known architectural issue tracked in `open-threads.md`.
