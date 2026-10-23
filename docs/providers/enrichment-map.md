# Enrichment Provider Capability Map

Updated: Apr 25, 2026

Two providers: **LeadMagic** (direct API) and **Cargo** (workflow orchestration over LinkedIn).

---

## LeadMagic Endpoints

All endpoints: `POST https://api.leadmagic.io/<endpoint>`, auth via `X-API-Key` header.

### People Endpoints

| Endpoint | Input | Output | Credits | Notes |
|----------|-------|--------|---------|-------|
| `/profile-search` | `profile_url` (LinkedIn URL) | first_name, last_name, headline, **current title**, **current company**, company_size, company_industry, company_website, company_linkedin_url, location, country, about, experiences[], educations[], connections, followers | 1 | **Best endpoint for full profile enrichment from LinkedIn URL.** Returns current employment, full experience history, company details. |
| `/email-finder` | first_name, last_name, domain (opt), company_name (opt) | email, status (valid/valid_catch_all/not_found), company metadata | 1 | Finds work email from name+domain. Also returns company_industry, company_size, company_linkedin_url as bonus. |
| `/mobile-finder` | profile_url (opt), work_email (opt), personal_email (opt) | mobile_number or null | 1 (only if found) | Accepts LinkedIn URL OR email. Pay-on-success. |
| `/b2b-profile` | work_email | profile_url | 1 (only if found) | Reverse lookup: email → LinkedIn URL. Pay-on-success. |
| `/personal-email-finder` | profile_url (LinkedIn URL) | email, status | 1 | Finds personal email from LinkedIn profile. |
| `/employee-finder` | company_domain or company_name, page, per_page | Array of {full_name, title, ...} | 1 | Lists employees at a company. **Does NOT return LinkedIn URLs.** Titles can be stale. |
| `/validate-email` | email | status, deliverable, mx_record, mx_provider | 1 | Email deliverability check. |

### Company Endpoints

| Endpoint | Input | Output | Credits | Notes |
|----------|-------|--------|---------|-------|
| `/company-search` | company_domain or company_name or profile_url | company_name, description, industry, size, locations, social profiles, employee_count | 1 | Full company enrichment. |

### Key Observations — LeadMagic

1. **`/profile-search` is the most valuable endpoint.** LinkedIn URL in → full current profile out (title, company, experiences). This is what we should use for title verification, NOT Cargo's name-based lookup.
2. **`/employee-finder` does NOT return LinkedIn URLs.** This is the gap — we discover contacts but can't link them to LinkedIn profiles for further enrichment.
3. **`/mobile-finder` accepts LinkedIn URL directly.** No need for email first.
4. **`/b2b-profile` goes email → LinkedIn URL.** Useful when we have email but no LinkedIn.
5. **Pay-on-success for mobile-finder and b2b-profile.** Zero cost if no result.

---

## Cargo Workflows

All workflows: submit to `POST /v1/orchestration/runs`, poll, download output. Auth via `Bearer` token.

| Workflow | Input | Output | Credits | Notes |
|----------|-------|--------|---------|-------|
| **Enrich by Name** | firstName, lastName, companyDomain | companyName, companyDomain, jobTitle, **linkedinUrl** | 0.5 | Name → LinkedIn URL + current employment. 44% reliability on common names. |
| **Enrich by URL** | linkedinUrl | companyName, companyDomain, jobTitle, linkedinUrl, **email**, **phone**, headline, about, city, country, experiences, educations | 0.5 | LinkedIn URL → full profile + email + phone. **This is a superset of LeadMagic profile-search + email-finder + mobile-finder in one call.** 75% reliability. |
| **Find Email** | firstName, lastName, companyDomain | email, verified | 1.1-4 | Multi-provider email waterfall (FullEnrich, findyMail, enrichley, PDL). |
| **Find Phone** | firstName, lastName, companyDomain, linkedinUrl (opt) | phone | 3-7 | Multi-provider phone waterfall. Passing LinkedIn URL improves match. |
| **Find Stakeholders** | companyDomain, titles (comma-sep) | stakeholders[] with firstName, lastName, title, linkedinUrl, companyDomain | 6.5 | Sales Navigator search. Returns LinkedIn URLs. Slow (35-120s). |
| **Enrich Company** | companyDomain | company data | 0.5 | Not currently wired. |

### Key Observations — Cargo

1. **Enrich by URL is the power endpoint.** 0.5 credits → current title, company, email, phone, LinkedIn, experiences. It's cheaper and more complete than calling LeadMagic profile-search + email-finder + mobile-finder separately (3 credits).
2. **Enrich by Name is LinkedIn URL discovery.** The main value is getting the LinkedIn URL when you only have name+domain. The title/company are side effects.
3. **Find Stakeholders returns LinkedIn URLs.** Unlike LeadMagic employee-finder, this gives us the key to unlock everything else.
4. **Workflows are async (30-120s).** Not suitable for real-time, but fine for batch enrichment.

---

## Correct Dependency Chain

```
DISCOVER                    ENRICH                       PUSH
─────────                   ──────                       ────

LeadMagic employee-finder   Cargo Enrich by Name         HubSpot
  → name, title               → LinkedIn URL, current     → all properties
  (no LinkedIn URL)              title, company

         OR                        │
                                   ▼
Cargo Find Stakeholders     Cargo Enrich by URL
  → name, title,              → email, phone, full
    LinkedIn URL                 profile, experiences
  (6.5 credits, slow)           (0.5 credits)

                                   │
                                   ▼
                            LeadMagic mobile-finder
                              → phone (if Cargo missed)
                              (pay-on-success)
```

### The Right Flow

**When we have name + domain only (from employee-finder):**
1. Cargo Enrich by Name (0.5 cr) → get LinkedIn URL
2. Cargo Enrich by URL (0.5 cr) → get email, phone, current title, full profile
3. If no phone → LeadMagic mobile-finder (1 cr, pay-on-success)
4. Total: 1-2 credits

**When we have LinkedIn URL already (from Find Stakeholders or existing data):**
1. Cargo Enrich by URL (0.5 cr) → get everything
2. If no phone → LeadMagic mobile-finder
3. Total: 0.5-1.5 credits

**When we have email only:**
1. LeadMagic b2b-profile (email → LinkedIn URL, pay-on-success)
2. Then Cargo Enrich by URL → everything
3. Total: 0.5-1.5 credits

### What We Were Doing Wrong

- Using Cargo Enrich by Name as "verification" when it's actually "LinkedIn URL discovery"
- Trying to use Enrich by URL first (can't — don't have URL yet)
- Calling LeadMagic mobile-finder, email-finder, profile-search separately when Cargo Enrich by URL returns all three in one 0.5-credit call
- Not using LeadMagic `/profile-search` at all — it's the best LeadMagic endpoint for current title verification from LinkedIn URL

---

## Production Bugs (as of Apr 25)

1. **Cargo auth header initialized at module load** — `cargo.ts` line 5-13 sets `CARGO_KEY` and `headers` at import time. In Trigger.dev, env vars aren't available yet. Fix: use `getHeaders()` pattern like `leadmagic.ts` line 13-19.
2. **LeadMagic employee-finder stale titles** — their index lags LinkedIn by months/years (Dwayne Johnson showed title from 2024). Use Cargo Enrich by URL or LeadMagic profile-search for current title.
3. **Find Stakeholders release UUID wrong in docs** — `docs/providers/cargo.md` has `019cf563-d012-496b-86c7-4e9821742046`, actual is `019cf563-d012-496b-86c7-4e9821742246`.
