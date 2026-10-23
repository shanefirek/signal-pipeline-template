import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { passesContactDiscoveryGate, passesCompanyPushGate } from "../lib/gates.js";
import { pushCompanyToHubSpot, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { deriveLeadOrigin } from "../lib/constants.js";

// Parse revenue strings like "1.5M", "500K", "10000000" → number
function parseRevenue(val: string | number | null | undefined): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  const s = val.toString().toUpperCase().replace(/[,$]/g, "");
  const match = s.match(/^([\d.]+)\s*([KMB])?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return undefined;
  const suffix = match[2];
  if (suffix === "K") return num * 1_000;
  if (suffix === "M") return num * 1_000_000;
  if (suffix === "B") return num * 1_000_000_000;
  return num;
}

// TAM Activate — takes an already-enriched TAM company and:
// 1. Pushes company to HubSpot (with lead_origin = "TAM Outbound")
// 2. Triggers contact discovery (PROSPECTOR → enrich-contact → HubSpot push)
//
// Does NOT re-enrich — company data must already exist in Supabase from tam-enrich.
// Single company at a time. Batch script fires these in batches of 25.

export const tamActivate = task({
  id: "tam-activate",
  maxDuration: 600, // 10 min — PROSPECTOR can take up to 8 min
  run: async (payload: {
    domain: string;
    ae_owner: "rep_b" | "rep_a";
  }) => {
    const { domain, ae_owner } = payload;

    // Step 1: Read company from Supabase (must already be enriched)
    const { data: company, error } = await supabase
      .from("companies")
      .select("id, name, domain, icp_score, vertical_fit_score, employee_count, sub_market, lead_tier, lead_temp, lead_summary, sales_org_summary, description, city, state, country, linkedin_url, tam_list, lead_source, enriched_at, utm_medium, first_touch_source, touch_campaigns, funding_stage, funding_total, annual_revenue")
      .eq("domain", domain)
      .single();

    if (error || !company) {
      console.error(`[tam-activate] Company not found in Supabase: ${domain}`);
      return { status: "error", domain, reason: "not_found" };
    }

    if (!company.tam_list) {
      console.error(`[tam-activate] Company ${domain} has no tam_list — not a TAM record`);
      return { status: "error", domain, reason: "not_tam" };
    }

    // Step 2: Push company to HubSpot
    let hubspot_company_id = null;

    if (!isHubSpotPushEnabled()) {
      console.log(`[tam-activate] HubSpot push disabled — skipping company push for ${domain}`);
    } else if (
      passesCompanyPushGate({
        domain,
        sub_market: company.sub_market,
        icp_score: company.icp_score || 0,
        vertical_fit_score: company.vertical_fit_score || 0,
        employee_count: company.employee_count,
        lead_source: "tam_import",
      })
    ) {
      try {
        const result = await pushCompanyToHubSpot({
          domain,
          name: company.name || undefined,
          linkedin_company_page: company.linkedin_url || undefined,
          employee_count: company.employee_count || undefined,
          sub_market: company.sub_market || undefined,
          icp_score: company.icp_score || undefined,
          lead_tier: company.lead_tier || undefined,
          // Don't push lead_temp for TAM — it triggers MQL Progression + Hot Lead Alert
          // workflows designed for inbound signals. TAM contacts are outbound, not MQLs.
          lead_origin: deriveLeadOrigin("tam_import"),
          lead_summary: company.lead_summary || undefined,
          sales_org_summary: company.sales_org_summary || undefined,
          description: company.description || undefined,
          city: company.city || undefined,
          state: company.state || undefined,
          country: company.country || undefined,
          utm_medium: company.utm_medium || undefined,
          // Funding fields (Segment 5d)
          funding_stage: company.funding_stage || undefined,
          // Parse revenue strings like "1.5M" → 1500000
          annualrevenue: company.annual_revenue ? parseRevenue(company.annual_revenue) : undefined,
          total_money_raised: company.funding_total ? String(company.funding_total) : undefined,
        });

        hubspot_company_id = result.id;
        console.log(`[tam-activate] Company ${result.action} in HubSpot: ${company.name} (${domain}) → ${result.id}`);

        // Store HubSpot company ID back in Supabase
        await supabase
          .from("companies")
          .update({
            hubspot_company_id: result.id,
            hubspot_pushed_at: new Date().toISOString(),
          })
          .eq("id", company.id);

        // Log push
        await supabase.from("push_log").insert({
          entity_type: "company",
          entity_id: company.id,
          destination: "hubspot",
          action: result.action,
          success: true,
        });
      } catch (err) {
        console.error(`[tam-activate] Company HubSpot push failed for ${domain}:`, err);
        await supabase.from("push_log").insert({
          entity_type: "company",
          entity_id: company.id,
          destination: "hubspot",
          action: "create",
          success: false,
          error: String(err),
        });
      }
    } else {
      console.log(`[tam-activate] Company ${domain} failed push gate — skipping HubSpot push`);
    }

    // Step 3: Trigger contact discovery if gate passes
    const discoveryGateResult = passesContactDiscoveryGate({
      icp_score: company.icp_score || 0,
      vertical_fit_score: company.vertical_fit_score || 0,
      employee_count: company.employee_count,
    });

    if (!discoveryGateResult) {
      console.log(`[tam-activate] ${domain} failed discovery gate (ICP=${company.icp_score}, VF=${company.vertical_fit_score}, emp=${company.employee_count}) — company pushed, no contact`);
      return {
        status: "company_only",
        domain,
        company_name: company.name,
        hubspot_company_id,
        ae_owner,
        reason: "discovery_gate_failed",
      };
    }

    const { discoverContact } = await import("./discover-contact.js");
    await discoverContact.trigger({
      company_id: company.id,
      domain,
      employee_count: company.employee_count,
      lead_source: "tam_import",
      lead_type: "outbound",
      ae_owner,
    });

    return {
      status: "activated",
      domain,
      company_name: company.name,
      hubspot_company_id,
      ae_owner,
      icp_score: company.icp_score,
      sub_market: company.sub_market,
    };
  },
});
