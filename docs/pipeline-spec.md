# Pipeline Spec — What "Working" Means

This is the testable definition of correct behavior. If the system doesn't match this, it's broken. If it does, stop fixing things.

## Signal comes in from Syft

### What Syft sends (the input)
- Company: name, domain, employees, industry, city, state, country, revenue, LinkedIn page, description
- Contact (if identified): name, title, LinkedIn handle, email, engagement actions (liked post, connected, etc.)
- Activity: pages viewed, sessions, time on site, intent level
- Attribution: first touch source, channels, UTM params

### What should happen (step by step)

**Step 1: syft-poll ingests the signal**
- ALL Syft fields written to `raw_signals` table
- Contact LinkedIn URL extracted from `contacts[0].linkedin`
- Contact title extracted from `lastSeenVisitorDetail.title`
- LinkedIn actions extracted (liked_post, connected, shared_post)
- Names capitalized (Tyce Miller, not tyce miller)
- Source classified: `syft_linkedin` (no page views) or `syft_website` (has page views)

**Step 2: normalize validates and routes**
- Domain not on blocklist → proceed
- Not an enterprise domain (google, microsoft, etc.) → proceed
- Not a customer → proceed
- Routes to: score-intent (always), enrich-company (if new), enrich-contact (if contact has email or LinkedIn URL)

**Step 3: enrich-company (new companies only)**
- Calls LeadMagic company-search for firmographics
- Calls LeadMagic employee-finder for people
- Calls LeadMagic jobs-finder for hiring signals
- Classifies sub-market (K12 / Higher Ed / Gov / Not SLED)
- Scores ICP (0-125)
- Generates AI summary
- Writes to Supabase `companies` with ALL fields:
  - city/state/country: LeadMagic > Syft signal > null
  - linkedin_url: LeadMagic > Syft signal > null
  - description: LeadMagic > Syft signal > null
  - employee_count: LeadMagic > Syft signal > null
- Pushes to HubSpot if SLED + ICP >= 50
- Triggers discover-contact if SLED + <3 contacts

**Step 4: enrich-contact (if contact has identifier)**
- Cargo verifies employment (URL-based preferred, name fallback)
- Email waterfall: Cargo findEmail > LeadMagic findWorkEmail
- Phone: LeadMagic mobile-finder (by LinkedIn URL)
- Looks up company ICP score
- Looks up max intent score
- Computes total score + tier
- MQL check: `isMql()` from gates.ts — requires ALL of:
  - Inbound lead type
  - Hot or warm tier
  - Buyer title on allowlist (CEO, Founder, VP Sales, CRO, etc.)
  - SLED sub-market
  - Intent score > 0
- Upserts contact to Supabase
- Links contact to raw_signal (writes contact_id back)
- Calls tryMarkSignalDone()
- If push gate passes: push to HubSpot, associate with HubSpot company
- If MQL: fire Slack alert

**Step 5: score-intent (always)**
- Computes intent score from signal activity
- Writes to signals table
- Triggers update-hubspot for score push

## What the AE should see in HubSpot

### Company record
- Name, domain
- City, state, country (from LeadMagic or Syft)
- Employee count
- Sub-market (K12 EdTech SaaS / Higher Ed / Gov / Not SLED)
- ICP score
- Lead tier (Hot / Warm / Cool / Cold)
- Lead summary (AI-generated, mentions what ACME can do for them)
- Sales org summary (X AEs, Y SDRs, hiring status)
- LinkedIn company page

### Contact record
- First name, last name (properly capitalized)
- Title
- Email (verified)
- LinkedIn URL
- Phone (if found)
- Lead tier
- ICP score, intent score, total score
- Lead summary (AI-generated call brief)
- Associated with the correct company (not a duplicate)

### Slack MQL alert
- Contact name + title
- Company name + domain
- Scores (total, ICP, intent)
- Sub-market
- What they did (pages visited, sessions, LinkedIn action)
- Employee count, funding, location
- Sales team data (AEs, SDRs)
- AI summary explaining why this matters and how to open the call
- HubSpot deep link
- AE @-mention (RepA for K12, RepB for Higher Ed/Gov)
- **The summary must not attribute one person's actions to another person**
- **The summary must use sales_team_data when available, not say "no data"**

## What should NEVER happen

1. A contact pushed as MQL with a non-buyer title (Account Executive, Territory Manager, Customer Success Manager, etc.)
2. A Slack alert for a blocklisted domain
3. A signal stuck in "scoring" for more than 30 minutes
4. A duplicate company in HubSpot
5. A contact in HubSpot not associated with its company
6. A summary that says a contact "visited the site" when they didn't
7. A summary that says "no sales org data" when we have sales_team_data
8. Lowercase names in HubSpot
9. A contact with no email AND no LinkedIn URL pushed to HubSpot
10. An enrichment API call that doesn't log to enrichment_log

## How to verify (integration test)

After any deploy, run this check:

1. Find the most recent signal that was processed (status=done)
2. Check Supabase company: does it have city, state, country, description, ICP, sub_market?
3. Check Supabase contact: does it have email, title, tier? LinkedIn URL if Syft sent one?
4. Check HubSpot company: does it match Supabase? No duplicate?
5. Check HubSpot contact: is it associated with the company? Does it have the right data?
6. If MQL, check Slack: did the alert fire? Does the summary make sense?
7. Check push_log: were there any gate rejections? Do they make sense?
8. Check enrichment_log: did all API calls log?

If any of these fail, the deploy is bad. Roll back and investigate.
