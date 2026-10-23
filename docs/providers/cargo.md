# Cargo (getcargo.io) — DEPRECATED 2026-05-06

**STATUS: OUT OF CREDITS. NOT RENEWING. LeadMagic is now the primary and only enrichment provider.**

See `docs/providers/leadmagic.md` for the Cargo -> LeadMagic migration map.

The code in `src/enrichment/providers/cargo.ts` still exists but all calls will fail with empty API key.
Keep `domainsMatch()` and `KNOWN_REBRANDS` — these are domain-matching utilities used by the pipeline regardless of provider.

---

## Historical Reference (below)

Workflow-based orchestration. Was primary provider for contact verification, email finding, and stakeholder discovery.

- **API base:** `https://api.getcargo.io/v1`
- **Auth:** `Authorization: Bearer $CARGO_API_KEY`
- **CLI:** `npx @cargo-ai/cli` (installed globally, authenticated as user@example.com)
- **Workspace:** `df217dbf-4acb-42cc-98bf-cd8a748e0358` (acme-test)

## CRITICAL: Tool UUIDs vs Workflow UUIDs

Cargo has TWO UUID types. The runs API ONLY accepts workflow UUIDs.

- **Tool UUID** — a named wrapper (e.g. "Find email"). Listed by `cargo-ai orchestration tool list`. Returns `workflowNotFound` if used in `/orchestration/runs`.
- **Workflow UUID** — the actual execution graph. Listed by `cargo-ai orchestration workflow list`. This is what our code must use.

Every tool points to a workflow. To find the right workflow UUID for a tool:
```bash
npx @cargo-ai/cli orchestration tool list   # shows tool → workflow mapping
```

## How to verify a UUID before using it

```bash
# Quick: does this workflow exist?
curl -s "https://api.getcargo.io/v1/orchestration/workflows/<uuid>" \
  -H "Authorization: Bearer $CARGO_API_KEY" | jq '.workflow.deployedRelease.uuid'

# Full list with nodes
npx @cargo-ai/cli orchestration workflow list

# Tool-to-workflow mapping
npx @cargo-ai/cli orchestration tool list
```

If it returns `workflowNotFound`, check the tool list — you might have a tool UUID.

## Workflows in use

### Enrich Person by URL (0.5 credits) — PRIMARY VERIFICATION
- **Workflow UUID:** `53f31647-c4c9-4c55-ac72-0af70ddbc8cb`
- **Tool UUID:** `9960a1be-19a...` ("Enrich lead")
- **Release UUID:** `ca3d8da1-fc24-45be-9368-77100af6e181`
- **Connector:** `linkedin.enrichProfile`
- **Input:** `{ linkedinUrl }`
- **Output:** `{ companyName, companyDomain, jobTitle, linkedinUrl, firstName, lastName }`
- **Email/phone:** Always null — workflow has internal email sub-step that adds 60-90s latency but doesn't surface results in output. Email/phone come from the email waterfall separately.
- **Latency:** 45–136s (avg ~85s). The enrichProfile step itself is ~25s; the rest is the internal email cascade.
- **Reliability:** ~75% — direct LinkedIn profile match.
- **Used by:** `cargo.ts:verifyEmploymentByUrl()` → `enrich-contact.ts`
- **Verified:** 2026-04-30 real API call. Submitted run, polled to success, got output.

### Enrich Person by Name (0.5 credits) — FALLBACK ONLY
- **Workflow UUID:** `1ca01822-32b4-4169-a2cd-df0824d8b227`
- **Tool UUID:** `257415d7-57c...` ("Enrich person")
- **Release UUID:** `95327d38-d9b1-44e4-9ff7-36fa7613ce2a`
- **Connector:** `linkedin.enrichProfileFromName`
- **Input:** `{ firstName, lastName, companyDomain }`
- **Output:** `{ companyName, companyDomain, jobTitle, linkedinUrl }`
- **Reliability:** ~44% — fails on common names, LinkedIn name mismatches, sparse profiles.
- **Used by:** `cargo.ts:verifyEmployment()` — only when no LinkedIn URL available.
- **Gotcha:** domain comparison uses `domainsMatch()` — handles rebrands (tophat.com ↔ toph.at, etc.)

### Find Email (1.1–4 credits) — FIXED 2026-04-30
- **Workflow UUID:** `5214c962-d7db-4774-b464-bbe97461f1f7` ← the code uses THIS
- **Tool UUID:** `5071289f-5b95-4448-badf-cf3bcfdcb1db` ← NOT this (returns workflowNotFound)
- **Release UUID:** `7e12510e-17bc-4991-be64-bd86715c5981` (auto-used)
- **Input:** `{ firstName, lastName, companyDomain }` (optional: `linkedinUrl`, `returns_catchalls`)
- **Output:** `{ email, verified }`
- **Used by:** `cargo.ts:findEmail()` → `email-waterfall.ts` step 2
- **History:** Code had tool UUID `5071289f` — every call returned workflowNotFound. Waterfall fell through to LeadMagic. Fixed to workflow UUID.
- **Verified:** 2026-04-30 real API call.

### Verify Email (0.2 credits) — FIXED 2026-04-30
- **Workflow UUID:** `7c59c630-fcb0-4f85-b8fb-81ab60a3c4a1` ← the code uses THIS
- **Tool UUID:** `fb7787fc-2c69-4d1b-9a3b-eb0af2a26067` ← NOT this (returns workflowNotFound)
- **Release UUID:** `c536f0cb-ba4c-4221-bbde-a97bdb95c2f3` (auto-used)
- **Input:** `{ email }`
- **Output:** `{ valid, deliverable }`
- **Used by:** `cargo.ts:verifyEmail()` → `email-waterfall.ts` steps 1, 4, 6
- **History:** Same bug as findEmail — tool UUID, not workflow UUID.
- **Verified:** 2026-04-30 real API call.

### Find Phone (3–7 credits)
- **Workflow UUID:** `7b4a19d3-73aa-4c47-8e21-ef0502f1faac`
- **Tool UUID:** `84036965-941...` ("Find phone")
- **Input:** `{ firstName, lastName, companyDomain, linkedinUrl? }` — linkedinUrl improves match rate
- **Output:** `{ phone }` (e.g. `"+1 NNN-NNN-NNNN"`)
- **Gotcha:** download-outputs sometimes returns no URL on first call. Retry 1–3x with 1–2s delay.
- **Used by:** Not currently in email waterfall. Phone comes from LeadMagic mobile-finder.

### Find Stakeholders (6.5 credits)
- **Workflow UUID:** `4b29f36e-525b-4295-97ab-6c2909d3a8e4`
- **Tool UUID:** `943e8a18-3b9...` ("Find stakeholders")
- **Release UUID:** `019cf563-d012-496b-86c7-4e9821742246`
- **Connector:** `enrichCompanyFromDomain` → `salesNavigator.searchLeadsLegacy` → script
- **Input:** `{ companyDomain, titles }` — `titles` is comma-separated, Sales Nav fuzzy/OR-joined
- **Output:** `{ stakeholders: [{ firstName, lastName, title, linkedinUrl, about, companyDomain, companyName }] }`
- **Latency:** 35–120s
- **Cost:** 6.5 credits PER CALL (charged on submission, even if 0 results)
- **Used by:** `cargo.ts:findStakeholders()` → `discover-contact.ts`, `tam-enrich.ts`
- **Verified:** 2026-04-30 UUID confirmed via workflow list.

### Enrich Company (0.5 credits) — NOT IN USE
- **Workflow UUID:** `244abe8b-e8f8-4983-b405-a8a2f6661c5b`
- **Tool UUID:** `e540a04a-d45...` ("Enrich company")
- **Connector:** `enrichCompany`
- Not wired into `src/`. Company enrichment uses LeadMagic.

## All tools → workflows (verified 2026-04-30)

```
Tool UUID     Tool Name                              → Workflow UUID
5071289f      Find email                             → 5214c962
fb7787fc      Verify email                           → 7c59c630
257415d7      Enrich person (name)                   → 1ca01822
9960a1be      Enrich lead (URL)                      → 53f31647
943e8a18      Find stakeholders                      → 4b29f36e
84036965      Find phone                             → 7b4a19d3
e540a04a      Enrich company                         → 7e971c7f (not 244abe8b)
c3019281      Find LinkedIn URL from email            → 0e843401
fed40a3c      Find work email from LinkedIn URL       → ec6e7199
bd1995f1      Find work email from personal email     → 95f3b05c
afcdbfac      Research company                       → d0cc7063
854b1750      Find competitors                       → c8957f60
```

## API pattern

1. **Submit:** `POST /orchestration/runs` with `{ workflowUuid, releaseUuid?, data: { ... } }` → `{ run: { uuid } }`
2. **Poll:** `GET /orchestration/runs/{uuid}` → `{ run: { status: "pending" | "running" | "success" | "error" } }`
3. **Download:** `POST /orchestration/runs/download-outputs` with `{ workflowUuid, outputNodeSlug: "end", format: "json", recordId: <runId> }` → `{ url: <s3> }`
4. **Fetch S3:** `GET <url>` → `Array<{ output: {...}, _status, ... }>`

Use `pollRun()` + `getOutput()` in `cargo.ts` for the standard flow.

## CLI reference

```bash
npx @cargo-ai/cli whoami                          # check auth
npx @cargo-ai/cli orchestration workflow list      # all workflows
npx @cargo-ai/cli orchestration tool list          # all tools (tool→workflow mapping)
npx @cargo-ai/cli orchestration release get <uuid> # inspect a release's nodes/inputs
npx @cargo-ai/cli orchestration run list           # recent runs
npx @cargo-ai/cli billing                          # credit balance (if supported)
```

## Credits

Live balance: check Cargo dashboard or `npx @cargo-ai/cli billing`.
