import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { scoreIntent, computeTier, decayMultiplier, scoreFibblerEngagement } from "../scoring/intent.js";
import { pushCompanyToHubSpot, updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { companyLeadTemp } from "../scoring/icp.js";

// Stale Refresh — runs every 12 hours
//
// G6 fix: Recalculates intent scores with decay for all companies that have
// signals older than 7 days. Scores can go DOWN (unlike the normal pipeline
// which only updates on new signals).
//
// Flow:
// 1. Find companies with signals > 7 days old
// 2. For each: recalculate max intent across ALL signals with decay
// 3. If score changed: update Supabase company + contacts
// 4. If HubSpot push enabled: update HubSpot too

export const staleRefresh = schedules.task({
  id: "stale-refresh",
  cron: "0 */12 * * *", // Every 12 hours
  maxDuration: 300,
  run: async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Find companies with signals older than 7 days that haven't been refreshed recently
    const { data: staleCompanies } = await supabase
      .from("companies")
      .select("id, domain, icp_score, intent_score, hubspot_company_id")
      .or(`last_scored_at.lt.${sevenDaysAgo},last_scored_at.is.null`)
      .not("intent_score", "is", null)
      .limit(200); // Process in batches

    if (!staleCompanies?.length) {
      console.log("[stale-refresh] No stale companies found");
      return { refreshed: 0, score_changes: 0 };
    }

    let refreshed = 0;
    let scoreChanges = 0;

    for (const company of staleCompanies) {
      // Get ALL signals for this company
      const { data: signals } = await supabase
        .from("signals")
        .select("*")
        .eq("domain", company.domain)
        .order("created_at", { ascending: false });

      if (!signals?.length) continue;

      // Recalculate max intent with decay applied to each signal
      let maxIntent = 0;
      for (const signal of signals) {
        const multiplier = decayMultiplier(signal.created_at);
        if (multiplier === 0) continue; // Signal expired

        const intent = scoreIntent({
          syft_purchase_intent: signal.syft_purchase_intent,
          high_intent_sessions: signal.high_intent_sessions,
          page_views: signal.page_views,
          sessions: signal.sessions,
          active_time_seconds: signal.active_time_seconds,
          visitor_count: signal.visitor_count,
          linkedin_action: signal.linkedin_action,
          utm_channel: signal.utm_channel,
          session_pages_visited: signal.session_pages_visited,
        });

        const decayed = Math.round(intent.total * multiplier);

        // Add Fibbler bonus if present on signal
        const fibblerBonus = scoreFibblerEngagement({
          fibbler_clicks: signal.fibbler_clicks,
          fibbler_leads: signal.fibbler_leads,
          fibbler_impressions: signal.fibbler_impressions,
        });

        maxIntent = Math.max(maxIntent, decayed + fibblerBonus);
      }

      const icp = company.icp_score || 0;
      const newTotal = icp + maxIntent;
      const newTier = computeTier(newTotal);
      const oldIntentScore = company.intent_score || 0;

      // Only update if score actually changed
      if (maxIntent === oldIntentScore) {
        refreshed++;
        continue;
      }

      scoreChanges++;
      const lead_temp = companyLeadTemp(newTotal);

      // Update company in Supabase
      await supabase.from("companies").update({
        intent_score: maxIntent,
        total_score: newTotal,
        lead_tier: newTier,
        lead_temp,
        last_scored_at: new Date().toISOString(),
      }).eq("id", company.id);

      // Update all contacts for this company
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, hubspot_contact_id, icp_score")
        .eq("domain", company.domain);

      if (contacts?.length) {
        for (const contact of contacts) {
          const contactTotal = (contact.icp_score || 0) + maxIntent;
          const contactTier = computeTier(contactTotal) || "cold";

          await supabase.from("contacts").update({
            intent_score: maxIntent,
            tier: contactTier,
            needs_refresh: true,
          }).eq("id", contact.id);

          // Push to HubSpot if enabled
          if (contact.hubspot_contact_id && isHubSpotPushEnabled()) {
            try {
              await updateHubSpotContact({
                hubspot_contact_id: contact.hubspot_contact_id,
                intent_score: maxIntent,
                icp_score: contact.icp_score || 0,
                total_score: contactTotal,
                lead_tier: contactTier === "cold" ? "" : contactTier.charAt(0).toUpperCase() + contactTier.slice(1),
                lead_temp: contactTier === "cool"
                  ? "Cold"
                  : (contactTier.charAt(0).toUpperCase() + contactTier.slice(1) || "Cold"),
              });
            } catch (err) {
              console.error(`[stale-refresh] Contact HubSpot update failed:`, err);
            }
          }
        }
      }

      // Push company to HubSpot if enabled
      if (company.hubspot_company_id && isHubSpotPushEnabled()) {
        try {
          await pushCompanyToHubSpot({
            domain: company.domain,
            intent_score: maxIntent,
            total_score: newTotal,
            lead_tier: newTier,
            lead_temp,
          });
        } catch (err) {
          console.error(`[stale-refresh] Company HubSpot update failed for ${company.domain}:`, err);
        }
      }

      refreshed++;
      console.log(`[stale-refresh] ${company.domain}: intent ${oldIntentScore} → ${maxIntent} (tier: ${newTier})`);
    }

    console.log(`[stale-refresh] Done. Refreshed: ${refreshed}, Score changes: ${scoreChanges}`);
    return { refreshed, score_changes: scoreChanges };
  },
});
