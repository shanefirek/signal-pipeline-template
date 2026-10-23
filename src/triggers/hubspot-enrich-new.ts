import { schedules, wait } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { hubspot, updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { computeTier } from "../scoring/intent.js";
import { generateLeadSummary } from "../lib/summaries.js";
import { deriveLeadOrigin } from "../lib/constants.js";
import { validateEmail, findMobilePhone } from "../enrichment/providers/leadmagic.js";
import { INTERNAL_DOMAINS } from "../lib/blocklists.js";
import { scoreVerticalFit } from "../scoring/icp.js";

// HubSpot Enrich New — hourly cron that catches unenriched contacts
//
// Contacts enter HubSpot through doors that bypass V2: form fills, meeting
// bookings, manual AE adds, Syft native pushes. This cron finds them and
// enriches them so they have ICP scores, summaries, sub_market, city/state.
//
// Runs hourly at :45 (after contact-backfill at :15).
// Limit 50 per run to stay within API rate limits.
// Skips contacts created < 30 min ago (give signal pipeline time first).

const COMPANY_SELECT = "id, domain, icp_score, vertical_fit_score, name, sub_market, sales_org_summary, lead_summary, city, state, employee_count, description, industry, funding_stage, funding_total, outbound_need_score, sales_team_data";

export const hubspotEnrichNew = schedules.task({
  id: "hubspot-enrich-new",
  cron: "45 * * * *",
  maxDuration: 600, // 10 min max
  run: async () => {
    if (!isHubSpotPushEnabled()) {
      console.log("[enrich-new] HubSpot push disabled — skipping");
      return { status: "disabled" };
    }

    // Find unenriched contacts (no icp_score) created more than 30 min ago
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const res = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: "icp_score", operator: "NOT_HAS_PROPERTY" as any },
          { propertyName: "createdate", operator: "LT" as any, value: thirtyMinAgo },
        ],
      }],
      properties: [
        "email", "firstname", "lastname", "jobtitle", "company", "phone",
        "lifecyclestage", "lead_origin", "hs_linkedin_url", "hubspot_owner_id",
      ],
      limit: 50,
    });

    const contacts = res.results.filter(c => {
      const email = c.properties.email?.toLowerCase() || "";
      const domain = email.split("@")[1];
      return domain && !INTERNAL_DOMAINS.has(domain);
    });

    if (!contacts.length) {
      console.log("[enrich-new] No unenriched contacts found");
      return { status: "no_contacts", checked: res.total };
    }

    console.log(`[enrich-new] Found ${contacts.length} unenriched contacts`);

    // Group by domain
    const byDomain = new Map<string, any[]>();
    for (const c of contacts) {
      const domain = c.properties.email!.toLowerCase().split("@")[1];
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain)!.push(c);
    }

    // Fetch existing companies from Supabase
    const domains = [...byDomain.keys()];
    const companyByDomain = new Map<string, any>();
    for (let i = 0; i < domains.length; i += 50) {
      const batch = domains.slice(i, i + 50);
      const { data } = await supabase
        .from("companies")
        .select(COMPANY_SELECT)
        .in("domain", batch);
      for (const c of data || []) {
        companyByDomain.set(c.domain, c);
      }
    }

    // Enrich unknown companies
    const needsEnrichment = domains.filter(d => !companyByDomain.has(d));
    if (needsEnrichment.length > 0) {
      const { enrichCompanyTask } = await import("./enrich-company.js");

      for (const domain of needsEnrichment) {
        const first = (byDomain.get(domain) || [])[0]?.properties;
        const { data: rawSignal } = await supabase
          .from("raw_signals")
          .insert({
            source: "hubspot_backfill",
            raw_payload: { backfill: true, cron: "hubspot-enrich-new" },
            domain,
            domain_raw: domain,
            company_name: first?.company || null,
            email: first?.email || null,
            lead_source: "hubspot_backfill",
            page_views: 0,
            sessions: 0,
            status: "enriching",
          })
          .select("id")
          .single();

        if (rawSignal) {
          await enrichCompanyTask.trigger({
            raw_signal_id: rawSignal.id,
            domain,
            company_name: first?.company || null,
            signal_data: { lead_source: "hubspot_backfill" },
          });
        }
      }

      // Wait for enrichments (max 5 min)
      for (let attempt = 0; attempt < 60; attempt++) {
        await wait.for({ seconds: 5 });
        const { data: newCos } = await supabase
          .from("companies")
          .select("domain")
          .in("domain", needsEnrichment);
        if ((newCos?.length || 0) >= needsEnrichment.length) break;
      }

      // Close out backfill raw_signals — these bypass normalize→score-intent
      // so they'd stay stuck in "enriching" forever without this.
      for (const domain of needsEnrichment) {
        await supabase
          .from("raw_signals")
          .update({ status: "done", processed_at: new Date().toISOString() })
          .eq("domain", domain)
          .eq("source", "hubspot_backfill")
          .eq("status", "enriching");
      }

      // Refresh
      for (let i = 0; i < needsEnrichment.length; i += 50) {
        const batch = needsEnrichment.slice(i, i + 50);
        const { data } = await supabase
          .from("companies")
          .select(COMPANY_SELECT)
          .in("domain", batch);
        for (const c of data || []) {
          companyByDomain.set(c.domain, c);
        }
      }
    }

    // Process each contact
    let enriched = 0;
    let demoted = 0;
    let errors = 0;

    for (const contact of contacts) {
      const p = contact.properties;
      const email = p.email!.toLowerCase();
      const domain = email.split("@")[1];
      const company = companyByDomain.get(domain);

      if (!company) {
        console.log(`[enrich-new] No company data for ${domain} — skipping ${email}`);
        continue;
      }

      try {
        // Phone lookup
        let newPhone: string | null = null;
        if (p.hs_linkedin_url?.trim() && !p.phone?.trim()) {
          const phoneResult = await findMobilePhone(p.hs_linkedin_url);
          if (phoneResult?.mobile_number) newPhone = phoneResult.mobile_number;
        }

        // Score
        const icp_score = company.icp_score || 0;
        const total_score = icp_score; // No intent for backfill
        const tier = computeTier(total_score);
        const tier_display = tier.charAt(0).toUpperCase() + tier.slice(1);
        const vf = company.vertical_fit_score || scoreVerticalFit(company.sub_market);

        // SLED gate
        const isSled = vf > 0;
        const shouldBeMql = isSled && icp_score >= 50;
        const currentlyMql = p.lifecyclestage === "marketingqualifiedlead";
        const isOppOrCustomer = p.lifecyclestage === "opportunity" || p.lifecyclestage === "customer";

        let lifecycleAction: "keep" | "demote" = "keep";
        if (!shouldBeMql && currentlyMql && !isOppOrCustomer) {
          lifecycleAction = "demote";
          demoted++;
        }

        // Summary
        let summary: string | null = null;
        try {
          summary = await generateLeadSummary({
            contact_name: `${p.firstname || ""} ${p.lastname || ""}`.trim() || null,
            title: p.jobtitle || null,
            email,
            company_name: company.name || p.company,
            domain,
            description: company.description || null,
            employee_count: company.employee_count || null,
            industry: company.industry || null,
            sales_team_data: company.sales_team_data || null,
            sub_market: company.sub_market || null,
            funding_stage: company.funding_stage || null,
            funding_total: company.funding_total || null,
            lead_source: "hubspot_backfill",
            icp_score,
            intent_score: 0,
            total_score,
            tier,
            vertical_fit_score: vf,
            outbound_need_score: company.outbound_need_score || null,
          });
        } catch {}

        // Push to HubSpot
        const updateProps: Record<string, string> = {
          icp_score: String(icp_score),
          total_score: String(total_score),
          lead_tier: tier_display === "Cold" ? "" : tier_display,
          lead_temp: tier_display === "Cool" ? "Cold" : (tier_display || "Cold"),
          ...(company.sub_market && { sub_market: company.sub_market }),
          ...(company.sales_org_summary && { sales_org_summary: company.sales_org_summary.replace(/"/g, "'") }),
          ...(company.city && { city: company.city }),
          ...(company.state && { state: company.state }),
          ...(company.name && { company: company.name.replace(/"/g, "'") }),
          ...(summary && { lead_summary: summary.replace(/"/g, "'") }),
          ...(newPhone && { phone: newPhone }),
          ...(!p.lead_origin?.trim() && {
            lead_origin: deriveLeadOrigin("hubspot_backfill"),
            clay_lead_source: "hubspot_backfill",
          }),
          ...(lifecycleAction === "demote" && {
            lifecyclestage: "lead",
            lead_temp: "Cold",
          }),
        };

        await hubspot.crm.contacts.basicApi.update(contact.id, { properties: updateProps });
        enriched++;

        // Upsert in Supabase
        await supabase
          .from("contacts")
          .upsert({
            company_id: company.id,
            domain,
            email,
            first_name: p.firstname || null,
            last_name: p.lastname || null,
            title: p.jobtitle || null,
            icp_score,
            tier,
            lead_origin: p.lead_origin?.trim() || deriveLeadOrigin("hubspot_backfill"),
            lead_source: "hubspot_backfill",
            lead_summary: summary || null,
            hubspot_contact_id: contact.id,
            ...(newPhone && { phone: newPhone }),
            ...(p.hs_linkedin_url?.trim() && { linkedin_url: p.hs_linkedin_url }),
            enriched_at: new Date().toISOString(),
          }, { onConflict: "email" });

      } catch (err) {
        console.error(`[enrich-new] Error processing ${email}:`, err);
        errors++;
      }
    }

    console.log(`[enrich-new] Done. Enriched: ${enriched}, Demoted: ${demoted}, Errors: ${errors}`);
    return { enriched, demoted, errors, total: contacts.length };
  },
});
