import Anthropic from "@anthropic-ai/sdk";
import type { SalesTeamAnalysis } from "../enrichment/providers/leadmagic-company.js";

// AI-generated lead summaries — AE call briefs (2-3 sentences)
//
// Prompt is lead-source-aware:
// - TAM/outbound → cold call brief (why they need SDRs, what to say)
// - Signal/MQL → inbound brief (what they did, how to reference it)
// - Backfill/unknown → research brief (check LinkedIn before calling)
//
// Called from BOTH:
//   - enrich-contact.ts (contact-level, has signal data)
//   - enrich-company.ts / tam-enrich.ts (company-level, contact_name=null)

// maxRetries: 6 — the SDK auto-retries 429s with exponential backoff using the
// `retry-after` header. Bumped from default (2) so we don't have to fail the
// whole backfill on a transient rate limit hiccup. Each retry doubles the wait
// up to ~60s, so 6 retries gives plenty of headroom on Tier 1 (50 RPM cap).
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 6,
});

export interface SummaryInput {
  // Contact
  contact_name: string | null;
  title: string | null;
  email: string | null;

  // Company basics
  company_name: string | null;
  domain: string;
  description?: string | null;
  employee_count?: number | null;
  industry?: string | null;
  sub_market: string | null;

  // Sales org context (from LeadMagic)
  sales_team_data?: string | null;

  // Funding
  funding_stage?: string | null;
  funding_total?: number | null;

  // Signal data
  page_views?: number | null;
  sessions?: number | null;
  active_time_seconds?: number | null;
  pages_visited?: string | null;
  linkedin_action?: string | null;
  syft_purchase_intent?: string | null;
  lead_source?: string | null;
  signal_date?: string | null;  // ISO date of the latest signal

  // Fibbler
  fibbler_clicks?: number | null;
  fibbler_leads?: number | null;
  fibbler_impressions?: number | null;

  // Scoring
  icp_score: number;
  intent_score: number;
  total_score: number;
  tier: string;
  vertical_fit_score?: number | null;
  outbound_need_score?: number | null;

  // UTMs
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
}

// Format a structured SalesTeamAnalysis (from LeadMagic) into a pipe-delimited
// factual string for the lead_summary prompt.
//
// Example output:
//   "2 AEs (John Smith, Jane Doe) | no SDRs | VP Sales (Bob Jones) | hiring 1 SDR role"
export function formatSalesAnalysisForPrompt(analysis: SalesTeamAnalysis | null | undefined): string {
  if (!analysis) return "";

  const parts: string[] = [];

  // AE count + names (up to 2 names for context)
  if (analysis.ae_count > 0) {
    const aeNames = analysis.sales_employees
      .filter((e) => /\b(account executive|ae)\b/i.test(e.title))
      .slice(0, 2)
      .map((e) => e.name)
      .join(", ");
    parts.push(aeNames ? `${analysis.ae_count} AEs (${aeNames})` : `${analysis.ae_count} AEs`);
  } else if (!analysis.founder_selling) {
    parts.push("0 AEs");
  }

  // SDR count
  if (analysis.sdr_count > 0) {
    parts.push(`${analysis.sdr_count} SDRs`);
  } else {
    parts.push("no SDRs");
  }

  // Leadership titles
  if (analysis.has_vp_sales) {
    const vpName = analysis.sales_employees.find((e) =>
      /\b(vp.?sales|vice president.?sales|head of sales|cro|chief revenue)\b/i.test(e.title),
    );
    parts.push(vpName ? `VP Sales (${vpName.name})` : "VP Sales");
  } else if (analysis.has_sales_director) {
    parts.push("Sales Director");
  } else if (analysis.has_sales_manager) {
    parts.push("Sales Manager");
  }

  // Founder selling (only when no AEs)
  if (analysis.founder_selling && analysis.ae_count === 0) {
    const founderName = analysis.sales_employees.find((e) =>
      /\b(founder|co-founder|ceo|owner|president)\b/i.test(e.title),
    );
    parts.push(founderName ? `founder selling (${founderName.name})` : "founder selling");
  }

  // Hiring signals
  const hiring: string[] = [];
  if (analysis.hiring_sdr) hiring.push("SDR");
  if (analysis.hiring_ae) hiring.push("AE");
  if (analysis.hiring_sales && !analysis.hiring_sdr && !analysis.hiring_ae) hiring.push("sales");
  if (hiring.length > 0) {
    parts.push(`hiring ${hiring.join(" + ")}`);
  } else {
    parts.push("not actively hiring sales");
  }

  return parts.join(" | ");
}

export async function generateLeadSummary(input: SummaryInput): Promise<string> {
  // Build signal context
  const signalParts: string[] = [];

  if (input.page_views && input.page_views > 0) {
    signalParts.push(`${input.page_views} page views`);
  }
  if (input.sessions && input.sessions > 0) {
    signalParts.push(`${input.sessions} sessions`);
  }
  if (input.active_time_seconds && input.active_time_seconds > 0) {
    const mins = Math.round(input.active_time_seconds / 60);
    signalParts.push(`${mins} min on site`);
  }
  if (input.pages_visited) {
    const pages = input.pages_visited.split(",").map(p => {
      const match = p.trim().match(/\/([^/]+)\/?$/);
      return match ? match[1] : p.trim();
    }).filter(Boolean).slice(0, 5);
    if (pages.length) signalParts.push(`visited: ${pages.join(", ")}`);
  }
  if (input.linkedin_action) {
    signalParts.push(`LinkedIn: ${input.linkedin_action}`);
  }
  if (input.syft_purchase_intent) {
    signalParts.push(`purchase intent: ${input.syft_purchase_intent}`);
  }
  if (input.fibbler_clicks && input.fibbler_clicks > 0) {
    signalParts.push(`${input.fibbler_clicks} LinkedIn ad clicks`);
  }
  if (input.fibbler_leads && input.fibbler_leads > 0) {
    signalParts.push(`${input.fibbler_leads} LinkedIn ad leads`);
  }
  if (input.utm_source) {
    signalParts.push(`source: ${input.utm_source}/${input.utm_medium || "direct"}`);
  }

  // Prepend signal date if available — AE needs to know how fresh the signal is
  // Always use actual date (not "today") so summary doesn't become stale
  if (signalParts.length > 0 && input.signal_date) {
    const d = new Date(input.signal_date);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    signalParts.unshift(dateStr);
  }

  const hasSignal = signalParts.length > 0;

  // Sales org context from LeadMagic
  const salesOrgContext = input.sales_team_data || "";

  // Contact line is optional — when called from enrich-company / tam-enrich at
  // company-level, contact_name and title are null and we omit the line entirely
  // so Claude doesn't reference a phantom person.
  const hasContact = !!(input.contact_name || input.title);
  const contactLine = hasContact
    ? `Contact: ${input.contact_name || "Unknown"} (${input.title || "Unknown title"})\n`
    : "";

  // Lead source context — tells the prompt HOW this lead arrived
  // TAM = we picked them (outbound). Signal = they came to us (inbound intent).
  // Backfill = legacy CRM record, origin unknown.
  let sourceContext: string;
  const src = (input.lead_source || "").toLowerCase();
  if (src === "tam_import" || src === "salesnav_import") {
    sourceContext = "OUTBOUND TARGET — we selected this company, they did NOT come to us. The AE is cold-calling. Frame the summary as a call brief: why this company needs SDR help and what to say on the call.";
  } else if (src === "hubspot_backfill" || !src) {
    sourceContext = "LEGACY CRM RECORD — origin unknown, no behavioral signal. Frame as a research brief: what the company does and their sales org, then tell the AE to check LinkedIn for recent activity before calling.";
  } else {
    sourceContext = `INBOUND SIGNAL — this company showed intent (${hasSignal ? signalParts.join(", ") : "details below"}). The AE should reference their activity and connect it to ACME's value.`;
  }

  const prompt = `Write a 2-3 sentence call brief for an AE at Acme GTM, a B2B company. The AE will read this in HubSpot before picking up the phone. Be direct and specific — no filler, no score breakdowns, no internal jargon.

${sourceContext}

DATA:
${contactLine}Company: ${input.company_name || input.domain}
Description: ${input.description || "N/A"}
${input.employee_count ? `Employees: ${input.employee_count}` : ""}
Sub-market: ${input.sub_market || "N/A"}
${input.funding_stage ? `Funding: ${input.funding_stage}${input.funding_total ? ` ($${(input.funding_total / 1000000).toFixed(1)}M)` : ""}` : ""}
${salesOrgContext ? `Sales Org: ${salesOrgContext}` : ""}
${hasSignal ? `Signal: ${signalParts.join(", ")}` : ""}

RULES:
1. Sentence 1: What the company does, who they sell to, and team size (if known). One sentence, no fluff.
2. Sentence 2: State the sales org exactly as the data shows — real names, real titles, AE count, SDR count. Do NOT infer patterns the data doesn't support. Do NOT say "founder-led" unless the data explicitly shows founder/CEO as the only person selling. Skip this sentence if no Sales Org data is provided above.
3. Sentence 3: Give the AE a specific call angle based on the gap in the prospect's sales org. Be concrete — reference the actual people or hiring signals from the data. Do NOT use canned phrases or repeat the same angle for every company. Think about what makes THIS company's situation unique. Use "their" for the prospect, never "your". For legacy/unknown signals: note there's no recent activity on file.

NEVER include:
- ICP scores, score breakdowns, or scoring rationale
- Internal labels like "HubSpot Backfill", "V2 Enriched", "company_discovery", "fibbler_engagement"
- Phrases like "key decision-maker", "aligns well with", "making them well-suited for", "classified as a hot/warm lead"
- The word "qualifies" or "qualification"
- Section headers or bullet points

Return ONLY the 2-3 sentence brief. No preamble.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0];
    if (text.type === "text") {
      return text.text.trim();
    }
    return "";
  } catch (err) {
    console.error("[summaries] Claude API call failed:", err);
    return buildTemplateSummary(input, signalParts);
  }
}

// Template fallback — used if Claude API fails. Handles both contact-level and
// company-level invocations gracefully (no phantom contact references).
function buildTemplateSummary(input: SummaryInput, signalParts: string[]): string {
  const hasContact = !!(input.contact_name || input.title);
  const who = hasContact
    ? `${input.contact_name || "Contact"} (${input.title || "Unknown"}) at ${input.company_name || input.domain}`
    : (input.company_name || input.domain);
  const signal = signalParts.length ? ` Signal: ${signalParts.join(", ")}.` : "";
  const emp = input.employee_count ? ` ${input.employee_count} employees.` : "";
  const market = input.sub_market ? ` ${input.sub_market}.` : "";
  return `${who}.${emp}${market}${signal} Score: ${input.total_score} (${input.tier.toUpperCase()}).`;
}
