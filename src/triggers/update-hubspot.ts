import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { pushCompanyToHubSpot, updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { computeTier } from "../scoring/intent.js";
import { companyLeadTemp } from "../scoring/icp.js";
import { sendSlackAlert } from "../lib/slack.js";
import { isSledSubMarket } from "../lib/gates.js";
import { generateLeadSummary } from "../lib/summaries.js";

// Update HubSpot — triggered by score-intent after scoring completes
//
// Fixes G3 (race condition), G4 (no company update), G5 (no contact update)
//
// enrich-company pushes ICP data to HubSpot but intent isn't scored yet.
// This task runs AFTER score-intent, pushing intent_score + total_score + lead_tier.
// Also updates existing contacts with new scores.
// Sends Slack alert on tier upgrades (warm→hot, cold→warm, etc.)

export const updateHubSpot = task({
  id: "update-hubspot",
  run: async (payload: {
    domain: string;
    company_id: string | null;
    company_name?: string | null;
    intent_score: number;
    icp_score: number;
    total_score: number;
    lead_tier: string;
    tier_upgraded?: boolean;
    previous_tier?: string | null;
    lead_source?: string | null;
  }) => {
    if (!isHubSpotPushEnabled()) {
      return { skipped: true, reason: "HUBSPOT_PUSH_ENABLED=false" };
    }

    const { domain, company_id, intent_score, icp_score, total_score, lead_tier: rawTier } = payload;
    const lead_tier = rawTier || "cold"; // Guard against undefined payload (caused charAt crash Apr 21)
    const lead_temp = companyLeadTemp(total_score);
    const results: { company_updated: boolean; contacts_updated: number } = {
      company_updated: false,
      contacts_updated: 0,
    };

    // 1. Update company in HubSpot with intent data
    let companySubMarket: string | null = null;
    let companyHubSpotId: string | null = null;
    if (company_id) {
      // Update company scores in Supabase
      await supabase.from("companies").update({
        intent_score,
        total_score,
        lead_tier,
        lead_temp,
        last_scored_at: new Date().toISOString(),
      }).eq("id", company_id);

      const { data: company } = await supabase
        .from("companies")
        .select("hubspot_company_id, domain, sub_market")
        .eq("id", company_id)
        .single();
      companySubMarket = company?.sub_market ?? null;
      companyHubSpotId = company?.hubspot_company_id ?? null;

      if (company?.hubspot_company_id) {
        try {
          await pushCompanyToHubSpot({
            domain,
            intent_score,
            total_score,
            lead_tier,
            lead_temp,
          });
          results.company_updated = true;

          await supabase.from("push_log").insert({
            entity_type: "company",
            entity_id: company_id,
            destination: "hubspot",
            action: "score_update",
            success: true,
          });
        } catch (err) {
          console.error(`[update-hubspot] Company score update failed for ${domain}:`, err);
          await supabase.from("push_log").insert({
            entity_type: "company",
            entity_id: company_id,
            destination: "hubspot",
            action: "score_update",
            success: false,
            error: String(err),
          });
        }
      }
    }

    // 2. Update all contacts for this domain that have HubSpot IDs
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, hubspot_contact_id, email, ae_owner")
      .eq("domain", domain)
      .not("hubspot_contact_id", "is", null);

    if (contacts?.length) {
      for (const contact of contacts) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: contact.hubspot_contact_id,
            intent_score,
            icp_score,
            total_score,
            lead_tier: lead_tier === "cold" ? "" : lead_tier.charAt(0).toUpperCase() + lead_tier.slice(1),
            lead_temp: lead_tier === "cool"
              ? "Cold"
              : (lead_tier.charAt(0).toUpperCase() + lead_tier.slice(1) || "Cold"),
          });
          results.contacts_updated++;

          await supabase.from("push_log").insert({
            entity_type: "contact",
            entity_id: contact.id,
            destination: "hubspot",
            action: "score_update",
            success: true,
          });
        } catch (err) {
          console.error(`[update-hubspot] Contact score update failed for ${contact.email}:`, err);
          await supabase.from("push_log").insert({
            entity_type: "contact",
            entity_id: contact.id,
            destination: "hubspot",
            action: "score_update",
            success: false,
            error: String(err),
          });
        }
      }
    }

    // 3. Regen lead_summary for contacts on this domain — signal data may have changed
    // This ensures returning visitors get an updated summary with fresh signal dates
    if (contacts?.length) {
      const { data: company } = await supabase
        .from("companies")
        .select("name, description, employee_count, industry, sub_market, sales_org_summary, funding_stage, funding_total, vertical_fit_score, outbound_need_score, sales_team_data")
        .eq("domain", domain)
        .single();

      // Fetch the latest signal with actual activity data — not empty Fibbler rows
      // that would overwrite real website/LinkedIn attribution with zeros
      const { data: latestSignal } = await supabase
        .from("signals")
        .select("page_views, sessions, active_time_seconds, session_pages_visited, linkedin_action, syft_purchase_intent, fibbler_clicks, fibbler_leads, fibbler_impressions, utm_channel, source, created_at")
        .eq("domain", domain)
        .or("page_views.gt.0,sessions.gt.0,linkedin_action.not.is.null")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (company && latestSignal) {
        for (const contact of contacts) {
          try {
            const { data: ctRow } = await supabase
              .from("contacts")
              .select("first_name, last_name, title, email, lead_source")
              .eq("id", contact.id)
              .single();

            if (!ctRow) continue;

            const contactName = [ctRow.first_name, ctRow.last_name].filter(Boolean).join(" ") || null;
            const summary = await generateLeadSummary({
              contact_name: contactName,
              title: ctRow.title || null,
              email: ctRow.email,
              company_name: company.name || null,
              domain,
              description: company.description || null,
              employee_count: company.employee_count || null,
              industry: company.industry || null,
              sub_market: company.sub_market || null,
              sales_team_data: company.sales_org_summary || null,
              funding_stage: company.funding_stage || null,
              funding_total: company.funding_total || null,
              lead_source: ctRow.lead_source || latestSignal.source || null,
              signal_date: latestSignal.created_at,
              page_views: latestSignal.page_views,
              sessions: latestSignal.sessions,
              active_time_seconds: latestSignal.active_time_seconds,
              pages_visited: latestSignal.session_pages_visited,
              linkedin_action: latestSignal.linkedin_action,
              syft_purchase_intent: latestSignal.syft_purchase_intent,
              fibbler_clicks: latestSignal.fibbler_clicks,
              fibbler_leads: latestSignal.fibbler_leads,
              fibbler_impressions: latestSignal.fibbler_impressions,
              icp_score,
              intent_score,
              total_score,
              tier: lead_tier,
              vertical_fit_score: company.vertical_fit_score || null,
              outbound_need_score: company.outbound_need_score || null,
            });

            if (summary) {
              await supabase.from("contacts").update({ lead_summary: summary }).eq("id", contact.id);
              await updateHubSpotContact({
                hubspot_contact_id: contact.hubspot_contact_id,
                lead_summary: summary,
                signal_date: latestSignal.created_at,
                signal_pages_visited: latestSignal.session_pages_visited,
                signal_sessions: latestSignal.sessions,
                signal_time_on_site: latestSignal.active_time_seconds,
              });
              console.log(`[update-hubspot] Summary refreshed for ${ctRow.email} @ ${domain}`);
            }
          } catch (err) {
            console.error(`[update-hubspot] Summary regen failed for contact ${contact.id}:`, err);
          }
        }
      }
    }

    // 4. Slack alert on tier upgrade (SLED only — blocklist checked globally in sendSlackAlert)
    if (payload.tier_upgraded && payload.previous_tier && isSledSubMarket(companySubMarket)) {
      try {
        const aeOwner = contacts?.find(c => c.ae_owner)?.ae_owner ?? null;
        await sendSlackAlert({
          type: "tier_upgrade",
          domain,
          company_name: payload.company_name || undefined,
          previous_tier: payload.previous_tier,
          new_tier: lead_tier,
          icp_score: payload.icp_score,
          intent_score: payload.intent_score,
          total_score: payload.total_score,
          lead_source: payload.lead_source || undefined,
          hubspot_company_id: companyHubSpotId,
          ae_owner: aeOwner,
        });
        console.log(`[update-hubspot] Slack tier upgrade alert sent: ${domain} ${payload.previous_tier} → ${lead_tier}`);
      } catch (err) {
        console.error(`[update-hubspot] Slack alert failed for ${domain}:`, err);
      }
    }

    return results;
  },
});
