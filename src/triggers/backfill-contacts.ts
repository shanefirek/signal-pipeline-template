import { task, wait } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { computeTier } from "../scoring/intent.js";
import { updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { generateLeadSummary } from "../lib/summaries.js";
import { deriveLeadOrigin } from "../lib/constants.js";

// Backfill Contacts — enriches existing HubSpot contacts that were raw-imported
//
// Use case: RepD's "Red Rows" list — 103 contacts imported from a K12 CSV
// with zero ICP scoring, no lead_temp, no lead_origin. These already exist
// in HubSpot but need enrichment data pushed back.
//
// Flow per domain:
//   1. Check if company exists in Supabase (already enriched by V2)
//   2. If not → trigger enrich-company (LeadMagic + Claude classifier)
//   3. Wait for enrichment to complete
//   4. Look up company data → compute tier
//   5. Generate AI lead summary (Sonnet 4.5)
//   6. UPDATE existing HubSpot contact with MQL attribution fields
//
// This does NOT create new HubSpot contacts — it enriches existing ones.

interface BackfillContact {
  hubspot_contact_id: string;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  domain: string;
}

export const backfillContacts = task({
  id: "backfill-contacts",
  maxDuration: 600, // 10 min — processing up to ~20 contacts per batch
  run: async (payload: { contacts: BackfillContact[] }) => {
    const { contacts } = payload;
    console.log(`[backfill] Starting backfill for ${contacts.length} contacts`);

    // Group by domain
    const byDomain = new Map<string, BackfillContact[]>();
    for (const c of contacts) {
      const d = c.domain.toLowerCase();
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)!.push(c);
    }
    console.log(`[backfill] ${byDomain.size} unique domains`);

    // Step 1: Check which domains already have companies in Supabase
    const domains = [...byDomain.keys()];
    const { data: existingCompanies } = await supabase
      .from("companies")
      .select("id, domain, icp_score, vertical_fit_score, name, sub_market, sales_org_summary, lead_summary, first_touch_source, utm_sources, utm_medium, touch_campaigns, lead_temp, employee_count, description, industry, funding_stage, funding_total, outbound_need_score, sales_team_data")
      .in("domain", domains);

    const companyByDomain = new Map<string, any>();
    for (const c of existingCompanies || []) {
      companyByDomain.set(c.domain, c);
    }

    const needsEnrichment = domains.filter(d => !companyByDomain.has(d));
    console.log(`[backfill] ${companyByDomain.size} domains already enriched, ${needsEnrichment.length} need enrichment`);

    // Step 2: Trigger enrich-company for new domains
    if (needsEnrichment.length > 0) {
      const { enrichCompanyTask } = await import("./enrich-company.js");

      // Create placeholder raw_signals for each domain (enrich-company needs raw_signal_id)
      for (const domain of needsEnrichment) {
        const contactsForDomain = byDomain.get(domain) || [];
        const firstContact = contactsForDomain[0];

        // Insert a raw_signal as backfill source
        const { data: rawSignal, error: insertErr } = await supabase
          .from("raw_signals")
          .insert({
            source: "hubspot_backfill",
            raw_payload: { backfill: true, hubspot_list: "Red Rows 219" },
            domain,
            domain_raw: domain,
            company_name: firstContact.company,
            email: firstContact.email,
            first_name: firstContact.first_name,
            last_name: firstContact.last_name,
            contact_name: `${firstContact.first_name} ${firstContact.last_name}`.trim(),
            title: firstContact.title,
            lead_source: "hubspot_backfill",
            page_views: 0,
            sessions: 0,
            status: "enriching",
          })
          .select("id")
          .single();

        if (insertErr) {
          console.error(`[backfill] Failed to create raw_signal for ${domain}:`, insertErr);
          continue;
        }

        // Trigger enrich-company
        await enrichCompanyTask.trigger({
          raw_signal_id: rawSignal.id,
          domain,
          company_name: firstContact.company,
          signal_data: {
            lead_source: "hubspot_backfill",
          },
        });
        console.log(`[backfill] Triggered enrich-company for ${domain}`);
      }

      // Wait for enrichments to complete (poll Supabase)
      console.log(`[backfill] Waiting for ${needsEnrichment.length} company enrichments...`);
      let attempts = 0;
      const maxAttempts = 60; // 5 min max wait (5s intervals)

      while (attempts < maxAttempts) {
        await wait.for({ seconds: 5 });
        attempts++;

        const { data: newCompanies } = await supabase
          .from("companies")
          .select("domain")
          .in("domain", needsEnrichment);

        const enrichedCount = (newCompanies || []).length;
        if (enrichedCount >= needsEnrichment.length) {
          console.log(`[backfill] All ${enrichedCount} companies enriched`);
          break;
        }
        if (attempts % 6 === 0) {
          console.log(`[backfill] ${enrichedCount}/${needsEnrichment.length} enriched (${attempts * 5}s elapsed)`);
        }
      }

      // Close out backfill raw_signals — these bypass normalize→score-intent
      for (const domain of needsEnrichment) {
        await supabase
          .from("raw_signals")
          .update({ status: "done", processed_at: new Date().toISOString() })
          .eq("domain", domain)
          .eq("source", "hubspot_backfill")
          .eq("status", "enriching");
      }

      // Refresh company data
      const { data: allCompanies } = await supabase
        .from("companies")
        .select("id, domain, icp_score, vertical_fit_score, name, sub_market, sales_org_summary, lead_summary, first_touch_source, utm_sources, utm_medium, touch_campaigns, lead_temp, employee_count, description, industry, funding_stage, funding_total, outbound_need_score, sales_team_data")
        .in("domain", domains);

      for (const c of allCompanies || []) {
        companyByDomain.set(c.domain, c);
      }
    }

    // Step 3: Process each contact — score, summarize, update HubSpot
    const results: Array<{ email: string; domain: string; status: string; tier?: string; icp_score?: number }> = [];

    for (const contact of contacts) {
      const company = companyByDomain.get(contact.domain.toLowerCase());

      if (!company) {
        console.log(`[backfill] No company data for ${contact.domain} — skipping ${contact.email}`);
        results.push({ email: contact.email, domain: contact.domain, status: "no_company_data" });
        continue;
      }

      const icp_score = company.icp_score || 0;
      const intent_score = 0; // Backfill contacts have no intent signal
      const total_score = icp_score + intent_score;
      const tier = computeTier(total_score);
      const tier_display = tier.charAt(0).toUpperCase() + tier.slice(1);

      // Generate AI lead summary
      let lead_summary: string | null = null;
      try {
        lead_summary = await generateLeadSummary({
          contact_name: `${contact.first_name} ${contact.last_name}`.trim() || null,
          title: contact.title || null,
          email: contact.email,
          company_name: company.name || contact.company,
          domain: contact.domain,
          description: company.description || null,
          employee_count: company.employee_count || null,
          industry: company.industry || null,
          sales_team_data: company.sales_team_data || null,
          sub_market: company.sub_market || null,
          funding_stage: company.funding_stage || null,
          funding_total: company.funding_total || null,
          lead_source: "hubspot_backfill",
          icp_score,
          intent_score,
          total_score,
          tier,
          vertical_fit_score: company.vertical_fit_score || null,
          outbound_need_score: company.outbound_need_score || null,
        });
      } catch (err) {
        console.error(`[backfill] Summary generation failed for ${contact.email}:`, err);
      }

      // Upsert contact in Supabase
      const conflictColumn = "email";
      await supabase
        .from("contacts")
        .upsert({
          company_id: company.id,
          domain: contact.domain.toLowerCase(),
          email: contact.email,
          first_name: contact.first_name || null,
          last_name: contact.last_name || null,
          title: contact.title || null,
          icp_score,
          intent_score,
          tier,
          lead_origin: deriveLeadOrigin("hubspot_backfill"),
          lead_source: "hubspot_backfill",
          lead_summary,
          hubspot_contact_id: contact.hubspot_contact_id,
          enriched_at: new Date().toISOString(),
          enrichment_sources: ["hubspot_backfill"],
        }, { onConflict: conflictColumn });

      // Update HubSpot contact with MQL attribution
      if (isHubSpotPushEnabled()) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: contact.hubspot_contact_id,
            icp_score,
            intent_score,
            total_score,
            lead_tier: tier_display === "Cold" ? "" : tier_display,
            lead_temp: tier_display === "Cool" ? "Cold" : (tier_display || "Cold"),
            clay_lead_source: "hubspot_backfill",
            lead_summary: lead_summary || undefined,
            sales_org_summary: company.sales_org_summary || undefined,
            sub_market: company.sub_market || undefined,
            company: company.name || contact.company,
            jobtitle: contact.title || undefined,
          });

          console.log(`[backfill] Updated HubSpot contact ${contact.email} — ${tier_display} (ICP: ${icp_score})`);
          results.push({ email: contact.email, domain: contact.domain, status: "updated", tier: tier_display, icp_score });
        } catch (err) {
          console.error(`[backfill] HubSpot update failed for ${contact.email}:`, err);
          results.push({ email: contact.email, domain: contact.domain, status: "hubspot_error" });
        }
      } else {
        results.push({ email: contact.email, domain: contact.domain, status: "push_disabled", tier: tier_display, icp_score });
      }
    }

    // Summary
    const updated = results.filter(r => r.status === "updated").length;
    const failed = results.filter(r => r.status === "hubspot_error").length;
    const skipped = results.filter(r => r.status === "no_company_data").length;

    console.log(`[backfill] Done: ${updated} updated, ${failed} failed, ${skipped} skipped`);

    return {
      total: contacts.length,
      updated,
      failed,
      skipped,
      results,
    };
  },
});
