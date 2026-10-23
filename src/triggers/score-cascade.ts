import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { computeTier } from "../scoring/intent.js";
import { sendSlackAlert } from "../lib/slack.js";
import { isSledSubMarket } from "../lib/gates.js";

// Score Cascade — triggered when a company's ICP score changes.
// Updates all contacts at that domain with new scores, re-tiers, pushes to HubSpot.

export const scoreCascade = task({
  id: "score-cascade",
  maxDuration: 120,
  run: async (payload: {
    domain: string;
    company_id: string;
    company_name?: string | null;
    new_icp_score: number;
    old_icp_score: number;
    new_lead_temp: string;
  }) => {
    // Fetch sub_market for SLED gating on Slack alerts
    const { data: companyRow } = await supabase
      .from("companies")
      .select("sub_market, hubspot_company_id")
      .eq("id", payload.company_id)
      .single();
    const companySubMarket = companyRow?.sub_market ?? null;

    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, hubspot_contact_id, icp_score, intent_score, tier, ae_owner")
      .eq("domain", payload.domain);

    if (!contacts?.length) {
      console.log(`[score-cascade] No contacts for ${payload.domain}`);
      return { contacts_updated: 0, tier_upgrades: 0 };
    }

    let updated = 0;
    let tierUpgrades = 0;

    for (const contact of contacts) {
      const newTotal = payload.new_icp_score + (contact.intent_score || 0);
      const newTier = computeTier(newTotal) || "cold";
      const oldTier = contact.tier || "cold";

      await supabase.from("contacts").update({
        icp_score: payload.new_icp_score,
      }).eq("id", contact.id);

      // Push to HubSpot
      if (contact.hubspot_contact_id && isHubSpotPushEnabled()) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: contact.hubspot_contact_id,
            icp_score: payload.new_icp_score,
            intent_score: contact.intent_score || 0,
            total_score: newTotal,
            lead_tier: newTier === "cold" ? "" : newTier.charAt(0).toUpperCase() + newTier.slice(1),
            lead_temp: newTier === "cool" ? "Cold" : (newTier.charAt(0).toUpperCase() + newTier.slice(1) || "Cold"),
          });
        } catch (err) {
          console.error(`[score-cascade] HubSpot update failed for contact ${contact.id}:`, err);
        }
      }

      // Detect tier upgrade
      const tierRank: Record<string, number> = { cold: 0, cool: 1, warm: 2, hot: 3 };
      if ((tierRank[newTier] || 0) > (tierRank[oldTier] || 0)) {
        tierUpgrades++;
      }

      updated++;
    }

    // Single Slack alert per company on tier upgrade (not per contact)
    if (tierUpgrades > 0 && isSledSubMarket(companySubMarket)) {
      try {
        const bestTotal = payload.new_icp_score + Math.max(...contacts.map(c => c.intent_score || 0));
        const bestTier = computeTier(bestTotal) || "cold";
        const aeOwner = contacts.find(c => c.ae_owner)?.ae_owner ?? null;
        await sendSlackAlert({
          type: "tier_upgrade",
          domain: payload.domain,
          company_name: payload.company_name || undefined,
          previous_tier: computeTier(payload.old_icp_score + Math.max(...contacts.map(c => c.intent_score || 0))) || "cold",
          new_tier: bestTier,
          icp_score: payload.new_icp_score,
          intent_score: Math.max(...contacts.map(c => c.intent_score || 0)),
          total_score: bestTotal,
          hubspot_company_id: companyRow?.hubspot_company_id ?? null,
          ae_owner: aeOwner,
        });
      } catch (err) {
        console.error(`[score-cascade] Slack alert failed:`, err);
      }
    }

    console.log(`[score-cascade] ${payload.domain}: ${updated} contacts updated, ${tierUpgrades} tier upgrades`);
    return { contacts_updated: updated, tier_upgrades: tierUpgrades };
  },
});
