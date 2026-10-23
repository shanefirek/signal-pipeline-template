# Data Flow: Inputs → Outputs

> All lead_source values, signal types, and classifications are defined by us in `src/lib/constants.ts`.

---

## Lead Sources (we define these)

| lead_source | Origin | Who sets it | lead_type | signal_type | lead_origin (HubSpot) |
|-------------|--------|-------------|-----------|-------------|----------------------|
| `syft_website` | Syft webhook — website visitor | syft-webhook.ts | inbound | Company Intent | Website Visitor |
| `syft_linkedin` | Syft webhook — RepC's LinkedIn engagement | syft-webhook.ts | inbound | LinkedIn Engagement | LinkedIn Engagement |
| `company_discovery` | We found contact at an intent company | discover-contact.ts | inbound | Company Intent | Company Discovery |
| `fibbler_engagement` | Fibbler ad engagement sync | fibbler-sync.ts | inbound | LinkedIn Engagement | LinkedIn Ad Engagement |
| `posthog_identify` | PostHog identified visitor | posthog-identify.ts | inbound | - | V2 Enriched |
| `tam_import` | TAM list import (RepB/RepA sheets) | tam-activate.ts | outbound | null | TAM Outbound |
| `departed_follow` | Re-discovery after contact departed | discover-contact.ts | outbound | null | Departed Follow |
| `departed_backfill` | Backfill after Cargo found departed | scripts | outbound | null | Departed Backfill |
| `salesnav_import` | Sales Navigator import | manual | referral | null | Sales Nav |
| `starbridge_referral` | Starbridge partner referral | manual | referral | null | Starbridge Referral |
| `hubspot_deal_created` | HubSpot deal trigger | deal-sync.ts | inbound | Deal Created | Deal Created |
| `hubspot_backfill` | Existing HubSpot contact refresh | scripts | unknown | null | HubSpot Backfill |

---

## Input Sources

### 1. Syft Webhooks

**Two motions, two webhooks:**

| Motion | Trigger | What we get |
|--------|---------|-------------|
| Website | Anonymous visitor from Company X hits acmegtm.com | Company domain, page_views, session_pages_visited, utm_channel, syft_purchase_intent |
| LinkedIn | Person engages with RepC's LinkedIn | Person's name/email/company, linkedin_action (Profile View, New Follower, Connection Request, Like, Comment) |

**Syft payload structure:**
```
account: { domain, name, pageViews, sessions, timeSpent, ... }
lead: { firstName, lastName, email, title, linkedinUrl, pageViews, ... }
linkedin: { action, intent, post_url, post_id, timestamp, syft_purchase_intent }
```

**Key distinction:**
- Website: `account.pageViews > 0`, `lead.pageViews = 0` (lead is best-guess, didn't visit)
- LinkedIn: `linkedin.action` populated, `account.pageViews = 0`

### 2. Fibbler (via HubSpot)

LinkedIn ad engagement data synced from HubSpot company properties:
- fibbler_clicks
- fibbler_impressions
- fibbler_engagement_level (VERY_HIGH, HIGH, MEDIUM, LOW)
- fibbler_organic_engagements

### 3. TAM Imports

Manual spreadsheet imports (RepB's Higher Ed list, RepA's K12 list):
- Company domain
- Contact name/title/LinkedIn
- Pre-curated by AE

### 4. HubSpot Deals

Deal-sync pulls new deals hourly:
- Associated company domain
- Deal stage, amount
- Sets tier=Hot on associated contacts

---

## Processing Flow

```
INBOUND PATH:
Syft webhook → raw_signals → normalize → enrich-company → discover-contact → enrich-contact → HubSpot
                                              ↓
                                        (ICP scoring)
                                              ↓
                                    If passes discovery gate:
                                    ICP >= 50, vertical > 0, < 500 emp
                                              ↓
                                    Find best contact (LeadMagic)
                                              ↓
                                    lead_source = "company_discovery"

OUTBOUND PATH:
TAM sheet → tam-activate.ts → enrich-company → enrich-contact → HubSpot
                                                      ↓
                                          lead_source = "tam_import"
```

---

## Output Classifications

### Lead Type (we derive in constants.ts)

| lead_type | Meaning | Sources |
|-----------|---------|---------|
| `inbound` | They came to us (signal-driven) | syft_website, syft_linkedin, company_discovery, fibbler_engagement, posthog_identify |
| `outbound` | We reached out to them | tam_import, departed_follow, departed_backfill |
| `referral` | Third-party intro | salesnav_import, starbridge_referral |
| `unknown` | Can't determine | hubspot_backfill, unmapped sources |

### Signal Type (we derive in constants.ts)

| signal_type | Meaning | Sources |
|-------------|---------|---------|
| `Company Intent` | Website visit or discovered at intent company | syft_website, company_discovery |
| `LinkedIn Engagement` | Engaged with RepC's LinkedIn or ads | syft_linkedin, fibbler_engagement |
| `Deal Created` | HubSpot deal exists | hubspot_deal_created |
| `null` | No signal (outbound, backfill) | tam_import, hubspot_backfill |

### MQL Qualification (gates.ts + constants.ts)

```
MQL = inbound + hot/warm tier + buyer title (allowlist) + SLED sub_market
```

| Check | Gate |
|-------|------|
| Inbound | lead_type = "inbound" |
| Hot/Warm | tier in ("hot", "warm") |
| Buyer title | isMqlBuyerTitle() allowlist: CEO, Founder, VP Sales, etc. |
| SLED | sub_market in (K12 EdTech SaaS, Higher Ed, Government & Public Sector) |

---

## AE Routing

| sub_market | AE | HubSpot Owner ID |
|------------|----|--------------------|
| K12 EdTech SaaS | RepA | 162280197 |
| Higher Ed | RepB | 163458119 |
| Government & Public Sector | RepB | 163458119 |
| Other | Unassigned | null |

---

## HubSpot Properties Set

| Property | Source | Example |
|----------|--------|---------|
| `lead_origin` | deriveLeadOrigin(lead_source) | "Website Visitor", "TAM Outbound" |
| `lead_temp` | tier | "Hot", "Warm", "Cold" |
| `signal_type` | getSignalType(lead_source) | "Company Intent", "LinkedIn Engagement" |
| `lifecyclestage` | MQL logic | "marketingqualifiedlead" if MQL |
| `hubspot_owner_id` | deriveAeOwner(sub_market) | RepA or RepB's ID |
| `clay_lead_source` | lead_source directly | "syft_website", "tam_import" |

---

## Attribution Fields (from Syft)

| Field | Where stored | Example |
|-------|--------------|---------|
| `utm_channel` | raw_signals, signals | "Direct", "linkedin_organic", "chatgpt.com" |
| `page_views` | raw_signals, signals | 4 |
| `sessions` | raw_signals, signals | 2 |
| `session_pages_visited` | raw_signals, signals | "/pricing/, /about-us/" |
| `linkedin_action` | raw_signals, signals | "Profile View", "New Follower", "Like" |
| `syft_purchase_intent` | raw_signals, signals | "Low", "Medium", "High" |

---

## Key Files

| File | Responsibility |
|------|----------------|
| `src/lib/constants.ts` | All derivation functions (lead_origin, lead_type, signal_type, MQL, AE routing) |
| `src/lib/gates.ts` | All validation gates (push, discovery, MQL buyer title allowlist) |
| `src/triggers/syft-webhook.ts` | Syft payload intake, sets lead_source |
| `src/triggers/discover-contact.ts` | Sets lead_source = "company_discovery" |
| `src/triggers/tam-activate.ts` | Sets lead_source = "tam_import" |
