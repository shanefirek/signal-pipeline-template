# LeadMagic — Primary Enrichment Provider

Ratified: 2026-05-06. Verified with real API calls against production key.

LeadMagic is the **primary and only** enrichment API for Signal Pipeline. Cargo is deprecated (out of credits, not renewing). Clay MCP is available as a manual fallback but not wired into the pipeline.

- **API base:** `https://api.leadmagic.io/v1`
- **Auth:** `X-API-Key: $LEADMAGIC_API_KEY` header (NOT Bearer token)
- **Env var:** `LEADMAGIC_API_KEY` (`.env` + Trigger.dev)
- **Credits:** 58,337 as of 2026-05-06
- **Balance check:** `GET /v1/credits` (free, returns `{ credits, is_frozen, credits_liquid }`)
- **Rate limits:** 100 req/min on most endpoints (profile-search may be lower)
- **Error format:** RFC 7807 JSON (`{ type, title, status, detail, code, docs }`)

---

## Cargo Migration Map

Cargo is gone. Every Cargo function maps to a LeadMagic replacement:

| Cargo function | LeadMagic replacement | Old cost | New cost | Notes |
|---|---|---|---|---|
| `verifyEmploymentByUrl(linkedinUrl)` | **profile-search** | 0.5 cr, 45-136s | 1 cr, <3s | Returns MORE data (work history, education). Instant. |
| `verifyEmployment(name, domain)` | **profile-search** (needs LinkedIn URL first) or skip | 0.5 cr, 44% reliable | — | Name-based was unreliable anyway. Use role-finder to get LinkedIn URL first. |
| `findEmail(name, domain)` | **email-finder** | 1.1-4 cr | 1 cr | Already used as fallback. Now primary. |
| `verifyEmail(email)` | **email-validation** | 0.2 cr | 0.25 cr | Already used as fallback. Now primary. |
| `findStakeholders(domain, titles)` | **role-finder** (targeted) or **employee-finder** (broad) | 6.5 cr flat | 2 cr/role or 0.05/emp | role-finder returns LinkedIn URLs. employee-finder does not. |
| `enrichCompany(domain)` | **company-search** | 0.5 cr | 1 cr | Already primary. |

### What changes in code

1. **email-waterfall.ts** — Remove Cargo-first logic. LeadMagic email-finder becomes step 1, email-validation becomes step 2. No more Cargo verify/find.
2. **enrich-contact.ts** — Replace `cargo.verifyEmploymentByUrl()` with LeadMagic `profile-search`. Same domain-match logic, different data shape.
3. **tam-enrich.ts** — Replace `cargo.findStakeholders()` with LeadMagic `role-finder` (for targeted title searches) or keep `employee-finder` (for broad discovery).
4. **cargo.ts** — Can be deprecated entirely. Keep `domainsMatch()` and `KNOWN_REBRANDS` (move to a shared util).

---

## Complete Endpoint Reference

### People Endpoints

#### 1. Email Finder — 1 credit (free if not found)

Finds a work email by name + domain. Server-side verified — `status === "valid"` means no second validation needed.

- **Endpoint:** `POST /v1/people/email-finder`
- **Input:** `{ first_name, last_name, domain }`
- **Response:**
```json
{
  "email": "user@example.com",
  "status": "valid",
  "credits_consumed": 1,
  "is_domain_catch_all": false,
  "mx_record": "...",
  "mx_provider": "Google",
  "company_name": "exampleco",
  "company_industry": "...",
  "company_size": "11-50"
}
```
- **Key:** `status === "valid"` = verified. No need for a second validation call.
- **Used by:** `leadmagic.ts:findWorkEmail()` -> `email-waterfall.ts`
- **Verified:** 2026-05-06

#### 2. Email Validation — 0.25 credits

Validates an existing email address. Always charged (even if invalid).

- **Endpoint:** `POST /v1/people/email-validation`
- **Input:** `{ email }`
- **Response:**
```json
{
  "email": "user@example.com",
  "email_status": "valid",
  "credits_consumed": 0.25,
  "deliverable": true,
  "is_domain_catch_all": false,
  "mx_record": "...",
  "mx_provider": "Google",
  "company_name": "exampleco",
  "company_industry": "...",
  "company_size": "11-50",
  "company_linkedin_url": "...",
  "company_location": "..."
}
```
- **Key:** Check `email_status` (not `status`). Code handles both: `data.email_status || data.status`.
- **Used by:** `leadmagic.ts:validateEmail()` -> `email-waterfall.ts`
- **Verified:** 2026-05-06

#### 3. Profile Search — 1 credit (CARGO REPLACEMENT: verifyEmploymentByUrl)

LinkedIn URL -> full professional profile with current position, work history, education. **This is the primary employment verification endpoint** now that Cargo is gone.

- **Endpoint:** `POST /v1/people/profile-search`
- **Input:** `{ profile_url }` (LinkedIn URL)
- **Response (verified 2026-05-06):**
```json
{
  "profile_url": "https://www.linkedin.com/in/jesseboles/",
  "credits_consumed": 1,
  "first_name": "Jesse",
  "last_name": "Boles",
  "full_name": "Jesse Boles",
  "professional_title": "Student Intern at Bennett & Bloom Eye Centers",
  "bio": null,
  "company_name": "Mayes And Ware Eyecare",
  "company_industry": null,
  "company_website": null,
  "country": "United States",
  "location": "Owensboro, Kentucky, United States",
  "total_tenure_formatted": "16 years 5 months",
  "current_position": {
    "position_title": "Optometrist",
    "company_name": "Mayes and Ware Eyecare",
    "employment_period": "May 2021 - Present",
    "company_website": null,
    "company_logo_url": null
  },
  "profile_summary": {
    "display_name": "Jesse Boles",
    "headline": "...",
    "current_company": "Mayes and Ware Eyecare",
    "current_role": "Optometrist",
    "location": "...",
    "country": "United States"
  },
  "work_experience": [
    {
      "position_title": "Optometrist",
      "company_name": "Mayes and Ware Eyecare",
      "employment_period": "May 2021 - Present",
      "company_website": null,
      "location": null,
      "employment_type": null
    }
  ],
  "education": [
    {
      "institution_name": "Southern College of Optometry",
      "degree": "Doctorate of Optometry, Optometry",
      "attendance_period": "2017 - 2021"
    }
  ],
  "certifications": null,
  "honors": [...]
}
```
- **Employment verification pattern:** Compare `current_position.company_name` (or top-level `company_name`) domain against expected domain using `domainsMatch()`. If match -> verified. If different company -> departed.
- **Advantages over Cargo:** Returns full work history (detect how long at company), education, and is instant (<3s vs 45-136s).
- **NOT yet implemented in code.** Needs new function in `leadmagic.ts`.
- **Verified:** 2026-05-06 — real API call, response shape confirmed.

#### 4. Role Finder — 2 credits (free if not found) (CARGO REPLACEMENT: findStakeholders)

Finds a person at a company by job title. Returns their LinkedIn URL. **This replaces Cargo's findStakeholders for targeted title searches.**

- **Endpoint:** `POST /v1/people/role-finder`
- **Input:** `{ job_title, company_domain }`
- **Response (verified 2026-05-06):**
```json
{
  "name": "James Dressing",
  "profile_url": "https://www.linkedin.com/in/jamesdressing",
  "first_name": "James",
  "last_name": "Dressing",
  "message": "Role Found",
  "credits_consumed": 2,
  "company_name": "exampleco",
  "company_website": "exampleco.com"
}
```
- **Key:** Returns `profile_url` (LinkedIn URL) — unlike employee-finder which does NOT return LinkedIn URLs.
- **Pattern for stakeholder discovery:** Call role-finder once per target title (CEO, VP Sales, Head of Sales, etc.). At 2 credits/call, searching 5 titles = 10 credits vs Cargo's flat 6.5 credits. But role-finder returns LinkedIn URLs and is instant.
- **NOT yet implemented in code.** Needs new function in `leadmagic.ts` or `leadmagic-company.ts`.
- **Verified:** 2026-05-06 — real API call, response shape confirmed.

#### 5. Mobile Finder — 5 credits (free if not found)

Finds mobile phone number from email or LinkedIn URL.

- **Endpoint:** `POST /v1/people/mobile-finder`
- **Input:** `{ work_email }` or `{ profile_url }` or `{ email }` (alias for work_email)
- **Response:**
```json
{
  "mobile_number": "+1 555-123-4567",
  "credits_consumed": 5,
  "message": "Mobile number found"
}
```
- **Used by:** `leadmagic.ts:findMobilePhone()` -> `enrich-contact.ts`
- **Verified:** 2026-04-30

#### 6. Employee Finder — 0.05 credits per employee (20 per credit)

Returns a list of employees at a company. Broad discovery — names + titles only, NO LinkedIn URLs.

- **Endpoint:** `POST /v1/people/employee-finder`
- **Input:** `{ company_domain, limit? }`
- **Response:**
```json
{
  "message": "Employees found",
  "total_count": 42,
  "returned_count": 20,
  "credits_consumed": 1,
  "data": [
    {
      "first_name": "James",
      "last_name": "Dressing",
      "title": "Chief Executive Officer",
      "website": "exampleco.com",
      "company_name": "exampleco"
    }
  ]
}
```
- **Key limitation:** Response `data[]` does NOT include `linkedin_url` or `profile_url`. To get LinkedIn URLs, use role-finder per person.
- **Accuracy:** ~67% per RepB's review. ~33% departed contacts.
- **Used by:** `leadmagic-company.ts:employeeFinder()` -> `tam-enrich.ts`
- **Verified:** 2026-04-30

#### 7. B2B Profile (Email -> LinkedIn) — 10 credits (free if not found)

Reverse lookup: work email -> LinkedIn profile URL.

- **Endpoint:** `POST /v1/people/b2b-profile`
- **Input:** `{ work_email }`
- **Response (verified 2026-05-06):**
```json
{
  "profile_url": "https://www.linkedin.com/in/jamesdressing",
  "message": "Profile URL found",
  "credits_consumed": 10
}
```
- **Cost:** 10 credits is expensive. Use sparingly — only when you have an email but need LinkedIn URL for verification.
- **Used by:** Not currently wired in. Could be useful for contact backfill.
- **Verified:** 2026-05-06 — real API call confirmed.

#### 8. B2B Profile Email — 5 credits (free if not found)

Finds work email by name + domain. Similar to email-finder but different underlying data source.

- **Endpoint:** `POST /v1/people/b2b-profile-email`
- **Input:** `{ name, company_domain }` (per Context7 OpenAPI spec — NOT `{ email }` or `{ profile_url }`)
- **Response:**
```json
{
  "email": "peter.jones@example.com",
  "credits_consumed": 5
}
```
- **WARNING:** Our existing code (`leadmagic.ts:emailToProfile()`) sends `{ email }` to this endpoint, which is WRONG. The endpoint takes `{ name, company_domain }` and returns an email. It's a more expensive alternative to email-finder with potentially different data coverage.
- **Our code is broken.** The function name `emailToProfile` is misleading — this endpoint finds emails, not profiles. The function should either be removed or rewritten to call `/v1/people/b2b-profile` instead.
- **Verified:** 2026-05-06 — confirmed input schema via OpenAPI spec.

#### 9. Personal Email Finder — 2 credits (free if not found)

Finds personal email addresses from a LinkedIn URL. Useful for outreach when work email bounces.

- **Endpoint:** `POST /v1/people/personal-email-finder`
- **Input:** `{ profile_url }` (LinkedIn URL)
- **Response:**
```json
{
  "profile_url": "https://www.linkedin.com/in/johndoe",
  "personal_email": "user@example.com",
  "personal_emails": ["user@example.com"],
  "credits_consumed": 2,
  "message": "Personal email found"
}
```
- **Not implemented in code.** Not needed for current pipeline.

### Company Endpoints

#### 10. Company Search — 1 credit (free if not found)

Core firmographic enrichment. Returns company details from domain.

- **Endpoint:** `POST /v1/companies/company-search`
- **Input:** `{ company_domain }` (also accepts `company_name`, `profile_url`)
- **Response:**
```json
{
  "credits_consumed": 1,
  "company_name": "LeadMagic",
  "company_id": 75153174,
  "employee_count": 9,
  "employee_count_range": { "start": 11, "end": 50 },
  "specialities": ["Sales", "Marketing", "ABM", "RevOps"],
  "tagline": "...",
  "follower_count": 6096,
  "industry": "Internet",
  "description": "...",
  "website_url": "https://leadmagic.io",
  "founded_on": { "year": 2022 },
  "locations": [
    {
      "country": "US",
      "city": "Boston",
      "geographic_area": "Massachusetts",
      "postal_code": "02210",
      "headquarter": true
    }
  ]
}
```
- **Note:** Response uses camelCase (`companyName`, `employeeCount`). Some fields null for smaller companies.
- **Used by:** `leadmagic-company.ts:companySearch()` -> `tam-enrich.ts`
- **Verified:** 2026-05-06

#### 11. Company Funding — 4 credits (free if not found)

Deep funding intelligence: rounds, investors, leadership, competitors, news.

- **Endpoint:** `POST /v1/companies/company-funding`
- **Input:** `{ company_domain }`
- **Response (verified 2026-05-06, abridged):**
```json
{
  "credits_consumed": 4,
  "basicInfo": {
    "companyName": "exampleco",
    "description": "...",
    "founded": "2014",
    "headquarters": { "city": "San Francisco", "state": "California", "country": "USA" },
    "primaryDomain": "exampleco.com",
    "phone": "415-902-7709",
    "status": "NEW",
    "ownership": "Private"
  },
  "financialInfo": {
    "revenue": 2300000,
    "formattedRevenue": "2.3M",
    "totalFunding": 7625000,
    "formattedFunding": "7.6M",
    "lastFundingRound": { "round": "Growth", "date": "2019-04-01", "amount": 4000000 },
    "fundingHistory": [
      { "round": "Growth", "date": "2019-04-01", "amount": "$4,000,000", "investors": ["City Light Capital", "University Ventures"] }
    ]
  },
  "companySize": { "employees": 51, "employeeRange": "25 - 100" },
  "leadership": {
    "ceo": { "firstName": "Alan", "lastName": "Tripp", "designation": "Co-Founder & CEO", "linkedIn": "https://www.linkedin.com/in/alantripp" }
  },
  "topCompetitors": [
    { "name": "Hobsons, Inc.", "revenue": "$120", "employees": "542", "website": "https://hobsons.com" }
  ],
  "socialMedia": [
    { "platform": "linkedIn", "url": "https://linkedin.com/company/exampleco" }
  ],
  "news": [
    { "title": "...", "source": "Help Net Security", "date": "2020-05-14" }
  ]
}
```
- **Rich data:** CEO LinkedIn, competitors, funding history with investors, news, social media links.
- **Not implemented in code.** Could enrich `funding.ts` data quality. 4 credits is steep for routine use but valuable for hot leads.
- **Verified:** 2026-05-06 — real API call, full response captured.

#### 12. Technographics — 1 credit

Returns the technology stack for a company domain.

- **Endpoint:** `POST /v1/companies/technographics`
- **Input:** `{ company_domain }`
- **Response (verified 2026-05-06):**
```json
{
  "credits_consumed": 1,
  "message": "Technology stack information retrieved successfully",
  "data": [
    {
      "name": "Vector",
      "description": "Vector is a contact-based marketing platform...",
      "categories": ["AI", "Marketing Automation", "CRM", "Lead Generation", ...]
    }
  ]
}
```
- **Key:** Response uses `data[]` not `technologies[]`. Our code handles both.
- **Used by:** `leadmagic-company.ts:technographics()` -> `tam-enrich.ts`
- **Verified:** 2026-05-06

### Jobs Endpoints

#### 13. Jobs Finder — 1 credit per job (free if no jobs found)

Searches job postings by company, title, location.

- **Endpoint:** `POST /v1/jobs/jobs-finder`
- **Input:** `{ job_title, company_name?, country_id?, experience_level?, page?, per_page? }`
- **Response:**
```json
{
  "total_count": 105,
  "page": 1,
  "per_page": 5,
  "total_pages": 21,
  "credits_consumed": 5,
  "results": [
    {
      "title": "Account Executive",
      "location": "San Francisco, CA",
      "company": { "name": "exampleco", "website_url": "https://exampleco.com", "linkedin_url": "..." },
      "types": [{ "id": 1, "name": "Full Time" }],
      "has_remote": false,
      "published": "2025-06-25T20:36:00Z",
      "application_url": "...",
      "salary_min": "100600",
      "salary_max": "215400",
      "salary_currency": "USD",
      "experience_level": "Mid Level"
    }
  ]
}
```
- **WARNING:** Our code sends `company_website` which is NOT in the official docs. The documented field is `company_name`. This may work via an undocumented alias or may return unfiltered results. Needs verification.
- **Used by:** `leadmagic-company.ts:jobsFinder()` -> `tam-enrich.ts`
- **Verified (partially):** 2026-04-30 — endpoint works, but `company_website` input field not confirmed.

#### 14-15. Jobs Metadata (free)

- `GET /v1/jobs/countries` — list of country IDs for jobs-finder
- `GET /v1/jobs/job-types` — list of job type IDs

### Ads Endpoints (not in use)

| Endpoint | Cost | Input | Returns |
|---|---|---|---|
| `POST /v1/ads/google-ads-search` | 0.2 cr | `{ company_domain }` | Google Ad creatives |
| `POST /v1/ads/meta-ads-search` | 0.2 cr | `{ company_domain }` | Meta/Instagram ad creatives |
| `POST /v1/ads/b2b-ads-search` | 0.2 cr | `{ company_domain }` | LinkedIn/B2B ad creatives |
| `POST /v1/ads/b2b-ads-details` | 2 cr | `{ ad_id }` | Full ad details |

Not implemented. Could be useful for competitor intel or intent signals.

---

## Credit Costs Summary

| Endpoint | Cost | Free if not found? |
|----------|------|--------------------|
| credits | 0 | N/A |
| email-finder | 1 | Yes |
| email-validation | 0.25 | No |
| profile-search | 1 | No |
| role-finder | 2 | Yes |
| mobile-finder | 5 | Yes |
| employee-finder | 0.05/emp | — |
| b2b-profile | 10 | Yes |
| b2b-profile-email | 5 | Yes |
| personal-email-finder | 2 | Yes |
| company-search | 1 | Yes |
| company-funding | 4 | Yes |
| technographics | 1 | No |
| jobs-finder | 1/job | Yes (if 0 jobs) |
| google-ads-search | 0.2 | — |
| meta-ads-search | 0.2 | — |
| b2b-ads-search | 0.2 | — |
| b2b-ads-details | 2 | Yes |

## Cost Budget Per Lead (estimated)

Typical inbound signal through the Syft pipeline:

| Step | Endpoint | Credits |
|------|----------|---------|
| Company enrichment | company-search | 1 |
| Employee discovery | employee-finder (20 people) | 1 |
| Sales team analysis | (local LLM, no API) | 0 |
| Email find | email-finder | 1 |
| Email validate | email-validation | 0.25 |
| Employment verify | profile-search | 1 |
| Phone find | mobile-finder | 5 |
| **Total** | | **~9.25** |

At 58,337 credits, that's ~6,300 leads before needing a refill.

TAM batch (tam-enrich per company):

| Step | Endpoint | Credits |
|------|----------|---------|
| Company search | company-search | 1 |
| Employee finder (50) | employee-finder | 2.5 |
| Jobs finder | jobs-finder | ~5 |
| Technographics | technographics | 1 |
| Sales team classifier | (local LLM) | 0 |
| Sub-market classifier | (local LLM) | 0 |
| Stakeholder discovery (5 titles) | role-finder x5 | 10 |
| **Total** | | **~19.5** |

---

## Code Implementation Status

| Function | File | Status |
|----------|------|--------|
| `findWorkEmail()` | `leadmagic.ts` | Active |
| `validateEmail()` | `leadmagic.ts` | Active |
| `findMobilePhone()` | `leadmagic.ts` | Active |
| `emailToProfile()` | `leadmagic.ts` | BROKEN — sends wrong params to wrong endpoint |
| `companySearch()` | `leadmagic-company.ts` | Active |
| `employeeFinder()` | `leadmagic-company.ts` | Active |
| `jobsFinder()` | `leadmagic-company.ts` | Active (company_website input unverified) |
| `technographics()` | `leadmagic-company.ts` | Active |
| `analyzeSalesTeam()` | `leadmagic-company.ts` | Active (regex) |
| `classifySalesTeamLLM()` | `leadmagic-company.ts` | Active (Sonnet 4.6) |
| **`profileSearch()`** | — | **NOT IMPLEMENTED — needed for Cargo replacement** |
| **`roleFinder()`** | — | **NOT IMPLEMENTED — needed for Cargo replacement** |
| `companyFunding()` | — | Not implemented (nice to have) |
| `personalEmailFinder()` | — | Not implemented (not needed) |

## Enrichment Logging Status

| Operation | Logged to enrichment_log? |
|-----------|--------------------------|
| email-finder (findWorkEmail) | Yes — via email-waterfall |
| email-validation (validateEmail) | Yes — via email-waterfall |
| mobile-finder (findMobilePhone) | Yes — via enrich-contact |
| employee-finder | Partially (2 entries total) |
| company-search | **NO** |
| jobs-finder | **NO** |
| technographics | **NO** |
| profile-search | **NOT IMPLEMENTED** |
| role-finder | **NOT IMPLEMENTED** |

---

## Known Quirks

1. **API accepts undocumented field aliases.** `email` works where docs say `work_email`. `company_domain` works where docs say `company_name`. Verified with real calls — not bugs.
2. **employee-finder returns no LinkedIn URLs.** Only name + title + company. Use role-finder for LinkedIn URLs.
3. **~67% accuracy on employee-finder.** ~33% departed contacts. Always verify with profile-search before trusting.
4. **LeadMagic does not store results.** No way to retrieve past enrichments. Capture every response in enrichment_log on first call.
5. **profile-search `professional_title` can be stale.** The `headline` field on LinkedIn is user-controlled and may not reflect current role. Always use `current_position.position_title` for the actual current title.
6. **company-funding is MUCH richer than company-search.** Includes CEO LinkedIn, competitors, funding rounds with investors, news. But costs 4x more (4 vs 1 credit).
7. **b2b-profile-email is NOT a profile lookup.** Despite the name, it finds emails (like email-finder). Our existing `emailToProfile()` function misuses this endpoint.
8. **jobs-finder `company_website` input** is undocumented. The official param is `company_name`. Our code sends `company_website` which may silently fail to filter by company.
