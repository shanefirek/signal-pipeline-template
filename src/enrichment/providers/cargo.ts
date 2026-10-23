// Cargo employment verification provider
// Uses LinkedIn enrichment under the hood (0.5 credits/contact)
// Verifies if a contact still works at the expected company

const WORKFLOW = "1ca01822-32b4-4169-a2cd-df0824d8b227";
const RELEASE = "95327d38-d9b1-44e4-9ff7-36fa7613ce2a";
const BASE = "https://api.getcargo.io/v1";

function getHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.CARGO_API_KEY || ""}`,
    "Content-Type": "application/json",
  };
}

export interface VerifyResult {
  verified: boolean;
  departed: boolean;
  currentCompany: string | null;
  currentDomain: string | null;
  currentTitle: string | null;
  linkedinUrl: string | null;
  email?: string | null;
  phone?: string | null;
  error?: string;
}

// Known domain rebrands/variants — same company, different domain
const KNOWN_REBRANDS: [string, string][] = [
  ["n2y.com", "everway.com"],
  ["n2y.com", "everway.link"],
  ["serosoft.com", "academiaerp.com"],
  ["geniussis.com", "geniuslearning.com"],
  ["cengage.com", "cengagegroup.com"],
  ["tophat.com", "toph.at"],
  ["vitalsource.com", "get.vitalsource.com"],
  ["fiveable.me", "hi.fiveable.me"],
  ["hardhatvr.com", "hhimmersive.com"],
  ["alegralearning.com", "joyschoolenglish.com"],
  ["alludolearning.com", "alpenspruce.com"],
  // Higher Ed acquisitions / subsidiary domains (discovered Apr 22 from Cargo verification)
  ["rhb.com", "sigcorp.com"],               // RHB is a subsidiary of SIG Corp
  ["athletenetwork.com", "gravyty.com"],     // Gravyty acquired Athlete Network
  ["mindmax.net", "storegro.com"],           // Same founder (Viju K.), different product
  ["yellowdig.com", "yellowdig.co"],         // TLD variant (also handled by base-domain match, but explicit is safer)
];

function normalizeDomain(d: string | null | undefined): string {
  if (!d) return "";
  let domain = d.toLowerCase().trim();
  // Strip common subdomains/prefixes
  domain = domain.replace(
    /^(www\.|about\.|info\.|get\.|my\.|app\.|go\.|hi\.|learn\.|jobs\.|partners\.|link\.)/,
    ""
  );
  // Strip trailing paths
  domain = domain.split("/")[0];
  return domain;
}

export function domainsMatch(input: string | null, current: string | null): boolean {
  if (!input || !current) return false;

  const n1 = normalizeDomain(input);
  const n2 = normalizeDomain(current);

  // Exact match after normalization
  if (n1 === n2) return true;

  // One contains the other (subdomain match)
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Base domain match (strip TLD variations)
  const base1 = n1.replace(/\.(com|org|net|edu|io|co|ai|app|so|me|li)$/, "");
  const base2 = n2.replace(/\.(com|org|net|edu|io|co|ai|app|so|me|li)$/, "");
  if (base1 === base2) return true;

  // Known rebrands
  for (const [r1, r2] of KNOWN_REBRANDS) {
    if ((n1 === r1 && n2 === r2) || (n1 === r2 && n2 === r1)) return true;
  }

  return false;
}

async function submitRun(
  firstName: string,
  lastName: string,
  companyDomain: string
): Promise<string | null> {
  const res = await fetch(`${BASE}/orchestration/runs`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      workflowUuid: WORKFLOW,
      releaseUuid: RELEASE,
      data: { firstName, lastName, companyDomain },
    }),
  });
  const data = (await res.json()) as { run?: { uuid?: string } };
  return data.run?.uuid || null;
}

// Cargo orchestration runs regularly take 60-90s because they spin up an
// underlying LinkedIn enrichment job. 20 attempts (60s ceiling) was biting on
// the open-deals backfill — ~20 contacts all timing out. Bumped to 60 attempts
// (180s ceiling) to match real-world latency.
async function pollRun(uuid: string, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${BASE}/orchestration/runs/${uuid}`, { headers: getHeaders() });
    const data = (await res.json()) as { run?: { status?: string } };
    const status = data.run?.status;
    if (status === "success" || status === "error") return status;
  }
  return "timeout";
}

async function getOutput(uuid: string, workflowUuid: string = WORKFLOW): Promise<{
  companyName?: string;
  companyDomain?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  email?: string;
  phone?: string;
} | null> {
  const res = await fetch(`${BASE}/orchestration/runs/download-outputs`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      workflowUuid: workflowUuid,
      outputNodeSlug: "end",
      format: "json",
      recordId: uuid,
      // Don't filter by statuses — some workflows (enrichProfile) mark _status
      // as "running" in the output even after the run reaches "success" in poll.
    }),
  });
  const data = (await res.json()) as { url?: string };
  if (data.url) {
    const r2 = await fetch(data.url);
    const results = (await r2.json()) as Array<{ output?: Record<string, unknown> }>;
    if (results?.[0]?.output) {
      const o = results[0].output;
      return {
        companyName: o.companyName as string | undefined,
        companyDomain: o.companyDomain as string | undefined,
        jobTitle: o.jobTitle as string | undefined,
        linkedinUrl: o.linkedinUrl as string | undefined,
      };
    }
  }
  return null;
}

/**
 * Verify if a contact still works at the expected company via Cargo/LinkedIn
 * @param firstName Contact's first name
 * @param lastName Contact's last name
 * @param expectedDomain The domain we expect them to work at
 * @returns Verification result with current employment info
 */
// --- Email Finding (1.1-4 credits) ---
// Verified 2026-04-30: old UUID 5071289f returned workflowNotFound.
// New UUID confirmed via GET /orchestration/workflows/list — inputs: firstName, lastName, companyDomain
const EMAIL_FIND_WORKFLOW = "5214c962-d7db-4774-b464-bbe97461f1f7";

export interface EmailFindResult {
  email: string | null;
  verified: boolean;
  error?: string;
}

export async function findEmail(
  firstName: string,
  lastName: string,
  companyDomain: string
): Promise<EmailFindResult> {
  if (!process.env.CARGO_API_KEY) {
    return { email: null, verified: false, error: "CARGO_API_KEY not set" };
  }

  try {
    const res = await fetch(`${BASE}/orchestration/runs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: EMAIL_FIND_WORKFLOW,
        data: { firstName, lastName, companyDomain },
      }),
    });
    const data = (await res.json()) as { run?: { uuid?: string } };
    const runId = data.run?.uuid;
    if (!runId) {
      return { email: null, verified: false, error: "Failed to submit Cargo email find" };
    }

    const status = await pollRun(runId, 20);
    if (status !== "success") {
      return { email: null, verified: false, error: `Cargo run ${status}` };
    }

    // Get output
    const outputRes = await fetch(`${BASE}/orchestration/runs/download-outputs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: EMAIL_FIND_WORKFLOW,
        outputNodeSlug: "end",
        format: "json",
        recordId: runId,
        statuses: ["success"],
      }),
    });
    const outputData = (await outputRes.json()) as { url?: string };
    if (outputData.url) {
      const r2 = await fetch(outputData.url);
      const results = (await r2.json()) as Array<{ output?: Record<string, unknown> }>;
      const o = results?.[0]?.output;
      if (o?.email) {
        return {
          email: o.email as string,
          verified: (o.verified as boolean) || (o.status === "valid"),
        };
      }
    }

    return { email: null, verified: false };
  } catch (err) {
    return { email: null, verified: false, error: String(err) };
  }
}

// --- Find Stakeholders (6.5 credits) ---
// Company-first people discovery via Sales Navigator legacy search.
// Used as Stage 2 fallback in tam-enrich when LeadMagic employeeFinder returns 0.
// See docs/providers/cargo.md for schema + "how to verify UUID" instructions.
const FIND_STAKEHOLDERS_WORKFLOW = "4b29f36e-525b-4295-97ab-6c2909d3a8e4";
const FIND_STAKEHOLDERS_RELEASE = "019cf563-d012-496b-86c7-4e9821742246";

// Sales Nav search is fuzzy/OR-joined on this comma-separated string.
// Sales Nav does partial match, so "CEO" catches "Co-Founder & CEO" etc.
// KEEP THIS LIST SHORT. Expanded lists (24+ terms) cause Sales Nav to hang
// indefinitely, burning 6.5 credits per timeout. For companies without sales
// orgs (common in SLED), Cargo returns 0 and LeadMagic fallback handles it.
// DO NOT expand this list to fix discovery gaps — that's what the fallback is for.
const DEFAULT_STAKEHOLDER_TITLES =
  "CEO, Founder, President, VP Sales, Chief Revenue Officer, Head of Sales, Director of Sales, Sales Director, Account Executive, SDR, BDR, Business Development";

export interface StakeholderRecord {
  full_name: string;
  title: string;
  linkedin_url: string | null;
  location: string | null; // Cargo stakeholders endpoint does not return location; always null.
}

export interface FindStakeholdersResult {
  stakeholders: StakeholderRecord[];
  credits_consumed: number;
  error?: string;
}

export async function findStakeholders(
  companyDomain: string,
  titles: string = DEFAULT_STAKEHOLDER_TITLES,
): Promise<FindStakeholdersResult> {
  if (!process.env.CARGO_API_KEY) {
    return { stakeholders: [], credits_consumed: 0, error: "CARGO_API_KEY not set" };
  }

  try {
    const submitRes = await fetch(`${BASE}/orchestration/runs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: FIND_STAKEHOLDERS_WORKFLOW,
        releaseUuid: FIND_STAKEHOLDERS_RELEASE,
        data: { companyDomain, titles },
      }),
    });
    const submitData = (await submitRes.json()) as { run?: { uuid?: string } };
    const runId = submitData.run?.uuid;
    if (!runId) {
      return {
        stakeholders: [],
        credits_consumed: 0,
        error: "Failed to submit Cargo stakeholders run",
      };
    }

    // Sales Nav is slow — 35–120s observed. 45 × 3s = 135s ceiling, leaving
    // ~45s headroom inside tam-enrich's 180s maxDuration for Stages 3–8
    // (jobsFinder, LLM sales classifier, technographics, sub-market classifier,
    // lead_summary, Supabase write).
    const status = await pollRun(runId, 45);
    if (status !== "success") {
      return { stakeholders: [], credits_consumed: 0, error: `Cargo run ${status}` };
    }

    const outRes = await fetch(`${BASE}/orchestration/runs/download-outputs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: FIND_STAKEHOLDERS_WORKFLOW,
        outputNodeSlug: "end",
        format: "json",
        recordId: runId,
        statuses: ["success"],
      }),
    });
    const outData = (await outRes.json()) as { url?: string };
    if (!outData.url) {
      return { stakeholders: [], credits_consumed: 0 };
    }

    const r2 = await fetch(outData.url);
    const results = (await r2.json()) as Array<{
      output?: {
        stakeholders?: Array<{
          firstName?: string;
          lastName?: string;
          title?: string;
          linkedinUrl?: string;
        }>;
      };
    }>;
    const raw = results?.[0]?.output?.stakeholders || [];
    const stakeholders: StakeholderRecord[] = raw.map((s) => ({
      full_name: `${s.firstName || ""} ${s.lastName || ""}`.trim(),
      title: s.title || "",
      linkedin_url: s.linkedinUrl || null,
      location: null,
    }));

    // Cargo bills on run submission (Sales Nav slot consumed regardless of
    // match count). Charge 6.5 whenever the run reached success, even if it
    // returned zero stakeholders.
    return {
      stakeholders,
      credits_consumed: 6.5,
    };
  } catch (err) {
    return { stakeholders: [], credits_consumed: 0, error: String(err) };
  }
}

// --- Email Verification (0.2 credits) ---
// Verified 2026-04-30: old UUID fb7787fc returned workflowNotFound.
// New UUID confirmed via GET /orchestration/workflows/list — node: verifyEmail
const EMAIL_VERIFY_WORKFLOW = "7c59c630-fcb0-4f85-b8fb-81ab60a3c4a1";

export interface EmailVerifyResult {
  valid: boolean;
  deliverable: boolean;
  error?: string;
}

export async function verifyEmail(email: string): Promise<EmailVerifyResult> {
  if (!process.env.CARGO_API_KEY) {
    return { valid: false, deliverable: false, error: "CARGO_API_KEY not set" };
  }

  try {
    const res = await fetch(`${BASE}/orchestration/runs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: EMAIL_VERIFY_WORKFLOW,
        data: { email },
      }),
    });
    const data = (await res.json()) as { run?: { uuid?: string } };
    const runId = data.run?.uuid;
    if (!runId) {
      return { valid: false, deliverable: false, error: "Failed to submit Cargo email verify" };
    }

    const status = await pollRun(runId, 15);
    if (status !== "success") {
      return { valid: false, deliverable: false, error: `Cargo run ${status}` };
    }

    // Get output
    const outputRes = await fetch(`${BASE}/orchestration/runs/download-outputs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: EMAIL_VERIFY_WORKFLOW,
        outputNodeSlug: "end",
        format: "json",
        recordId: runId,
        statuses: ["success"],
      }),
    });
    const outputData = (await outputRes.json()) as { url?: string };
    if (outputData.url) {
      const r2 = await fetch(outputData.url);
      const results = (await r2.json()) as Array<{ output?: Record<string, unknown> }>;
      const o = results?.[0]?.output;
      if (o) {
        return {
          valid: (o.valid as boolean) || (o.status === "valid"),
          deliverable: (o.deliverable as boolean) || (o.result === "deliverable"),
        };
      }
    }

    return { valid: false, deliverable: false };
  } catch (err) {
    return { valid: false, deliverable: false, error: String(err) };
  }
}

// --- URL-based verification (0.5 credits) --- PREFERRED ---
// Direct LinkedIn profile enrichment — 75% reliable vs 44% for name-based.
// Always prefer this when a LinkedIn URL is available.
// Workflow: enrichProfile (53f31647)
const ENRICH_PROFILE_WORKFLOW = "53f31647-c4c9-4c55-ac72-0af70ddbc8cb";
const ENRICH_PROFILE_RELEASE = "ca3d8da1-fc24-45be-9368-77100af6e181";

export async function verifyEmploymentByUrl(
  linkedinUrl: string,
  expectedDomain: string,
): Promise<VerifyResult> {
  if (!process.env.CARGO_API_KEY) {
    return { verified: false, departed: false, currentCompany: null, currentDomain: null, currentTitle: null, linkedinUrl, error: "CARGO_API_KEY not set" };
  }

  try {
    const submitRes = await fetch(`${BASE}/orchestration/runs`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        workflowUuid: ENRICH_PROFILE_WORKFLOW,
        releaseUuid: ENRICH_PROFILE_RELEASE,
        data: { linkedinUrl },
      }),
    });
    const submitData = (await submitRes.json()) as { run?: { uuid?: string } };
    const runId = submitData.run?.uuid;
    if (!runId) {
      return { verified: false, departed: false, currentCompany: null, currentDomain: null, currentTitle: null, linkedinUrl, error: "Failed to submit Cargo enrichProfile run" };
    }

    const status = await pollRun(runId, 60);
    if (status !== "success") {
      return { verified: false, departed: false, currentCompany: null, currentDomain: null, currentTitle: null, linkedinUrl, error: `Cargo run ${status}` };
    }

    // Reuse getOutput — same output shape (companyName, companyDomain, jobTitle, linkedinUrl)
    const output = await getOutput(runId, ENRICH_PROFILE_WORKFLOW);
    if (!output) {
      return { verified: false, departed: false, currentCompany: null, currentDomain: null, currentTitle: null, linkedinUrl, error: "No output from Cargo enrichProfile" };
    }

    const match = domainsMatch(expectedDomain, output.companyDomain || null);
    return {
      verified: match,
      departed: !match && !!output.companyDomain,
      currentCompany: output.companyName || null,
      currentDomain: output.companyDomain || null,
      currentTitle: output.jobTitle || null,
      linkedinUrl: output.linkedinUrl || linkedinUrl,
      email: output.email || null,
      phone: output.phone || null,
    };
  } catch (err) {
    return { verified: false, departed: false, currentCompany: null, currentDomain: null, currentTitle: null, linkedinUrl, error: String(err) };
  }
}

// --- Name-based verification (0.5 credits) --- FALLBACK ---
// Only use when no LinkedIn URL is available. 44% reliability.
export async function verifyEmployment(
  firstName: string,
  lastName: string,
  expectedDomain: string
): Promise<VerifyResult> {
  if (!process.env.CARGO_API_KEY) {
    return {
      verified: false,
      departed: false,
      currentCompany: null,
      currentDomain: null,
      currentTitle: null,
      linkedinUrl: null,
      error: "CARGO_API_KEY not set",
    };
  }

  try {
    // Submit the run
    const runId = await submitRun(firstName, lastName, expectedDomain);
    if (!runId) {
      return {
        verified: false,
        departed: false,
        currentCompany: null,
        currentDomain: null,
        currentTitle: null,
        linkedinUrl: null,
        error: "Failed to submit Cargo run",
      };
    }

    // Poll for completion — LinkedIn enrichment runs commonly take 60-120s.
    // 60 attempts × 3s = 180s ceiling (bumped Apr 17 for open-deals backfill).
    const status = await pollRun(runId, 60);
    if (status !== "success") {
      return {
        verified: false,
        departed: false,
        currentCompany: null,
        currentDomain: null,
        currentTitle: null,
        linkedinUrl: null,
        error: `Cargo run ${status}`,
      };
    }

    // Get the output
    const output = await getOutput(runId);
    if (!output) {
      return {
        verified: false,
        departed: false,
        currentCompany: null,
        currentDomain: null,
        currentTitle: null,
        linkedinUrl: null,
        error: "No output from Cargo",
      };
    }

    // Compare domains with smart matching
    const match = domainsMatch(expectedDomain, output.companyDomain || null);

    return {
      verified: match,
      departed: !match && !!output.companyDomain,
      currentCompany: output.companyName || null,
      currentDomain: output.companyDomain || null,
      currentTitle: output.jobTitle || null,
      linkedinUrl: output.linkedinUrl || null,
    };
  } catch (err) {
    return {
      verified: false,
      departed: false,
      currentCompany: null,
      currentDomain: null,
      currentTitle: null,
      linkedinUrl: null,
      error: String(err),
    };
  }
}
