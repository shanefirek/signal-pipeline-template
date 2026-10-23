// TAM ICP Scoring — vertical-agnostic, data-driven
//
// Uses LeadMagic data (employees, jobs, tech stack) for scoring.
// Reuses existing scoring functions from icp.ts where applicable.
// Clay's outbound need scoring rules ported as deterministic logic.
//
// Source: ~/projects/acme-clay/tables/scoring.md (field f_0tam8l8judgHpARSSFW)

import { scoreVerticalFit, scoreHeadcount, scoreCompanyStage } from "./icp.js";
import { scoreFunding } from "../lib/funding.js"; // scoreFunding(fundingStage: string | null) → number
import type { SalesTeamAnalysis } from "../enrichment/providers/leadmagic-company.js";

// --- Outbound Need Score (0-50) ---
// Same rules as Clay's scoring model, deterministic instead of Claude Haiku.
// Fed by LeadMagic employee/job data.
//
// Priority order (first match wins):
//   Has SDR/BDR on team:    10 (they have it, don't need us)
//   4+ AEs no SDRs:         35 (scaling, need help managing pipeline)
//   2-3 AEs no SDRs:        50 (golden ICP — AEs starving for meetings)
//   Founder selling:         45 (no sales team, founder doing everything)
//   Single AE no SDR:        40 (one AE, no pipeline generation)
//   Hiring sales no SDR:     25 (actively investing in sales, might want us)
//   No data:                  5

export function scoreSalesTeamReal(analysis: SalesTeamAnalysis): {
  score: number;
  pattern: string;
} {
  // Rule 1: Has SDR/BDR = 10 (they have it already)
  if (analysis.sdr_count > 0 || analysis.hiring_sdr) {
    return { score: 10, pattern: "has_sdr" };
  }

  // Rule 2: 4+ AEs no SDRs = 35 (scaling, need pipeline help)
  if (analysis.ae_count >= 4) {
    return { score: 35, pattern: "4plus_ae_no_sdr" };
  }

  // Rule 3: 2-3 AEs no SDRs = 50 (golden ICP)
  if (analysis.ae_count >= 2 && analysis.ae_count <= 3) {
    return { score: 50, pattern: "2_3_ae_no_sdr" };
  }

  // Rule 4: Founder selling = 45 (no sales team)
  if (analysis.founder_selling && analysis.ae_count === 0) {
    return { score: 45, pattern: "founder_selling" };
  }

  // Rule 5: Single AE no SDR = 40
  if (analysis.ae_count === 1) {
    return { score: 40, pattern: "single_ae_no_sdr" };
  }

  // Rule 6: Hiring for sales (not SDR) = 25
  if (analysis.hiring_sales || analysis.hiring_ae) {
    return { score: 25, pattern: "hiring_sales_no_sdr" };
  }

  // Rule 7: No data = 5
  return { score: 5, pattern: "no_data" };
}

// --- Tech Stack Score (0-15) ---
// Detects outbound/sales tools from LeadMagic technographics.
// No outbound tools = they need help (15). Full stack = they're covered (0).

const OUTBOUND_TOOLS = [
  "salesloft", "outreach", "apollo", "lusha", "zoominfo", "6sense",
  "gong", "chorus", "clari", "vidyard", "drift", "qualified",
  "seamless", "cognism", "rocketreach", "snov", "hunter",
  "lemlist", "instantly", "smartlead", "reply.io",
];

const CRM_TOOLS = [
  "hubspot", "salesforce", "pipedrive", "zoho crm", "freshsales",
  "close", "copper", "insightly",
];

const ENGAGEMENT_TOOLS = [
  "salesloft", "outreach", "apollo", "gong", "chorus", "vidyard",
  "lemlist", "instantly", "smartlead", "reply.io",
];

const DATA_TOOLS = [
  "zoominfo", "6sense", "lusha", "cognism", "rocketreach",
  "seamless", "snov", "hunter", "clearbit", "bombora",
];

export function scoreTechStack(technologies: Array<{ name: string; categories?: string[] }>): {
  score: number;
  has_crm: boolean;
  has_engagement: boolean;
  has_data: boolean;
  outbound_tools: string[];
} {
  const techNames = technologies.map((t) => t.name.toLowerCase());

  const has_crm = techNames.some((t) => CRM_TOOLS.some((crm) => t.includes(crm)));
  const has_engagement = techNames.some((t) => ENGAGEMENT_TOOLS.some((eng) => t.includes(eng)));
  const has_data = techNames.some((t) => DATA_TOOLS.some((data) => t.includes(data)));
  const outbound_tools = techNames.filter((t) => OUTBOUND_TOOLS.some((ob) => t.includes(ob)));

  let score: number;
  if (has_engagement && has_data) {
    score = 0; // Full outbound stack — they're covered
  } else if (has_engagement) {
    score = 5; // Has engagement tool but no data source
  } else if (has_crm) {
    score = 10; // Basic CRM only — needs outbound infrastructure
  } else {
    score = 15; // Nothing — they definitely need help
  }

  return { score, has_crm, has_engagement, has_data, outbound_tools };
}

// --- Sales Org Summary (deterministic) ---
// Generates a 1-2 sentence summary from real data. Same output format as Clay's GPT-4o-mini summary.

export function generateSalesOrgSummary(analysis: SalesTeamAnalysis): string {
  const parts: string[] = [];

  // AE count
  if (analysis.ae_count > 0) {
    const aeNames = analysis.sales_employees
      .filter((e) => /account executive|ae/i.test(e.title))
      .slice(0, 2)
      .map((e) => e.name);
    if (aeNames.length > 0) {
      parts.push(`${analysis.ae_count} AE${analysis.ae_count > 1 ? "s" : ""} (${aeNames.join(", ")})`);
    } else {
      parts.push(`${analysis.ae_count} AE${analysis.ae_count > 1 ? "s" : ""}`);
    }
  }

  // SDR count
  if (analysis.sdr_count > 0) {
    parts.push(`${analysis.sdr_count} SDR${analysis.sdr_count > 1 ? "s" : ""}`);
  } else {
    parts.push("no SDRs");
  }

  // Leadership
  if (analysis.has_vp_sales) {
    const vp = analysis.sales_employees.find((e) => /vp.?sales|head of sales|cro/i.test(e.title));
    parts.push(vp ? `VP Sales (${vp.name})` : "VP Sales");
  } else if (analysis.has_sales_director) {
    const dir = analysis.sales_employees.find((e) => /director\b.*\bsales|sales director/i.test(e.title));
    parts.push(dir ? `Sales Director (${dir.name})` : "Sales Director");
  } else if (analysis.has_sales_manager) {
    const mgr = analysis.sales_employees.find((e) => /sales manager/i.test(e.title));
    parts.push(mgr ? `Sales Manager (${mgr.name})` : "Sales Manager");
  }

  // Founder selling
  if (analysis.founder_selling && analysis.ae_count === 0) {
    const founder = analysis.sales_employees.find((e) => /founder|ceo|owner/i.test(e.title));
    parts.push(founder ? `Founder selling (${founder.name})` : "Founder selling directly");
  }

  let summary = parts.join(", ") + ".";

  // Hiring signals
  if (analysis.hiring_sdr) {
    summary += " Hiring SDRs.";
  } else if (analysis.hiring_ae) {
    summary += " Hiring AEs.";
  } else if (analysis.hiring_sales) {
    summary += " Hiring for sales roles.";
  } else {
    summary += " No active sales hiring.";
  }

  return summary;
}

// --- Composite TAM ICP Score ---

export interface TamICPBreakdown {
  vertical_fit: number;      // 0-35
  headcount: number;         // 0-15
  company_stage: number;     // 0-30
  outbound_need: number;     // 0-50
  funding: number;           // 0-30
  tech_stack: number;        // 0-15
  raw_total: number;         // 0-175
  outbound_pattern: string;  // "2_3_ae_no_sdr", "founder_selling", etc.
}

export function computeTamICP(params: {
  sub_market?: string | null;
  employee_count?: number | null;
  annual_revenue?: string | null;
  funding_stage?: string | null;
  sales_team: SalesTeamAnalysis;
  technologies?: Array<{ name: string; categories?: string[] }>;
}): TamICPBreakdown {
  const vertical_fit = scoreVerticalFit(params.sub_market);
  const headcount = scoreHeadcount(params.employee_count);
  const company_stage = scoreCompanyStage(params.annual_revenue);

  const salesResult = scoreSalesTeamReal(params.sales_team);
  const outbound_need = salesResult.score;

  const funding = scoreFunding(params.funding_stage);

  const techResult = params.technologies
    ? scoreTechStack(params.technologies)
    : { score: 15 }; // No data = benefit of doubt (they need help)
  const tech_stack = techResult.score;

  const raw_total = vertical_fit + headcount + company_stage + outbound_need + funding + tech_stack;

  return {
    vertical_fit,
    headcount,
    company_stage,
    outbound_need,
    funding,
    tech_stack,
    raw_total,
    outbound_pattern: salesResult.pattern,
  };
}

// --- TAM Tier Assignment ---

export function tamTier(rawScore: number): "T1" | "T2" | "T3" | "DQ" {
  if (rawScore >= 120) return "T1";
  if (rawScore >= 80) return "T2";
  if (rawScore >= 50) return "T3";
  return "DQ";
}
