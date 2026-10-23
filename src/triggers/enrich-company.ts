import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { getCompanyData } from "../enrichment/company-data-waterfall.js";
import {
  employeeFinder,
  jobsFinder,
  technographics,
  classifySalesTeamLLM,
} from "../enrichment/providers/leadmagic-company.js";
import { findStakeholders } from "../enrichment/providers/cargo.js";
import {
  computeTamICP,
  scoreSalesTeamReal,
} from "../scoring/tam-icp.js";
import { companyLeadTemp } from "../scoring/icp.js";
import { deriveFundingStage } from "../lib/funding.js";
import { generateLeadSummary, formatSalesAnalysisForPrompt } from "../lib/summaries.js";
import { passesCompanyPushGateWithReason, passesContactDiscoveryGate } from "../lib/gates.js";
import { pushCompanyToHubSpot, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { deriveLeadOrigin } from "../lib/constants.js";
import { tryMarkSignalDone } from "../lib/signal-lifecycle.js";
import { logEnrichmentCall } from "../enrichment/enrichment-logger.js";

// Company Enrichment Pipeline — LeadMagic + Claude
//
// Flow:
//   1. company-data-waterfall  → LeadMagic / Apify / website-fetch + Claude classifier
//   2. LeadMagic employees + jobs (always, for factual sales org breakdown)
//   3. LeadMagic technographics  (gated on outbound_need ≥ 25)
//   4. computeTamICP             (RepC spec — deterministic formula scoring)
//   5. generateLeadSummary       (Claude AI synthesis using LeadMagic facts)
//   6. Upsert company row
//   7. Gate check → HubSpot push / contact discovery / signal backfill

export const enrichCompanyTask = task({
  id: "enrich-company",
  run: async (payload: {
    raw_signal_id: string;
    domain: string;
    company_name?: string;
    signal_data: Record<string, any>;
    tam_only?: boolean; // Score and store only — skip HubSpot push and contact discovery
    // Deferred contact: normalize passes contact info so enrich-company can trigger
    // enrich-contact AFTER the company row exists (prevents race condition where
    // contact enrichment runs with company_id=null and icp_score=0).
    deferred_contact?: {
      contact_name?: string;
      title?: string;
      email?: string;
      linkedin_url?: string;
      lead_source?: string;
      existing_contact_id?: string | null;
    };
  }) => {
    const { domain, company_name, signal_data } = payload;

    // Safety guard: TAM traffic must never trigger HubSpot push or contact discovery.
    // Coerce tam_only=true whenever lead_source=tam_import so any caller (scripts,
    // manual triggers, future agents) that forgets to set the flag still routes safely.
    // Apr 5 incident: batch-enrich-sdk.mts fired 36 enrich-company runs with
    // tam_import signal_data but no tam_only, updating 36 HubSpot company records.
    const tam_only = payload.tam_only || signal_data?.lead_source === "tam_import";

    // Deal gate: if company already has a deal, skip contact discovery.
    // Discovery noise: LeadMagic finds new contacts at companies where AE is already
    // working a deal. These get enriched, pushed to HubSpot, and confuse the AE.
    // Apr 16: Shane identified this gap via PC University (active deal + Sandy Ramjit MQL).
    const { data: existingCompany } = await supabase
      .from("companies")
      .select("id, hubspot_deal_id")
      .eq("domain", domain)
      .limit(1)
      .single();

    const hasExistingDeal = !!(existingCompany?.hubspot_deal_id);
    if (hasExistingDeal) {
      console.log(`[enrich-company] ${domain} has existing deal — skipping contact discovery`);
    }

    // ── Step 1: Company data waterfall (LeadMagic → Apify → website-fetch → classifier) ──
    const companyData = await getCompanyData(domain);

    // ── Geo gate: US-only ──
    // Check country from LeadMagic HQ or signal data. Non-US companies are not ICP —
    // bail before burning credits on employees, jobs, technographics, or Claude.
    const earlyCountry = (companyData.leadmagic?.headquarters as any)?.countryCode || signal_data.country || null;
    const US_VARIANTS = ["US", "USA", "United States", "us", "usa"];
    if (earlyCountry && !US_VARIANTS.includes(earlyCountry)) {
      console.log(`[enrich-company] GEO FILTERED ${domain}: country=${earlyCountry}`);
      const { data: geoStub } = await supabase
        .from("companies")
        .upsert(
          {
            domain,
            name: companyData.name || company_name || domain,
            country: earlyCountry,
            sub_market: companyData.sub_market || "Not SLED",
            data_source: companyData.data_source,
            lead_source: signal_data.lead_source,
            lead_origin: deriveLeadOrigin(signal_data.lead_source),
            enriched_at: new Date().toISOString(),
          },
          { onConflict: "domain" },
        )
        .select("id")
        .single();

      if (payload.raw_signal_id) {
        await supabase.from("raw_signals").update({
          company_id: geoStub?.id,
          status: "filtered",
        }).eq("id", payload.raw_signal_id);
      }

      return {
        company_id: geoStub?.id,
        domain,
        skipped: true,
        reason: `geo_blocked:${earlyCountry}`,
      };
    }

    if (companyData.data_source === "none") {
      // No tier returned usable data — write a stub row and return DQ
      // Caller (Trigger.dev queue) sees the result — no point enriching a phantom domain
      console.log(`[enrich-company] DQ ${domain}: no data from any tier`);
      const { data: stub } = await supabase
        .from("companies")
        .upsert(
          {
            domain,
            name: company_name || domain,
            sub_market: companyData.sub_market,
            classifier_source: companyData.classification.source,
            classifier_confidence: companyData.classification.confidence,
            classifier_reason: companyData.classification.reason,
            classifier_version: companyData.classification.version,
            last_classified_at: new Date().toISOString(),
            data_source: companyData.data_source,
            lead_source: signal_data.lead_source,
            lead_origin: deriveLeadOrigin(signal_data.lead_source),
            enriched_at: new Date().toISOString(),
          },
          { onConflict: "domain" },
        )
        .select("id")
        .single();

      if (payload.raw_signal_id && stub) {
        await supabase.from("raw_signals").update({ company_id: stub.id, status: "error" }).eq("id", payload.raw_signal_id);
      }

      return {
        company_id: stub?.id,
        domain,
        sub_market: companyData.sub_market,
        skipped: true,
        reason: "no_data_from_any_tier",
      };
    }

    // ── Step 2: LeadMagic employees + jobs (always) ──
    // Mirrors tam-enrich's stages 2-3. Provides factual sales team data.
    const employees = await employeeFinder(domain);
    const jobs = await jobsFinder(domain);
    const salesAnalysis = await classifySalesTeamLLM(
      employees?.employees || [],
      jobs?.jobs || [],
      companyData.name || domain,
      companyData.employee_count,
    );
    const salesScore = scoreSalesTeamReal(salesAnalysis);
    const sales_org_summary = salesAnalysis.llm_summary || "No identifiable sales team on LinkedIn.";

    // ── Step 3: Technographics (gated on outbound_need ≥ 25, mirrors tam-enrich) ──
    let techData: Awaited<ReturnType<typeof technographics>> = null;
    if (salesScore.score >= 25) {
      techData = await technographics(domain);
    }

    // ── Step 4: Compute ICP via RepC Scoring Spec v2 (deterministic) ──
    // Parse funding - LeadMagic can return strings like "350K", "1.5M", "$2M"
    const parseFunding = (val: unknown): number | null => {
      if (typeof val === "number") return val;
      if (!val) return null;
      const str = String(val).replace(/[$,]/g, "").trim().toUpperCase();
      const match = str.match(/^([\d.]+)([KMB])?$/);
      if (!match) return parseFloat(str) || null;
      const num = parseFloat(match[1]);
      const suffix = match[2];
      if (suffix === "K") return num * 1000;
      if (suffix === "M") return num * 1000000;
      if (suffix === "B") return num * 1000000000;
      return num;
    };
    const fundingTotal = parseFunding(companyData.leadmagic?.total_funding);
    const fundingStage = fundingTotal ? deriveFundingStage(fundingTotal) : null;

    const tamIcp = computeTamICP({
      sub_market: companyData.sub_market,
      employee_count: companyData.employee_count,
      annual_revenue: companyData.leadmagic?.revenue_formatted ?? null,
      funding_stage: fundingStage,
      sales_team: salesAnalysis,
      technologies: techData?.technologies || [],
    });

    const icp_score = Math.round(tamIcp.raw_total * (125 / 175));
    const lead_temp = companyLeadTemp(icp_score);
    const employee_count = companyData.employee_count || parseInt(signal_data.employees) || null;

    // Resolve fields with fallback: LeadMagic > Syft signal > null
    const resolved_city = (companyData.leadmagic?.headquarters as any)?.city || signal_data.city || null;
    const resolved_state = (companyData.leadmagic?.headquarters as any)?.region || signal_data.state || null;
    const resolved_country = (companyData.leadmagic?.headquarters as any)?.countryCode || signal_data.country || null;
    const resolved_linkedin_url = companyData.leadmagic?.linkedin_url || signal_data.company_linkedin_url || null;
    const resolved_description = companyData.description || signal_data.syft_description || null;

    // ── Step 5: Generate lead_summary (Claude AI synthesis) ──
    const lead_summary = await generateLeadSummary({
      contact_name: null,
      title: null,
      email: null,
      company_name: companyData.name,
      domain,
      description: companyData.description,
      employee_count,
      industry: companyData.industry,
      sub_market: companyData.sub_market,
      sales_team_data: formatSalesAnalysisForPrompt(salesAnalysis),
      funding_stage: fundingStage,
      funding_total: fundingTotal,
      lead_source: signal_data.lead_source,
      utm_source: signal_data.utm_sources,
      utm_medium: signal_data.utm_medium,
      utm_campaign: signal_data.touch_campaigns,
      icp_score,
      intent_score: 0,
      total_score: icp_score,
      tier: lead_temp.toLowerCase(),
      vertical_fit_score: tamIcp.vertical_fit,
      outbound_need_score: salesScore.score,
    });

    // ── Step 6: Upsert company row ──
    const enrichmentSources: string[] = [companyData.data_source];
    if (employees) enrichmentSources.push("leadmagic_employees");
    if (jobs) enrichmentSources.push("leadmagic_jobs");
    if (techData) enrichmentSources.push("leadmagic_technographics");

    const { data: company, error: insertErr } = await supabase
      .from("companies")
      .upsert(
        {
          domain,
          name: companyData.name || company_name,
          industry: companyData.industry,
          employee_count,
          description: companyData.description,
          sub_market: companyData.sub_market,

          // Classifier metadata (paper trail for sub_market)
          classifier_source: companyData.classification.source,
          classifier_confidence: companyData.classification.confidence,
          classifier_reason: companyData.classification.reason,
          classifier_version: companyData.classification.version,
          last_classified_at: new Date().toISOString(),
          data_source: companyData.data_source,

          // Funding (from LeadMagic) - parsed to numeric
          funding_stage: fundingStage,
          funding_total: fundingTotal,

          // Scoring breakdown (RepC spec v2)
          vertical_fit_score: tamIcp.vertical_fit,
          headcount_score: tamIcp.headcount,
          company_stage_score: tamIcp.company_stage,
          sales_team_score: tamIcp.outbound_need,
          outbound_need_score: salesScore.score,
          tech_stack_score: tamIcp.tech_stack,
          tam_icp_raw: tamIcp.raw_total,
          icp_score,
          lead_temp,

          // Factual sales data (from LeadMagic)
          sales_org_summary,
          sales_team_data: JSON.parse(JSON.stringify(salesAnalysis)),
          sales_hiring_data: jobs?.jobs ? JSON.parse(JSON.stringify(jobs.jobs)) : null,
          tech_stack_data: techData?.technologies || null,
          leadmagic_data: companyData.leadmagic,

          // Geo + LinkedIn (LeadMagic > Syft fallback)
          city: resolved_city,
          state: resolved_state,
          country: resolved_country,
          linkedin_url: resolved_linkedin_url,

          // AI-generated call brief
          lead_summary,

          // Attribution (unchanged)
          lead_source: signal_data.lead_source,
          lead_origin: deriveLeadOrigin(signal_data.lead_source),
          first_touch_source: signal_data.first_touch_source,
          touch_channels: signal_data.touch_channels,
          touch_campaigns: signal_data.touch_campaigns,
          utm_sources: signal_data.utm_sources,
          utm_medium: signal_data.utm_medium,
          latest_source: signal_data.latest_source,
          matched_intents: signal_data.matched_intents,
          pages_viewed: signal_data.pages_viewed,
          lead_personas: signal_data.lead_personas,
          syft_intent_level: signal_data.syft_intent_level,

          enriched_at: new Date().toISOString(),
          enrichment_sources: enrichmentSources,
        },
        { onConflict: "domain" },
      )
      .select("id")
      .single();

    if (insertErr) throw insertErr;

    // Log enrichment calls (non-blocking — stores raw responses permanently)
    const companyId = company.id;
    if (employees) {
      logEnrichmentCall({
        provider: "leadmagic", operation: "employee_finder", lookup_key: domain,
        input_payload: { company_domain: domain, limit: 50 },
        output_payload: employees as any, credits_estimated: employees.credits_consumed || 1,
        trigger_source: "enrich-company", success: true, company_id: companyId,
      });
    }
    if (jobs) {
      logEnrichmentCall({
        provider: "leadmagic", operation: "jobs_finder", lookup_key: domain,
        input_payload: { company_domain: domain },
        output_payload: jobs as any, credits_estimated: jobs.credits_consumed || 1,
        trigger_source: "enrich-company", success: true, company_id: companyId,
      });
    }
    if (techData) {
      logEnrichmentCall({
        provider: "leadmagic", operation: "technographics", lookup_key: domain,
        input_payload: { company_domain: domain },
        output_payload: techData as any, credits_estimated: 1,
        trigger_source: "enrich-company", success: true, company_id: companyId,
      });
    }

    // Link raw signal to company
    if (payload.raw_signal_id) {
      await supabase.from("raw_signals").update({ company_id: company.id }).eq("id", payload.raw_signal_id);
      await tryMarkSignalDone(payload.raw_signal_id);
    }

    // ── Step 6b: Trigger deferred contact enrichment ──
    // normalize passes contact info here so enrich-contact runs AFTER the company
    // row exists. Without this, enrich-contact races enrich-company and gets
    // company_id=null → icp_score=0 → is_mql=false → never pushed to HubSpot.
    if (payload.deferred_contact && !tam_only) {
      const dc = payload.deferred_contact;
      const hasIdentifier = dc.linkedin_url || (dc.email && dc.email.trim() !== "");
      if (hasIdentifier) {
        const { enrichContactTask } = await import("./enrich-contact.js");
        await enrichContactTask.trigger({
          raw_signal_id: payload.raw_signal_id,
          domain,
          contact_name: dc.contact_name,
          title: dc.title,
          email: dc.email,
          linkedin_url: dc.linkedin_url,
          lead_source: dc.lead_source,
          company_id: company.id,
          existing_contact_id: dc.existing_contact_id || null,
        });
        console.log(`[enrich-company] Triggered deferred enrich-contact for ${dc.contact_name || dc.email || dc.linkedin_url} @ ${domain}`);
      }
    }

    // ── Step 7: Gate check → push to HubSpot ──
    const pushGateData = {
      domain,
      sub_market: companyData.sub_market,
      icp_score,
      vertical_fit_score: tamIcp.vertical_fit,
      employee_count,
      lead_source: signal_data.lead_source,
    };

    const companyGateResult = passesCompanyPushGateWithReason(pushGateData);

    if (!companyGateResult.passes && !tam_only) {
      console.log(`[enrich-company] Push gate rejected ${domain}: ${companyGateResult.reason}`);
      await supabase.from("push_log").insert({
        entity_type: "company",
        entity_id: company.id,
        destination: "hubspot",
        action: "gate_rejected",
        success: false,
        error: `Gate rejection: ${companyGateResult.reason}`,
      });
    }

    if (companyGateResult.passes && isHubSpotPushEnabled() && !tam_only) {
      try {
        const hsResult = await pushCompanyToHubSpot({
          domain,
          name: companyData.name || company_name,
          employee_count: employee_count ?? undefined,
          sub_market: companyData.sub_market || undefined,
          icp_score,
          lead_temp,
          lead_origin: deriveLeadOrigin(signal_data.lead_source),
          total_score: icp_score,
          first_touch_source: signal_data.first_touch_source,
          touch_channels: signal_data.touch_channels,
          touch_campaigns: signal_data.touch_campaigns,
          syft_intent: signal_data.syft_intent_level,
          matched_intents: signal_data.matched_intents,
          utm_medium: signal_data.utm_medium,
          latest_source: signal_data.latest_source,
          // AI-generated summaries
          lead_summary: lead_summary || undefined,
          sales_org_summary: sales_org_summary || undefined,
          description: resolved_description || undefined,
          city: resolved_city || undefined,
          state: resolved_state || undefined,
          country: resolved_country || undefined,
          linkedin_company_page: resolved_linkedin_url || undefined,
          // Funding fields (from LeadMagic)
          funding_stage: fundingStage || undefined,
          annualrevenue: companyData.leadmagic?.revenue || signal_data.syft_revenue || undefined,
          total_money_raised: companyData.leadmagic?.total_funding_formatted || undefined,
        });

        await supabase
          .from("companies")
          .update({
            hubspot_company_id: hsResult.id,
            hubspot_pushed_at: new Date().toISOString(),
          })
          .eq("id", company.id);

        await supabase.from("push_log").insert({
          entity_type: "company",
          entity_id: company.id,
          destination: "hubspot",
          action: hsResult.action,
          success: true,
        });
      } catch (err) {
        console.error(`[enrich-company] HubSpot push failed for ${domain}:`, err);
        await supabase.from("push_log").insert({
          entity_type: "company",
          entity_id: company.id,
          destination: "hubspot",
          action: "create",
          success: false,
          error: String(err),
        });
      }
    }

    // ── Step 9: Backfill signals that scored before ICP was available ──
    // score-intent runs in parallel with enrich-company, so signals for new
    // companies always have icp_score=0. Now that we have the real ICP, fix them.
    const { data: staleSignals } = await supabase
      .from("signals")
      .select("id, intent_score, fibbler_score")
      .eq("domain", domain)
      .eq("icp_score", 0);

    if (staleSignals?.length) {
      const { computeTier } = await import("../scoring/intent.js");

      for (const sig of staleSignals) {
        const newTotal = icp_score + (sig.intent_score || 0);
        const newTier = computeTier(newTotal);

        await supabase
          .from("signals")
          .update({
            icp_score,
            total_score: newTotal,
            lead_tier: newTier,
          })
          .eq("id", sig.id);
      }

      console.log(
        `[enrich-company] Backfilled ${staleSignals.length} signals for ${domain} with ICP ${icp_score}`,
      );

      // Trigger update-hubspot with correct scores (best signal wins)
      const bestSignal = staleSignals.reduce(
        (best, s) => {
          const total = icp_score + (s.intent_score || 0);
          return total > best.total ? { total, intent: s.intent_score || 0 } : best;
        },
        { total: 0, intent: 0 },
      );

      const bestTier = computeTier(bestSignal.total);

      const { updateHubSpot } = await import("./update-hubspot.js");
      await updateHubSpot.trigger({
        domain,
        company_id: company.id,
        company_name: companyData.name || company_name,
        intent_score: bestSignal.intent,
        icp_score,
        total_score: bestSignal.total,
        lead_tier: bestTier,
        lead_source: signal_data.lead_source,
      });
    }

    // ── Step 10: Contact discovery via LeadMagic ──
    // Gate: ICP >= 50 + vertical fit + < 500 employees + no existing deal + not TAM
    if (
      passesContactDiscoveryGate({
        icp_score,
        vertical_fit_score: tamIcp.vertical_fit,
        employee_count,
        has_sales_team: salesAnalysis
          ? (salesAnalysis.ae_count > 0 || salesAnalysis.sdr_count > 0 ||
             salesAnalysis.hiring_sales || salesAnalysis.hiring_ae || salesAnalysis.hiring_sdr)
          : undefined,
      }) &&
      !tam_only &&
      !hasExistingDeal
    ) {
      const { discoverContact } = await import("./discover-contact.js");
      await discoverContact.trigger({
        company_id: company.id,
        domain,
        employee_count,
        lead_source: signal_data.lead_source || "company_discovery",
      });
    }

    return {
      company_id: company.id,
      domain,
      sub_market: companyData.sub_market,
      data_source: companyData.data_source,
      classifier_source: companyData.classification.source,
      icp_score,
      funding_stage: fundingStage,
      lead_temp,
      pushed_to_hubspot: companyGateResult.passes && !tam_only && isHubSpotPushEnabled(),
      discovery_triggered:
        passesContactDiscoveryGate({
          icp_score,
          vertical_fit_score: tamIcp.vertical_fit,
          employee_count,
          has_sales_team: salesAnalysis
            ? (salesAnalysis.ae_count > 0 || salesAnalysis.sdr_count > 0 ||
               salesAnalysis.hiring_sales || salesAnalysis.hiring_ae || salesAnalysis.hiring_sdr)
            : undefined,
        }) && !tam_only && !hasExistingDeal,
    };
  },
});
