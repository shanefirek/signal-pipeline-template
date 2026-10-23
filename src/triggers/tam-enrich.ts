import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { validateDomain, isEnterpriseDomain } from "../lib/gates.js";
import {
  companySearch,
  employeeFinder,
  jobsFinder,
  technographics,
  classifySalesTeamLLM,
} from "../enrichment/providers/leadmagic-company.js";
import { findStakeholders } from "../enrichment/providers/cargo.js";
import {
  computeTamICP,
  tamTier,
  scoreSalesTeamReal,
} from "../scoring/tam-icp.js";
import { classifySubMarket } from "../lib/sub-market-classifier.js";
import { generateLeadSummary, formatSalesAnalysisForPrompt } from "../lib/summaries.js";
import { deriveFundingStage as deriveFundingStageShared } from "../lib/funding.js";
import { logEnrichmentCall, normalizeKey, startTimer } from "../enrichment/enrichment-logger.js";

// TAM Enrichment — LeadMagic company scoring + Claude classifier
//
// Takes a single domain, enriches through LeadMagic (company, employees, jobs, tech stack),
// scores with deterministic ICP rules. Stores everything in Supabase.
// Does NOT push to HubSpot or discover contacts.
//
// Triggered in batch by firing one task per domain with tags for querying.
// Usage: trigger tam-enrich with payload { domain, tam_list, ae_owner }

export const tamEnrich = task({
  id: "tam-enrich",
  maxDuration: 180,
  run: async (payload: {
    domain: string;
    tam_list: string;
    ae_owner: "rep_a" | "rep_b";
  }) => {
    const { domain, tam_list, ae_owner } = payload;

    // ── STAGE 0: Validation ──
    const domainCheck = validateDomain(domain);
    if (!domainCheck.valid) {
      return { status: "dq", domain, reason: domainCheck.reason };
    }
    if (isEnterpriseDomain(domain)) {
      return { status: "dq", domain, reason: "enterprise_blocklist" };
    }

    // Check if already TAM-enriched recently
    const { data: existing } = await supabase
      .from("companies")
      .select("id, tam_enriched_at")
      .eq("domain", domain)
      .single();

    if (existing?.tam_enriched_at) {
      const age = Date.now() - new Date(existing.tam_enriched_at).getTime();
      if (age < 30 * 24 * 60 * 60 * 1000) { // < 30 days
        return { status: "skipped", domain, reason: "recently_enriched" };
      }
    }

    // ── STAGE 1: LeadMagic Company Search ──
    const domainKey = normalizeKey("domain", domain);
    const t1 = startTimer();
    const company = await companySearch(domain);
    const d1 = t1();
    logEnrichmentCall({
      provider: "leadmagic", operation: "company_search",
      lookup_key: domainKey,
      input_payload: { domain },
      output_payload: company ? { companyName: company.companyName, employeeCount: company.employeeCount, industry: company.industry } : null,
      credits_estimated: 1, trigger_source: "tam-enrich",
      success: !!company, duration_ms: d1,
      result_summary: company ? { found: true, employeeCount: company.employeeCount } : { found: false },
    }).catch(() => {});

    if (!company) {
      await upsertDQ(domain, tam_list, ae_owner, "leadmagic_not_found");
      return { status: "dq", domain, reason: "leadmagic_not_found" };
    }

    // Gate: too large
    if (company.employeeCount > 500) {
      await upsertDQ(domain, tam_list, ae_owner, "too_large", company);
      return { status: "dq", domain, reason: "too_large", employee_count: company.employeeCount };
    }

    // ── STAGE 2: Employee discovery (LeadMagic → Cargo fallback) ──
    // LeadMagic employeeFinder is ~67% accurate per RepB. When it returns nothing,
    // Cargo Find Stakeholders (Sales Nav legacy search) is the fallback — different
    // data source, different gaps. See docs/providers/cargo.md.
    const t2 = startTimer();
    let employees = await employeeFinder(domain);
    const d2 = t2();
    logEnrichmentCall({
      provider: "leadmagic", operation: "employee_finder",
      lookup_key: domainKey,
      input_payload: { domain },
      output_payload: employees ? { employee_count: employees.employees?.length, total_count: employees.total_count, credits_consumed: employees.credits_consumed } : null,
      credits_estimated: employees?.credits_consumed || 0, trigger_source: "tam-enrich",
      success: !!(employees?.employees?.length), duration_ms: d2,
      result_summary: { employee_count: employees?.employees?.length || 0 },
    }).catch(() => {});

    let cargoStakeholdersCredits = 0;
    let stakeholdersFallbackUsed = false;

    if (!employees?.employees?.length) {
      const t2b = startTimer();
      const fb = await findStakeholders(domain);
      const d2b = t2b();
      cargoStakeholdersCredits = fb.credits_consumed;
      logEnrichmentCall({
        provider: "cargo", operation: "find_stakeholders",
        lookup_key: domainKey,
        input_payload: { companyDomain: domain },
        output_payload: { stakeholder_count: fb.stakeholders.length, credits_consumed: fb.credits_consumed },
        credits_estimated: fb.credits_consumed, trigger_source: "tam-enrich",
        success: fb.stakeholders.length > 0, duration_ms: d2b,
        result_summary: { stakeholder_count: fb.stakeholders.length },
      }).catch(() => {});

      if (fb.stakeholders.length > 0) {
        stakeholdersFallbackUsed = true;
        employees = {
          employees: fb.stakeholders.map((s) => ({
            full_name: s.full_name,
            title: s.title,
            linkedin_url: s.linkedin_url,
            location: s.location,
          })),
          total_count: fb.stakeholders.length,
          // LeadMagic credits unchanged — preserve whatever it actually charged.
          credits_consumed: employees?.credits_consumed || 0,
        };
      }
    }

    // ── STAGE 3: LeadMagic Jobs Finder ──
    const t3 = startTimer();
    const jobs = await jobsFinder(domain);
    const d3 = t3();
    logEnrichmentCall({
      provider: "leadmagic", operation: "jobs_finder",
      lookup_key: domainKey,
      input_payload: { domain },
      output_payload: jobs ? { job_count: jobs.jobs?.length, credits_consumed: jobs.credits_consumed } : null,
      credits_estimated: jobs?.credits_consumed || 0, trigger_source: "tam-enrich",
      success: !!(jobs?.jobs?.length), duration_ms: d3,
      result_summary: { job_count: jobs?.jobs?.length || 0 },
    }).catch(() => {});

    // ── STAGE 4: Outbound Need Scoring ──
    const salesAnalysis = await classifySalesTeamLLM(
      employees?.employees || [],
      jobs?.jobs || [],
      company.companyName || domain,
      company.employeeCount,
    );
    const salesScore = scoreSalesTeamReal(salesAnalysis);
    const salesOrgSummary = salesAnalysis.llm_summary || "No identifiable sales team on LinkedIn.";

    // ── STAGE 5: Technographics (only if outbound need >= 25) ──
    let techData: Awaited<ReturnType<typeof technographics>> = null;
    if (salesScore.score >= 25) {
      const t5 = startTimer();
      techData = await technographics(domain);
      const d5 = t5();
      logEnrichmentCall({
        provider: "leadmagic", operation: "technographics",
        lookup_key: domainKey,
        input_payload: { domain },
        output_payload: techData as any,
        credits_estimated: 1, trigger_source: "tam-enrich",
        success: !!techData, duration_ms: d5,
        result_summary: techData ? { has_data: true } : { has_data: false },
      }).catch(() => {});
    }

    // ── STAGE 6: Sub-market classification ──
    // Use the unified Claude classifier. The
    // classifier can read description + scraped content if LeadMagic industry
    // is ambiguous (e.g., "E-learning" → corporate vs K-12 disambiguation).
    const classification = await classifySubMarket({
      domain,
      name: company.companyName,
      description: company.description,
      industry: company.industry,
      employee_count: company.employeeCount,
    });
    let sub_market: string | null = classification.sub_market;

    // Derive funding from LeadMagic
    let funding_stage: string | null = null;
    if (company.total_funding) {
      const numericFunding = parseFundingAmount(company.total_funding, company.total_funding_formatted);
      funding_stage = deriveFundingStageShared(numericFunding);
    }

    // ── STAGE 7: Composite ICP Scoring ──
    const icpResult = computeTamICP({
      sub_market,
      employee_count: company.employeeCount,
      annual_revenue: company.revenue_formatted,
      funding_stage,
      sales_team: salesAnalysis,
      technologies: techData?.technologies || [],
    });

    const tier = tamTier(icpResult.raw_total);
    const icp_normalized = Math.round(icpResult.raw_total * (125 / 175));

    // ── STAGE 7.5: 4-section lead_summary ──
    // Same generator as enrich-company. No signal data for TAM (the SIGNAL
    // section will skip per Clay rules). LeadMagic salesAnalysis becomes the
    // sales_team_data input via formatSalesAnalysisForPrompt — much higher
    // quality than keyword extraction.
    const lead_summary = await generateLeadSummary({
      contact_name: null,
      title: null,
      email: null,
      company_name: company.companyName,
      domain,
      description: company.description || null,
      employee_count: company.employeeCount,
      industry: company.industry || null,
      sub_market,
      sales_team_data: formatSalesAnalysisForPrompt(salesAnalysis),
      funding_stage,
      funding_total: parseFundingAmount(company.total_funding, company.total_funding_formatted),
      lead_source: "tam_import",
      icp_score: icp_normalized,
      intent_score: 0,
      total_score: icp_normalized,
      tier: tier.toLowerCase(),
      vertical_fit_score: icpResult.vertical_fit,
      outbound_need_score: icpResult.outbound_need,
    });

    // ── STAGE 8: Supabase Write ──
    const enrichmentSources: string[] = ["leadmagic_company"];
    if (employees && !stakeholdersFallbackUsed) enrichmentSources.push("leadmagic_employees");
    if (stakeholdersFallbackUsed) enrichmentSources.push("cargo_stakeholders");
    if (jobs) enrichmentSources.push("leadmagic_jobs");
    if (techData) enrichmentSources.push("leadmagic_technographics");

    const { data: upserted, error: upsertError } = await supabase
      .from("companies")
      .upsert({
        domain,
        name: company.companyName,
        description: company.description || "",
        industry: company.industry || "",
        employee_count: company.employeeCount,
        annual_revenue: company.revenue_formatted,
        sub_market,
        linkedin_url: company.linkedin_url,
        // LeadMagic returns "headquarter" (no 's') not "headquarters"
        city: (company as any).headquarter?.city || (company as any).headquarters?.city || null,
        state: (company as any).headquarter?.geographicArea || (company as any).headquarters?.geographicArea || null,
        country: (company as any).headquarter?.country || (company as any).headquarters?.country || null,

        // Classifier metadata (paper trail for sub_market)
        classifier_source: classification.source,
        classifier_confidence: classification.confidence,
        classifier_reason: classification.reason,
        classifier_version: classification.version,
        last_classified_at: new Date().toISOString(),
        data_source: "leadmagic",

        // Funding
        funding_stage,
        funding_total: parseFundingAmount(company.total_funding, company.total_funding_formatted),
        funding_round_count: company.funding_rounds,

        // Scoring
        vertical_fit_score: icpResult.vertical_fit,
        headcount_score: icpResult.headcount,
        company_stage_score: icpResult.company_stage,
        outbound_need_score: icpResult.outbound_need,
        sales_team_score: icpResult.outbound_need,
        tech_stack_score: icpResult.tech_stack,
        tam_icp_raw: icpResult.raw_total,
        icp_score: icp_normalized, // Normalized 0-125

        // Sales data — serialize cleanly for jsonb
        sales_team_data: JSON.parse(JSON.stringify(salesAnalysis)),
        sales_hiring_data: jobs?.jobs ? JSON.parse(JSON.stringify(jobs.jobs)) : null,
        sales_org_summary: salesOrgSummary,
        tech_stack_data: techData?.technologies || null,
        leadmagic_data: company,

        // AI-generated call brief
        lead_summary,

        // TAM metadata
        tam_list,
        tam_tier: tier,
        ae_owner,
        tam_added_at: existing?.id ? undefined : new Date().toISOString(), // Don't overwrite if re-enriching
        tam_enriched_at: new Date().toISOString(),
        lead_source: "tam_import",
        enriched_at: new Date().toISOString(),
        enrichment_sources: enrichmentSources,
      }, { onConflict: "domain" })
      .select("id")
      .single();

    if (upsertError) {
      console.error(`[tam-enrich] Supabase upsert failed for ${domain}:`, upsertError);
      throw new Error(`Supabase upsert failed: ${upsertError.message}`);
    }

    return {
      status: "enriched",
      domain,
      company_id: upserted?.id,
      company_name: company.companyName,
      tam_list,
      tam_tier: tier,
      icp_raw: icpResult.raw_total,
      icp_normalized: Math.round(icpResult.raw_total * (125 / 175)),
      breakdown: icpResult,
      sales_summary: salesOrgSummary,
      credits: {
        leadmagic: (company ? 1 : 0) + (employees?.credits_consumed || 0) + (jobs?.credits_consumed || 0) + (techData?.credits_consumed || 0),
        cargo: cargoStakeholdersCredits,
      },
    };
  },
});

// --- Helper: DQ upsert ---
async function upsertDQ(
  domain: string,
  tam_list: string,
  ae_owner: string,
  reason: string,
  company?: any,
) {
  await supabase.from("companies").upsert({
    domain,
    name: company?.companyName || domain,
    employee_count: company?.employeeCount || null,
    industry: company?.industry || null,
    tam_list,
    tam_tier: "DQ",
    ae_owner,
    tam_dq_reason: reason,
    tam_enriched_at: new Date().toISOString(),
    lead_source: "tam_import",
    icp_score: 0,
  }, { onConflict: "domain" });
}

// --- Helper: Parse funding amount (LeadMagic returns "172.4M" or numeric) ---
function parseFundingAmount(raw: any, formatted?: string | null): number | null {
  if (typeof raw === "number") return raw;
  if (!raw && !formatted) return null;

  const str = String(formatted || raw).replace(/[^0-9.MBKmkb]/g, "");
  if (!str) return null;

  const num = parseFloat(str);
  if (isNaN(num)) return null;

  const upper = str.toUpperCase();
  if (upper.includes("B")) return num * 1_000_000_000;
  if (upper.includes("M")) return num * 1_000_000;
  if (upper.includes("K")) return num * 1_000;

  return num;
}

// Sub-market classification goes through src/lib/sub-market-classifier.ts which
// uses Claude Haiku for ambiguous cases (E-learning, Education Management, etc.).
// The old 13-line keyword matcher caused ~47% drift on the TAM upload — see
// state-of-acme/enrichment-audit-2026-04-06.md for the full damage report.
//
// NOTE: deriveFundingStage was promoted to src/lib/funding.ts so enrich-company can
// share it. Old in-file version was buggy (took raw string, not parsed number).
