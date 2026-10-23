import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { findStakeholders } from "../enrichment/providers/cargo.js";
import { employeeFinder } from "../enrichment/providers/leadmagic-company.js";
import { isTitleBlocked, isDecisionMakerTitle } from "../lib/gates.js";
import { deriveLeadType } from "../lib/constants.js";
import { logEnrichmentCall, normalizeKey, startTimer } from "../enrichment/enrichment-logger.js";

// Contact Discovery — Cargo primary, LeadMagic fallback
//
// 1. Cargo Find Stakeholders (Sales Nav) → title-filtered at source (6.5 credits)
// 2. If Cargo returns 0 → LeadMagic employeeFinder fallback (~1.5 credits)
// 3. Filter to decision maker titles, exclude blocked titles
// 4. Trigger enrich-contact for top 3 candidates (Cargo verification + HubSpot push)
//
// Both providers logged to enrichment_log. enrich-contact handles departure detection.
//
// LESSON (Apr 29, 2026 — Carnegie incident):
// Cargo Find Stakeholders can return 0 even when domain resolution succeeds.
// Sales Nav title search only matches its input titles — if the company has no
// "VP Sales" or "Director of Sales" (common for SLED/EdTech), it finds nobody.
// The fallback to LeadMagic is NOT optional. A previous session removed it,
// creating a single point of failure. NEVER remove the fallback chain.
// Also: LeadMagic returns zero LinkedIn URLs for many companies, so Cargo
// verification downstream falls back to name-based (44% reliable). Accept this.

interface Candidate {
  full_name: string;
  title: string;
  linkedin_url: string | null;
}

export const discoverContact = task({
  id: "discover-contact",
  maxDuration: 180, // Sales Nav can be slow (35-120s)
  run: async (payload: {
    company_id: string;
    domain: string;
    employee_count?: number | null;
    lead_source?: string;
    lead_type?: "inbound" | "outbound" | "referral" | "unknown";
    ae_owner?: "rep_a" | "rep_b";
  }) => {
    const { company_id, domain, lead_source, lead_type, ae_owner } = payload;
    let candidates: Candidate[] = [];
    let source: "cargo" | "leadmagic" | "none" = "none";
    let totalFound = 0;
    let creditsConsumed = 0;

    // --- Step 1: Cargo Find Stakeholders (primary) ---
    const cargoTimer = startTimer();
    const cargoResult = await findStakeholders(domain);
    const cargoDuration = cargoTimer();

    logEnrichmentCall({
      provider: "cargo",
      operation: "find_stakeholders",
      lookup_key: normalizeKey("domain", domain),
      input_payload: { companyDomain: domain },
      output_payload: { stakeholder_count: cargoResult.stakeholders.length, error: cargoResult.error || null, credits_consumed: cargoResult.credits_consumed },
      credits_estimated: cargoResult.credits_consumed,
      trigger_source: "discover-contact",
      success: cargoResult.stakeholders.length > 0,
      duration_ms: cargoDuration,
      company_id,
      result_summary: { stakeholder_count: cargoResult.stakeholders.length },
    }).catch(() => {});

    if (cargoResult.error) {
      console.error(`[discover-contact] Cargo error for ${domain}: ${cargoResult.error}`);
    }

    // Always track Cargo credits (6.5 charged even on 0 results when run completes)
    creditsConsumed += cargoResult.credits_consumed;

    if (cargoResult.stakeholders.length > 0) {
      source = "cargo";
      totalFound = cargoResult.stakeholders.length;
      candidates = filterAndRank(cargoResult.stakeholders);
      console.log(`[discover-contact] Cargo found ${totalFound} stakeholders at ${domain}, ${candidates.length} eligible`);
    }

    // --- Step 2: LeadMagic fallback (only if Cargo found nobody at all) ---
    // If Cargo found people but all were title-filtered, don't burn LeadMagic credits —
    // LeadMagic will return the same people with worse data (no LinkedIn URLs).
    const cargoFoundAny = cargoResult.stakeholders.length > 0;
    if (candidates.length === 0 && !cargoFoundAny) {
      console.log(`[discover-contact] Cargo found 0 stakeholders for ${domain}, trying LeadMagic fallback`);

      const lmTimer = startTimer();
      const lmResult = await employeeFinder(domain, 30);
      const lmDuration = lmTimer();

      logEnrichmentCall({
        provider: "leadmagic",
        operation: "employee_finder",
        lookup_key: normalizeKey("domain", domain),
        input_payload: { domain, limit: 30 },
        output_payload: lmResult ? { employee_count: lmResult.employees?.length, total_count: lmResult.total_count, credits_consumed: lmResult.credits_consumed } : null,
        credits_estimated: lmResult?.credits_consumed || 0,
        trigger_source: "discover-contact",
        success: !!(lmResult?.employees?.length),
        duration_ms: lmDuration,
        company_id,
        result_summary: lmResult ? { employee_count: lmResult.employees?.length } : undefined,
      }).catch(() => {});

      if (lmResult?.employees?.length) {
        source = "leadmagic";
        totalFound = lmResult.employees.length;
        creditsConsumed += lmResult.credits_consumed;
        candidates = filterAndRank(lmResult.employees);
        console.log(`[discover-contact] LeadMagic found ${totalFound} employees at ${domain}, ${candidates.length} eligible`);
      } else {
        console.log(`[discover-contact] LeadMagic also returned 0 for ${domain}`);
      }
    }

    if (candidates.length === 0) {
      if (cargoFoundAny) {
        console.log(`[discover-contact] Cargo found ${cargoResult.stakeholders.length} people but all were title-filtered for ${domain}`);
      } else {
        console.log(`[discover-contact] No candidates from either provider for ${domain}`);
      }
      return { status: "no_candidates", domain, source, credits_consumed: creditsConsumed };
    }

    // --- Step 3: Trigger enrich-contact for top 3 ---
    const top = candidates.slice(0, 3);
    const { enrichContactTask } = await import("./enrich-contact.js");
    const enriched: Candidate[] = [];

    for (const candidate of top) {
      console.log(`[discover-contact] Enriching: ${candidate.full_name} (${candidate.title}) at ${domain} [${source}]`);

      await enrichContactTask.trigger({
        raw_signal_id: null,
        domain,
        contact_name: candidate.full_name,
        title: candidate.title,
        email: null,
        linkedin_url: candidate.linkedin_url || null,
        lead_source: lead_source || "company_discovery",
        lead_type: lead_type || deriveLeadType(lead_source),
        company_id,
        ae_owner,
      });

      enriched.push(candidate);
    }

    return {
      status: "discovered",
      domain,
      source,
      contacts: enriched,
      total_found: totalFound,
      enriched_count: enriched.length,
      credits_consumed: creditsConsumed,
    };
  },
});

// Shared filter + rank logic for both providers
function filterAndRank(people: Candidate[]): Candidate[] {
  const decisionMakers = people.filter(
    (p) => isDecisionMakerTitle(p.title) && !isTitleBlocked(p.title)
  );

  if (decisionMakers.length > 0) {
    return rankBySeniority(decisionMakers);
  }

  // Fallback: anyone with a non-blocked title, ranked by seniority
  const eligible = people.filter((p) => !isTitleBlocked(p.title));
  return rankBySeniority(eligible);
}

function rankBySeniority(people: Candidate[]): Candidate[] {
  return [...people].sort((a, b) => seniorityScore(b.title) - seniorityScore(a.title));
}

function seniorityScore(title: string): number {
  if (/ceo|cro|coo|cfo|cto|cmo|chief|founder|president/i.test(title)) return 100;
  if (/vp|vice president/i.test(title)) return 90;
  if (/director/i.test(title)) return 80;
  if (/head of/i.test(title)) return 70;
  if (/manager/i.test(title)) return 50;
  return 10;
}
