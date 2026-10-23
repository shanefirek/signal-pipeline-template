# LeadMagic API Reference

Replaces MixRank (via Clay) for company firmographics, sales team detection, and hiring signals.
Also handles email validation, email finding, and mobile phone lookup (already wired in `src/enrichment/providers/leadmagic.ts`).

**Auth:** `X-API-Key: {LEADMAGIC_API_KEY}` header on all requests.
**Base URL:** `https://api.leadmagic.io/v1`

---

## Endpoints — Company (NEW, replaces MixRank)

### Company Search — 1 credit
`POST /companies/company-search`

Returns firmographics: employee count, revenue, funding, industry. Replaces MixRank company lookup + Clay Spur/Claygent for headcount/revenue.

```json
// Request
{ "company_website": "example.com" }

// Response
{
  "company_name": "Example Inc",
  "linkedin_url": "https://linkedin.com/company/example",
  "company_website": "example.com",
  "company_domain": "example.com",
  "employee_count": 45,
  "revenue": 8000000,
  "revenue_formatted": "$8M",
  "total_funding": 15000000,
  "total_funding_formatted": "$15M",
  "funding_rounds": 2,
  "industry": "Education Technology",
  "description": "...",
  "ownership_status": "Private"
}
```

**Maps to ICP scoring:**
- `employee_count` → `scoreHeadcount()` (0-15 pts)
- `revenue` / `revenue_formatted` → `scoreCompanyStage()` (0-30 pts)
- `total_funding` → funding overlay in `mapOctaveToICP()`
- `industry` → `scoreVerticalFit()` (0-35 pts)

### Employee Finder — 0.05 credits/employee
`POST /people/employee-finder`

Returns list of employees at a company. Replaces MixRank people search for sales team detection.

```json
// Request
{
  "company_website": "example.com",
  "limit": 50
}

// Response — array
[
  {
    "full_name": "Jane Doe",
    "title": "VP of Sales",
    "linkedin_url": "https://linkedin.com/in/janedoe",
    "location": "San Francisco, CA"
  }
]
```

**Maps to ICP scoring:** Filter titles for sales roles → `scoreSalesTeam()` / outbound need score (0-50 pts). Pattern: "VP Sales + 0 SDRs = 50 pts" (ACME golden signal).

### Role Finder — 2 credits
`POST /people/role-finder`

Targeted search by job title at a company. More precise than Employee Finder when you know what you're looking for.

```json
// Request
{
  "company_domain": "example.com",
  "job_title": "VP Sales"
}

// Response
{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "linkedin_url": "https://linkedin.com/in/janedoe",
  "title": "VP of Sales",
  "company_name": "Example Inc"
}
```

**Use case:** Find the decision maker directly instead of pulling full employee list.

### Jobs Finder — 1 credit/job
`POST /jobs/jobs-finder`

Returns active job postings. Replaces MixRank jobs search for hiring signal detection.

```json
// Request
{
  "company_website": "example.com",
  "job_title": "SDR"  // optional filter
}

// Response — array
[
  {
    "title": "Sales Development Representative",
    "location": "Remote",
    "posted_date": "2026-03-01",
    "url": "https://..."
  }
]
```

**Maps to ICP scoring:** SDR/BDR job postings = they're building outbound = lower outbound need score. No sales hiring = higher score.

### Company Funding — 4 credits
`POST /companies/company-funding`

Detailed funding history with rounds, investors, leadership. More detail than Company Search's `total_funding`.

```json
// Request
{ "company_website": "example.com" }

// Response
{
  "total_funding": 15000000,
  "funding_rounds": [
    {
      "round_type": "Series A",
      "amount": 12000000,
      "date": "2025-06-15",
      "investors": ["Acme Ventures"]
    }
  ],
  "leadership": [
    { "name": "John Smith", "title": "CEO" }
  ]
}
```

**Use case:** Funding overlay scoring + qualification context for AI summaries.

---

## Endpoints — Contact (already wired in leadmagic.ts)

### Email Finder — 1 credit
`POST /people/email-finder`
Body: `{ "first_name": "...", "last_name": "...", "company_domain": "..." }`

### Email Validation — 0.25 credits
`POST /people/email-validation`
Body: `{ "email": "..." }`

### Mobile Finder — 5 credits
`POST /people/mobile-finder`
Body: `{ "profile_url": "linkedin.com/in/..." }` or `{ "email": "..." }`

---

## Provider Status

| Endpoint | In `leadmagic.ts` | Used In |
|----------|-------------------|---------|
| Email Validation | YES | email-waterfall step 3/5 |
| Email Finder | YES | email-waterfall step 4 |
| Mobile Finder | YES | enrich-contact phone lookup |
| Company Search | **NO — needs build** | enrich-company (replaces MixRank) |
| Employee Finder | **NO — needs build** | enrich-company (sales team detection) |
| Role Finder | **NO — needs build** | discover-contact (targeted lookup) |
| Jobs Finder | **NO — needs build** | enrich-company (hiring signals) |
| Company Funding | **NO — needs build** | enrich-company (funding overlay) |

---

## Auth Note

Existing `leadmagic.ts` uses `Authorization: Bearer {key}` and different endpoint paths (`/email/validate`, `/email/find`, `/phone/find`). Actual API docs say:
- **Header:** `X-API-Key: {key}` (not Bearer)
- **Paths:** `/people/email-validation`, `/people/email-finder`, `/people/mobile-finder`

**TODO when key arrives:** Test both patterns. If the old paths 404, update `leadmagic.ts` to match real API docs.

---

## Credit Cost Per Company (full enrichment)

| Step | Credits |
|------|---------|
| Company Search | 1 |
| Employee Finder (50 people) | 2.5 |
| Jobs Finder (~5 jobs) | 5 |
| **Total** | **~8.5/company** |

vs Clay: ~6-8 credits/company but Clay credits are 10x more expensive per unit.

Optional (only for Hot leads):
- Company Funding: +4
- Role Finder (targeted): +2
- Mobile Finder (per contact): +5
