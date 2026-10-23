// LeadMagic Company Enrichment — firmographics, employees, jobs, technographics
// Replaces MixRank (via Clay) for TAM mapping. Separate from leadmagic.ts (email/phone).
//
// Auth: X-API-Key header (NOT Bearer token)
// Base URL: https://api.leadmagic.io/v1
// Docs: LEADMAGIC.md

const LEADMAGIC_BASE_URL = "https://api.leadmagic.io/v1";

function getHeaders(): Record<string, string> | null {
  const apiKey = process.env.LEADMAGIC_API_KEY;
  if (!apiKey) return null;
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const headers = getHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[leadmagic-company] POST ${path} failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }

    return res.json() as Promise<T>;
  } catch (err) {
    console.error(`[leadmagic-company] POST ${path} error:`, err);
    return null;
  }
}

// --- Company Search (1 credit) ---

export interface CompanySearchResult {
  companyName: string;
  industry: string;
  employeeCount: number;
  employeeRange: string | null;
  founded: number | null;
  revenue: number | null;
  revenue_formatted: string | null;
  total_funding: number | null;
  total_funding_formatted: string | null;
  funding_rounds: number | null;
  last_funding_round: string | null;
  last_funding_amount: number | null;
  ownership_status: string | null;
  description: string;
  specialities: string[];
  linkedin_url: string | null;
  headquarters: Record<string, unknown> | null;
  credits_consumed: number;
}

export async function companySearch(domain: string): Promise<CompanySearchResult | null> {
  return post<CompanySearchResult>("/companies/company-search", { company_domain: domain });
}

// --- Employee Finder (0.05 credits/employee) ---

export interface Employee {
  full_name: string;
  title: string;
  linkedin_url: string | null;
  location: string | null;
}

export interface EmployeeFinderResult {
  employees: Employee[];
  total_count: number;
  credits_consumed: number;
}

export async function employeeFinder(domain: string, limit = 50): Promise<EmployeeFinderResult | null> {
  const result = await post<any>("/people/employee-finder", {
    company_domain: domain,
    limit,
  });

  if (!result) return null;

  // Normalize response shape — API returns { data: [...] } or { employees: [...] } or array
  const rawList = Array.isArray(result)
    ? result
    : (result.data || result.employees || result.results || []);

  const employees: Employee[] = rawList.map((e: any) => ({
    full_name: e.full_name || `${e.first_name || ""} ${e.last_name || ""}`.trim(),
    title: e.title || e.job_title || "",
    linkedin_url: e.linkedin_url || e.profile_url || null,
    location: e.location || null,
  }));

  return {
    employees,
    total_count: result.total_count || employees.length,
    credits_consumed: result.credits_consumed || employees.length * 0.05,
  };
}

// --- Jobs Finder (1 credit/job) ---

export interface JobPosting {
  title: string;
  location: string | null;
  experience_level: string | null;
  published: string | null;
  description: string | null;
  application_url: string | null;
}

export interface JobsFinderResult {
  jobs: JobPosting[];
  total_count: number;
  credits_consumed: number;
}

export async function jobsFinder(domain: string, jobTitle?: string, perPage = 20): Promise<JobsFinderResult | null> {
  const body: Record<string, unknown> = {
    company_website: domain,
    per_page: perPage,
  };
  if (jobTitle) body.job_title = jobTitle;

  const result = await post<any>("/jobs/jobs-finder", body);
  if (!result) return null;

  const jobs: JobPosting[] = (result.results || []).map((j: any) => ({
    title: j.title || "",
    location: j.location || null,
    experience_level: j.experience_level || null,
    published: j.published || null,
    description: j.description?.slice(0, 500) || null,
    application_url: j.application_url || null,
  }));

  return {
    jobs,
    total_count: result.total_count || jobs.length,
    credits_consumed: result.credits_consumed || jobs.length,
  };
}

// --- Technographics (1 credit) ---

export interface Technology {
  name: string;
  categories: string[];
}

export interface TechnographicsResult {
  technologies: Technology[];
  credits_consumed: number;
}

export async function technographics(domain: string): Promise<TechnographicsResult | null> {
  const result = await post<any>("/companies/technographics", { company_domain: domain });
  if (!result) return null;

  const techs: Technology[] = (result.technologies || result.data || []).map((t: any) => ({
    name: t.name || "",
    categories: Array.isArray(t.categories) ? t.categories : [],
  }));

  return {
    technologies: techs,
    credits_consumed: result.credits_consumed || (techs.length > 0 ? 1 : 0),
  };
}

// --- Sales Team Extraction Helpers ---

const SALES_TITLE_PATTERNS = {
  ae: /\b(account executive|ae)\b/i,
  sdr: /\b(sdr|bdr|sales development|business development rep)\b/i,
  vp_sales: /\b(vp.?sales|vice president.?sales|head of sales|chief revenue|cro)\b/i,
  // "director.+sales" catches "Director of K-12 Sales", "Director of Enterprise Sales", etc.
  sales_director: /\b(sales director|director\b.+\bsales|regional.?sales)\b/i,
  sales_manager: /\b(sales manager)\b/i,
  founder_selling: /\b(founder|co-founder|ceo|owner|president)\b/i,
};

const SALES_JOB_PATTERNS = {
  sdr_hiring: /\b(sdr|bdr|sales development|business development rep)\b/i,
  ae_hiring: /\b(account executive|ae|sales representative)\b/i,
  sales_hiring: /\b(sales|business development|account manager|revenue)\b/i,
};

export interface SalesTeamAnalysis {
  ae_count: number;
  sdr_count: number;
  has_vp_sales: boolean;
  has_sales_director: boolean;
  has_sales_manager: boolean;
  founder_selling: boolean;
  sales_employees: Array<{ name: string; title: string }>;
  hiring_sdr: boolean;
  hiring_ae: boolean;
  hiring_sales: boolean;
  sales_jobs: Array<{ title: string }>;
}

export function analyzeSalesTeam(
  employees: Employee[],
  jobs: JobPosting[],
  employeeCount?: number | null,
): SalesTeamAnalysis {
  let ae_count = 0;
  let sdr_count = 0;
  let has_vp_sales = false;
  let has_sales_director = false;
  let has_sales_manager = false;
  let founder_selling = false;
  const sales_employees: Array<{ name: string; title: string }> = [];

  for (const emp of employees) {
    const t = emp.title || "";
    if (SALES_TITLE_PATTERNS.sdr.test(t)) {
      sdr_count++;
      sales_employees.push({ name: emp.full_name, title: t });
    } else if (SALES_TITLE_PATTERNS.ae.test(t)) {
      ae_count++;
      sales_employees.push({ name: emp.full_name, title: t });
    } else if (SALES_TITLE_PATTERNS.vp_sales.test(t)) {
      has_vp_sales = true;
      sales_employees.push({ name: emp.full_name, title: t });
    } else if (SALES_TITLE_PATTERNS.sales_director.test(t)) {
      has_sales_director = true;
      sales_employees.push({ name: emp.full_name, title: t });
    } else if (SALES_TITLE_PATTERNS.sales_manager.test(t)) {
      has_sales_manager = true;
      sales_employees.push({ name: emp.full_name, title: t });
    } else if (SALES_TITLE_PATTERNS.founder_selling.test(t) && (employeeCount || 0) < 30) {
      founder_selling = true;
      sales_employees.push({ name: emp.full_name, title: t });
    }
  }

  // VP Sales / Sales Director implies team — count as multi-AE if no AEs explicitly found
  if ((has_vp_sales || has_sales_director) && ae_count === 0) {
    ae_count = 2; // Heuristic: leadership title implies at least 2 AEs reporting
  }

  let hiring_sdr = false;
  let hiring_ae = false;
  let hiring_sales = false;
  const sales_jobs: Array<{ title: string }> = [];

  for (const job of jobs) {
    const t = job.title || "";
    if (SALES_JOB_PATTERNS.sdr_hiring.test(t)) {
      hiring_sdr = true;
      sales_jobs.push({ title: t });
    } else if (SALES_JOB_PATTERNS.ae_hiring.test(t)) {
      hiring_ae = true;
      sales_jobs.push({ title: t });
    } else if (SALES_JOB_PATTERNS.sales_hiring.test(t)) {
      hiring_sales = true;
      sales_jobs.push({ title: t });
    }
  }

  return {
    ae_count,
    sdr_count,
    has_vp_sales,
    has_sales_director,
    has_sales_manager,
    founder_selling,
    sales_employees,
    hiring_sdr,
    hiring_ae,
    hiring_sales,
    sales_jobs,
  };
}

// --- LLM Sales Team Classifier ---
// Replaces regex-based analyzeSalesTeam for accuracy on edge cases:
// - Title inflation at small companies ("Director of Sales" = AE, not leader)
// - Ambiguous titles ("Business Development Manager" = AE at small co)
// - Non-sales exclusions (CS, RevOps, Sales Engineer, Enablement)
//
// Uses Haiku — ~$0.001 per company, ~500ms latency.

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 4,
});

export interface LLMClassifiedSalesTeam extends SalesTeamAnalysis {
  llm_summary: string; // Factual 1-sentence for AE consumption
}

export async function classifySalesTeamLLM(
  employees: Employee[],
  jobs: JobPosting[],
  companyName: string,
  employeeCount: number | null,
): Promise<LLMClassifiedSalesTeam> {
  const empList = employees.map((e) => `- ${e.full_name}: ${e.title}`).join("\n");
  const jobList = jobs.length ? jobs.map((j) => `- ${j.title}`).join("\n") : "None";

  const prompt = `You are classifying the sales team at ${companyName} (${employeeCount || "unknown"} employees).

EMPLOYEES:
${empList || "None found"}

OPEN JOBS:
${jobList}

TASK: Identify everyone in a NEW BUSINESS SALES role — people who generate pipeline or close new deals.

CLASSIFICATION RULES:

"ae" — anyone whose primary job is selling or closing new business:
  - Account Executive, Sales Rep, Sales Consultant
  - At companies under 75 employees, "Sales Director", "VP Sales", "CRO", "Head of Sales" are almost always ICs who sell, NOT managers. Classify them as "ae".
  - "Channel Account Executive", "Channel Sales", "Partner Sales" = ae
  - "Business Development Manager" at a small company = ae (they're selling)
  - When in doubt at a small company: if the title has "sales" in it and there's no one below them, they're an ae.

"sdr" — anyone whose primary job is outbound prospecting or appointment setting:
  - SDR, BDR, Sales Development Rep, Business Development Representative
  - NOT "Business Development Manager" or "Director of Business Development" (those are ae-level)

"sales_leader" — a TRUE people manager overseeing other salespeople. ALL THREE must be true:
  (a) Their title implies management (VP Sales, CRO, Head of Sales, Sales Director)
  (b) There are at least 2 AEs visible in the employee list below them
  (c) The company has 75+ employees
  If ANY condition fails, classify them as "ae" instead. This is strict — most companies in our pipeline are under 75 people, so sales_leader should be RARE.

"founder_seller" — Founder/CEO/President who is selling:
  - Only if the company has fewer than 30 employees
  - Only if they appear to be the primary or sole seller (no AE team visible)
  - At 30+ employees, do NOT classify founders as sellers unless they explicitly have a sales-related title

NOT SALES (ignore completely):
  - Customer Success, Account Manager, Implementation, Onboarding
  - Partnerships, Strategic Alliances, Business Development focused on partnerships
  - Sales Engineer, Solutions Consultant, Pre-Sales, Demo Specialist
  - Sales Enablement, Revenue Operations, Sales Operations
  - Marketing, Product, Engineering, Design, HR, Finance, Legal, Operations

SUMMARY FORMAT:
One sentence. Group by title count, then note outbound/SDR presence and hiring.
- Format: "3 National Account Managers, 1 Sales & Marketing Manager — no SDRs, not hiring."
- Another example: "1 CRO, 2 Account Executives — 1 SDR, hiring AE."
- Use the REAL titles from the employee list, not generic labels. Do NOT say "AE" if their title is "National Account Manager."
- If hiring sales roles: note it at the end.
- If no sales team: "No identifiable sales team on LinkedIn."

Return a JSON object:
{
  "sellers": [{ "name": "string", "title": "their actual title", "role": "ae|sdr|sales_leader|founder_seller" }],
  "ae_count": number,
  "sdr_count": number,
  "has_sales_leadership": boolean,
  "founder_selling": boolean,
  "hiring_sdr": boolean,
  "hiring_ae": boolean,
  "hiring_sales": boolean,
  "summary": "string"
}

Analyze the employees and jobs listed above and classify the sales team.`;

  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [{
        name: "classify_sales_team",
        description: "Classify the sales team structure at a company based on employee and job data.",
        input_schema: {
          type: "object" as const,
          properties: {
            sellers: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  name: { type: "string" as const },
                  title: { type: "string" as const, description: "Their actual title, not a generic label" },
                  role: { type: "string" as const, enum: ["ae", "sdr", "sales_leader", "founder_seller"] },
                },
                required: ["name", "title", "role"],
              },
            },
            ae_count: { type: "number" as const },
            sdr_count: { type: "number" as const },
            has_sales_leadership: { type: "boolean" as const },
            founder_selling: { type: "boolean" as const },
            hiring_sdr: { type: "boolean" as const },
            hiring_ae: { type: "boolean" as const },
            hiring_sales: { type: "boolean" as const },
            summary: { type: "string" as const, description: "One sentence describing the sales org with real names and titles. Format: 'Name (Title), Name (Title) — no SDRs.' If hiring, append 'Hiring [role].' If no sales team: 'No identifiable sales team on LinkedIn.'" },
          },
          required: ["sellers", "ae_count", "sdr_count", "has_sales_leadership", "founder_selling", "hiring_sdr", "hiring_ae", "hiring_sales", "summary"],
        },
      }],
      tool_choice: { type: "tool" as const, name: "classify_sales_team" },
      messages: [{ role: "user", content: prompt }],
    });

    const toolBlock = r.content.find((b: any) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("No tool_use response from classifier");
    const parsed = toolBlock.input as any;

    // Map to SalesTeamAnalysis shape for compatibility
    return {
      ae_count: parsed.ae_count || 0,
      sdr_count: parsed.sdr_count || 0,
      has_vp_sales: parsed.has_sales_leadership || false,
      has_sales_director: (parsed.sellers || []).some((s: any) => /director/i.test(s.title) && s.role === "ae"),
      has_sales_manager: false,
      founder_selling: parsed.founder_selling || false,
      sales_employees: (parsed.sellers || []).map((s: any) => ({ name: s.name, title: s.title })),
      hiring_sdr: parsed.hiring_sdr || false,
      hiring_ae: parsed.hiring_ae || false,
      hiring_sales: parsed.hiring_sales || false,
      sales_jobs: jobs.filter((j) => /sales|sdr|bdr|account exec/i.test(j.title)).map((j) => ({ title: j.title })),
      llm_summary: parsed.summary || "",
    };
  } catch (err) {
    // Fallback to regex classifier if LLM fails
    console.error(`[classifySalesTeamLLM] Failed for ${companyName}, falling back to regex:`, err);
    const regexResult = analyzeSalesTeam(employees, jobs, employeeCount);
    return { ...regexResult, llm_summary: "" };
  }
}
