import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { hubspot } from "../lib/hubspot.js";
import { isDomainBlocked } from "../lib/gates.js";
import { enrichDealContact } from "./enrich-deal-contact.js";

// Deal Sync — runs every hour
//
// Pulls new HubSpot deals, enriches associated companies/contacts if needed.
// Sets lead_tier=Hot on deal companies + contacts (deal = highest intent).
//
// Replaces: deal-enrichment-trigger.py (growth-ops cron)

export const dealSync = schedules.task({
  id: "deal-sync",
  cron: "0 * * * *", // Every hour at :00
  maxDuration: 300,
  run: async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Find deals created in the last 2 hours
    const searchRes = await hubspot.crm.deals.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: "createdate",
          operator: "GTE" as any,
          value: twoHoursAgo,
        }],
      }],
      properties: ["dealname", "dealstage", "pipeline", "createdate", "amount"],
      limit: 50,
    });

    if (!searchRes.results.length) {
      console.log("[deal-sync] No new deals in last 2h");
      return { processed: 0, enriched: 0 };
    }

    let processed = 0;
    let enriched = 0;

    for (const deal of searchRes.results) {
      // Skip closed lost/won
      const stage = deal.properties.dealstage || "";
      if (stage === "closedlost" || stage === "closedwon") continue;

      // Get associated company
      let companyDomain: string | null = null;
      let companyHsId: string | null = null;

      try {
        const assocRes = await hubspot.apiRequest({
          method: "GET",
          path: `/crm/v4/objects/deals/${deal.id}/associations/companies`,
        });
        const assocData = await assocRes.json() as { results?: Array<{ toObjectId: string }> };
        if (assocData.results?.length) {
          companyHsId = assocData.results[0].toObjectId;
          const companyRes = await hubspot.crm.companies.basicApi.getById(
            companyHsId,
            ["domain"],
          );
          companyDomain = companyRes.properties.domain || null;
        }
      } catch (err) {
        console.error(`[deal-sync] Failed to get company for deal ${deal.id}:`, err);
        continue;
      }

      if (!companyDomain) continue;
      if (await isDomainBlocked(companyDomain)) continue;

      // Get associated contact
      let contactHsId: string | null = null;
      try {
        const contactAssocRes = await hubspot.apiRequest({
          method: "GET",
          path: `/crm/v4/objects/deals/${deal.id}/associations/contacts`,
        });
        const contactAssocData = await contactAssocRes.json() as { results?: Array<{ toObjectId: string }> };
        if (contactAssocData.results?.length) {
          contactHsId = contactAssocData.results[0].toObjectId;
        }
      } catch (err) {
        console.error(`[deal-sync] Failed to get contact for deal ${deal.id}:`, err);
      }

      // Hand off to the isolated enrich-deal-contact task — no pipeline gates.
      // That task owns: company refresh (if stale), HubSpot company push with
      // lead_tier=Hot, Cargo LinkedIn discovery, LeadMagic phone, Claude
      // summary, and HubSpot contact update. We fire-and-forget; it handles
      // its own error/push logging.
      try {
        await enrichDealContact.trigger({
          deal_id: deal.id,
          deal_name: deal.properties.dealname || null,
          company_hs_id: companyHsId,
          contact_hs_id: contactHsId,
          domain: companyDomain,
        });
        enriched++;
      } catch (err) {
        console.error(`[deal-sync] enrich-deal-contact trigger failed for ${companyDomain}:`, err);
      }

      // Track deal + HubSpot company ID on company in Supabase
      await supabase
        .from("companies")
        .update({
          hubspot_deal_id: deal.id,
          hubspot_company_id: companyHsId,
          deal_created_at: deal.properties.createdate,
        })
        .eq("domain", companyDomain);

      processed++;
      console.log(`[deal-sync] ${companyDomain}: deal ${deal.id} (${deal.properties.dealname})`);
    }

    console.log(`[deal-sync] Done. Processed: ${processed}, Enriched: ${enriched}`);
    return { processed, enriched };
  },
});
