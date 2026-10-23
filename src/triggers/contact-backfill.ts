import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { computeTier } from "../scoring/intent.js";
import { updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";

// Contact Backfill — runs every hour
//
// Finds contacts with icp_score=0 whose company has a real ICP score.
// Copies icp_score, sub_market, lead_summary, sales_org_summary from company.
// Recalculates tier. Pushes to HubSpot if contact has a hubspot_contact_id.
//
// Replaces: company-contact-sync.py (growth-ops cron)

export const contactBackfill = schedules.task({
  id: "contact-backfill",
  cron: "15 * * * *", // Every hour at :15
  maxDuration: 300,
  run: async () => {
    // Step 1: Link orphaned contacts to their companies by domain
    // Race condition: contact can be enriched before company exists, leaving company_id=null
    const { data: orphans } = await supabase
      .from("contacts")
      .select("id, domain")
      .is("company_id", null)
      .limit(100);

    let linked = 0;
    if (orphans?.length) {
      for (const orphan of orphans) {
        const { data: company } = await supabase
          .from("companies")
          .select("id")
          .eq("domain", orphan.domain)
          .single();

        if (company) {
          await supabase
            .from("contacts")
            .update({ company_id: company.id })
            .eq("id", orphan.id);
          linked++;
        }
      }
      if (linked > 0) {
        console.log(`[contact-backfill] Linked ${linked} orphaned contacts to companies`);
      }
    }

    // Step 2: Find contacts missing ICP data that have a company_id set
    // Note: Supabase !inner join doesn't filter properly, so we query contacts first
    // then fetch company data in the loop
    const { data: gaps } = await supabase
      .from("contacts")
      .select("id, domain, icp_score, intent_score, hubspot_contact_id, tier, title, company_id")
      .eq("icp_score", 0)
      .not("company_id", "is", null)
      .limit(100);

    if (!gaps?.length) {
      console.log(`[contact-backfill] No ICP gaps found (linked ${linked} orphans)`);
      return { linked, backfilled: 0 };
    }

    let backfilled = 0;

    for (const contact of gaps) {
      // Fetch company data
      const { data: company } = await supabase
        .from("companies")
        .select("icp_score, sub_market, lead_summary, sales_org_summary, city, state")
        .eq("id", contact.company_id)
        .single();

      if (!company || !company.icp_score) continue;

      const newIcp = company.icp_score;
      const intentScore = contact.intent_score || 0;
      const newTotal = newIcp + intentScore;
      const newTier = computeTier(newTotal);
      const tierDisplay = newTier.charAt(0).toUpperCase() + newTier.slice(1);

      // Update Supabase
      await supabase.from("contacts").update({
        icp_score: newIcp,
        tier: newTier,
      }).eq("id", contact.id);

      // Push to HubSpot if has contact ID
      if (contact.hubspot_contact_id && isHubSpotPushEnabled()) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: contact.hubspot_contact_id,
            icp_score: newIcp,
            intent_score: intentScore,
            total_score: newTotal,
            lead_tier: tierDisplay === "Cold" ? "" : tierDisplay,
            lead_temp: tierDisplay === "Cool" ? "Cold" : (tierDisplay || "Cold"),
            sub_market: company.sub_market || undefined,
            lead_summary: company.lead_summary || undefined,
            sales_org_summary: company.sales_org_summary || undefined,
            city: company.city || undefined,
            state: company.state || undefined,
            // Also push jobtitle if we have it — race condition may have skipped it
            jobtitle: contact.title || undefined,
          });
        } catch (err) {
          console.error(`[contact-backfill] HubSpot update failed for ${contact.id}:`, err);
        }
      }

      backfilled++;
      console.log(`[contact-backfill] ${contact.domain}: icp 0 → ${newIcp}, tier → ${newTier}`);
    }

    console.log(`[contact-backfill] Done. Linked: ${linked}, Backfilled: ${backfilled}`);
    return { linked, backfilled };
  },
});
