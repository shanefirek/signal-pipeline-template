import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { hubspot } from "../lib/hubspot.js";

// Fibbler Sync — runs every 6 hours (G24 fix)
//
// Pulls Fibbler LinkedIn ad engagement data from HubSpot company properties
// and writes to signals table as fibbler_engagement signal type.
//
// Approach: batch-read our Supabase companies from HubSpot (by hubspot_company_id)
// instead of searching HubSpot — avoids search API limitations on Fibbler's custom properties.
//
// Fibbler HubSpot properties (company-level):
// Property names include ad account ID (518079429) and time window (30_days)
// Fibbler does NOT have a "leads" property — uses "engagements" instead

const FIBBLER_AD_ACCOUNT = "518079429";
const FIBBLER_PROPS = [
  "domain",
  "name",
  `fibbler_linkedin_ad_clicks_${FIBBLER_AD_ACCOUNT}_30_days`,
  `fibbler_linkedin_ad_impressions_${FIBBLER_AD_ACCOUNT}_30_days`,
  `fibbler_linkedin_ad_engagements_${FIBBLER_AD_ACCOUNT}_30_days`,
  `fibbler_linkedin_organic_engagements_${FIBBLER_AD_ACCOUNT}_30_days`,
  `fibbler_linkedin_organic_impressions_${FIBBLER_AD_ACCOUNT}_30_days`,
  `fibbler_linkedin_engagement_level_${FIBBLER_AD_ACCOUNT}_30_days`,
];

export const fibblerSync = schedules.task({
  id: "fibbler-sync",
  // DISABLED 2026-04-21 — not running LinkedIn ads, Fibbler zero-data signals
  // were overwriting real website attribution. Re-enable when ads resume.
  // cron: "30 */6 * * *",
  maxDuration: 300,
  run: async () => {
    // Get all companies with HubSpot IDs from Supabase
    const { data: companies, error: fetchErr } = await supabase
      .from("companies")
      .select("id, domain, hubspot_company_id")
      .not("hubspot_company_id", "is", null);

    if (fetchErr || !companies?.length) {
      console.log(`[fibbler-sync] No companies with HubSpot IDs (${fetchErr?.message || "empty"})`);
      return { synced: 0, skipped: 0, checked: 0 };
    }

    console.log(`[fibbler-sync] Checking ${companies.length} companies for Fibbler data`);

    let synced = 0;
    let skipped = 0;
    let checked = 0;

    // Batch read in groups of 100 (HubSpot batch limit)
    for (let i = 0; i < companies.length; i += 100) {
      const batch = companies.slice(i, i + 100);

      try {
        const batchRes = await hubspot.crm.companies.batchApi.read({
          inputs: batch.map(c => ({ id: c.hubspot_company_id })),
          properties: FIBBLER_PROPS,
          propertiesWithHistory: [],
        });

        for (const hsCompany of batchRes.results) {
          checked++;
          const p = hsCompany.properties;
          const clicks = parseInt(p[`fibbler_linkedin_ad_clicks_${FIBBLER_AD_ACCOUNT}_30_days`] || "0");
          const impressions = parseInt(p[`fibbler_linkedin_ad_impressions_${FIBBLER_AD_ACCOUNT}_30_days`] || "0");
          const engagements = parseInt(p[`fibbler_linkedin_ad_engagements_${FIBBLER_AD_ACCOUNT}_30_days`] || "0");
          const organicEngagements = parseInt(p[`fibbler_linkedin_organic_engagements_${FIBBLER_AD_ACCOUNT}_30_days`] || "0");
          const organicImpressions = parseInt(p[`fibbler_linkedin_organic_impressions_${FIBBLER_AD_ACCOUNT}_30_days`] || "0");
          const engagementLevel = p[`fibbler_linkedin_engagement_level_${FIBBLER_AD_ACCOUNT}_30_days`] || null;

          // Skip only if ALL engagement is zero (ad + organic)
          if (clicks === 0 && impressions === 0 && engagements === 0 && organicEngagements === 0 && organicImpressions === 0) continue;

          const domain = p.domain;
          if (!domain) continue;

          // Check if we already have a recent Fibbler signal for this domain (within 24h)
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: existing } = await supabase
            .from("signals")
            .select("id")
            .eq("domain", domain)
            .eq("source", "fibbler_engagement")
            .gte("created_at", oneDayAgo)
            .limit(1)
            .single();

          if (existing) {
            skipped++;
            continue;
          }

          // Find matching Supabase company
          const supaCompany = batch.find(c => c.hubspot_company_id === hsCompany.id);

          // Insert Fibbler signal
          const { error: insertErr } = await supabase.from("signals").insert({
            domain,
            company_id: supaCompany?.id || null,
            source: "fibbler_engagement",
            company_name: p.name || null,
            fibbler_clicks: clicks,
            fibbler_impressions: impressions,
            fibbler_leads: engagements, // Fibbler calls these "engagements" not "leads"
            fibbler_organic_engagements: organicEngagements,
            fibbler_organic_impressions: organicImpressions,
            fibbler_engagement_level: engagementLevel,
            intent_score: 0,
            icp_score: 0,
            total_score: 0,
            lead_tier: "cold",
          });

          if (insertErr) {
            console.error(`[fibbler-sync] Insert error for ${domain}:`, insertErr.message);
            continue;
          }

          // Tag existing contacts for this domain as Fibbler-influenced
          if (clicks > 0 || engagements > 0 || organicEngagements > 0) {
            const { data: contacts } = await supabase
              .from("contacts")
              .select("id")
              .eq("domain", domain)
              .eq("fibbler_influenced", false);

            if (contacts?.length) {
              await supabase
                .from("contacts")
                .update({ fibbler_influenced: true })
                .eq("domain", domain)
                .eq("fibbler_influenced", false);
              console.log(`[fibbler-sync] Tagged ${contacts.length} contacts as fibbler_influenced for ${domain}`);
            }
          }

          synced++;
          console.log(`[fibbler-sync] ${domain}: ${clicks} clicks, ${engagements} eng, ${impressions} impr, ${organicEngagements} org_eng, level=${engagementLevel}`);
        }
      } catch (err) {
        console.error(`[fibbler-sync] Batch read error (batch ${i / 100 + 1}):`, err);
      }
    }

    console.log(`[fibbler-sync] Done. Checked: ${checked}, Synced: ${synced}, Skipped: ${skipped}`);
    return { checked, synced, skipped };
  },
});
