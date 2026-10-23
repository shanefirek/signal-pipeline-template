import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { scoreIntent, scoreFibblerEngagement, scoreLinkedInPostEngagement, computeTier } from "../scoring/intent.js";

// Intent Scoring — replaces Clay Signal Scoring table (t_0taqh4m4K7qsUCoXXto)
// Source: ~/projects/acme-clay/tables/signal-scoring.md
//
// All formulas, zero external API calls. Scored on every signal event.
// 1. Insert signal row with all signal data
// 2. Calculate 5 intent components
// 3. Look up company ICP score
// 4. Calculate Total Score + Lead Tier
// 5. Update contact's intent_score + tier if contact exists

export const scoreIntent_task = task({
  id: "score-intent",
  run: async (payload: {
    raw_signal_id: string;
    domain: string;
    company_id?: string | null;
  }) => {
    const { raw_signal_id, domain } = payload;

    // Fetch raw signal data
    const { data: raw, error } = await supabase
      .from("raw_signals")
      .select("*")
      .eq("id", raw_signal_id)
      .single();

    if (error || !raw) throw new Error(`Raw signal ${raw_signal_id} not found`);

    // Calculate intent score (5 components)
    const intent = scoreIntent({
      syft_purchase_intent: raw.syft_purchase_intent,
      high_intent_sessions: raw.high_intent_sessions,
      page_views: raw.page_views,
      sessions: raw.sessions,
      active_time_seconds: raw.active_time_seconds,
      visitor_count: raw.visitor_count,
      linkedin_action: raw.linkedin_action,
      utm_channel: raw.utm_channel,
      session_pages_visited: raw.session_pages_visited,
    });

    // Look up company ICP score
    let icp_score = 0;
    let company_id = payload.company_id;

    if (company_id) {
      const { data: company } = await supabase
        .from("companies")
        .select("icp_score")
        .eq("id", company_id)
        .single();
      icp_score = company?.icp_score || 0;
    } else {
      const { data: company } = await supabase
        .from("companies")
        .select("id, icp_score")
        .eq("domain", domain)
        .limit(1)
        .single();
      if (company) {
        company_id = company.id;
        icp_score = company.icp_score || 0;
      }
    }

    // Look up Fibbler engagement for this domain (from fibbler-sync signals)
    const { data: fibblerSignal } = await supabase
      .from("signals")
      .select("fibbler_clicks, fibbler_leads, fibbler_impressions, fibbler_organic_engagements, fibbler_organic_impressions, fibbler_engagement_level")
      .eq("domain", domain)
      .eq("source", "fibbler_engagement")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const fibbler_score = fibblerSignal
      ? scoreFibblerEngagement(fibblerSignal)
      : 0;

    // Look up LinkedIn post engagement for this domain (from apify-linkedin-sync)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: postEngagement } = await supabase
      .from("signals")
      .select("linkedin_action, page_intent_score")
      .eq("domain", domain)
      .eq("source", "linkedin_post_engagement")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const { count: postEngagementCount } = await supabase
      .from("signals")
      .select("id", { count: "exact", head: true })
      .eq("domain", domain)
      .eq("source", "linkedin_post_engagement")
      .gte("created_at", sevenDaysAgo);

    const post_engagement_score = postEngagement
      ? scoreLinkedInPostEngagement({
          post_funnel_stage: postEngagement.page_intent_score >= 20 ? "bofu" : postEngagement.page_intent_score >= 10 ? "mofu" : "tofu",
          engagement_type: postEngagement.linkedin_action,
          engagements_7d: postEngagementCount || 0,
        })
      : 0;

    // Total + Lead Tier (intent + Fibbler + post engagement bonuses)
    const intentWithBonuses = intent.total + fibbler_score + post_engagement_score;
    const total_score = icp_score + intentWithBonuses;
    const lead_tier = computeTier(total_score);

    // Tier upgrade detection — compare against company's previous best
    let tier_upgraded = false;
    let previous_tier: string | null = null;
    let company_name: string | null = raw.company_name;

    if (company_id) {
      const { data: prevCompany } = await supabase
        .from("companies")
        .select("total_score, lead_tier, name")
        .eq("id", company_id)
        .single();

      if (prevCompany) {
        company_name = prevCompany.name || company_name;
        previous_tier = prevCompany.lead_tier;
        const tierRank: Record<string, number> = { cold: 0, cool: 1, warm: 2, hot: 3 };
        if ((tierRank[lead_tier] || 0) > (tierRank[previous_tier || "cold"] || 0)) {
          tier_upgraded = true;
          console.log(`[score-intent] Tier upgrade for ${domain}: ${previous_tier} → ${lead_tier} (${total_score})`);
        }
      }
    }

    // Insert signal row
    const { data: signal, error: insertErr } = await supabase
      .from("signals")
      .insert({
        raw_signal_id,
        company_id,
        source: raw.source,
        domain,
        company_name: raw.company_name,
        contact_name: raw.contact_name,
        title: raw.title,
        email: raw.email,
        linkedin_url: raw.linkedin_url,
        country: raw.country,
        page_views: raw.page_views,
        sessions: raw.sessions,
        active_time_seconds: raw.active_time_seconds,
        visitor_count: raw.visitor_count,
        linkedin_action: raw.linkedin_action,
        utm_channel: raw.utm_channel,
        syft_purchase_intent: raw.syft_purchase_intent,
        syft_intent_level: raw.syft_intent_level,
        high_intent_sessions: raw.high_intent_sessions,
        session_pages_visited: raw.session_pages_visited,
        pages_viewed: raw.pages_viewed,
        // Scoring breakdown
        purchase_intent_score: intent.purchase_intent,
        engagement_depth_score: intent.engagement_depth,
        direct_action_score: intent.direct_action,
        referral_source_score: intent.referral_source,
        page_intent_score: intent.page_intent,
        intent_score: intentWithBonuses,
        fibbler_score,
        icp_score,
        total_score,
        lead_tier,
      })
      .select("id")
      .single();

    if (insertErr) throw insertErr;

    // NOTE: Do NOT mark status="done" here. score-intent runs in parallel with
    // enrich-company and enrich-contact. Marking done here creates a race condition
    // where signals are "done" before company_id/contact_id are written.
    // The "done" transition is now owned by tryMarkSignalDone() in signal-lifecycle.ts,
    // called after enrichment writes IDs.

    // Update contact's intent score if contact exists for this domain
    // (takes the max intent score across all signals)
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, icp_score, fibbler_influenced")
      .eq("domain", domain);

    if (contacts?.length) {
      for (const contact of contacts) {
        const contactTotal = (contact.icp_score || 0) + intentWithBonuses;
        const contactTier = computeTier(contactTotal);

        await supabase
          .from("contacts")
          .update({
            intent_score: intentWithBonuses,
            tier: contactTier,
            fibbler_influenced: fibbler_score > 0 || contact.fibbler_influenced,
            last_signal_date: new Date().toISOString(),
            needs_refresh: true,
          })
          .eq("id", contact.id);
      }
    }

    // Trigger HubSpot update with intent data (G3/G4/G5 fix)
    // Company gets ICP data on first push (enrich-company), intent data here
    const { updateHubSpot } = await import("./update-hubspot.js");
    await updateHubSpot.trigger({
      domain,
      company_id: company_id ?? null,
      company_name,
      intent_score: intentWithBonuses,
      icp_score,
      total_score,
      lead_tier,
      tier_upgraded,
      previous_tier,
      lead_source: raw.lead_source,
    });

    return {
      signal_id: signal.id,
      domain,
      intent_score: intentWithBonuses,
      fibbler_score,
      icp_score,
      total_score,
      lead_tier,
      breakdown: intent,
    };
  },
});

// Export with the name the normalize task expects
export { scoreIntent_task as scoreIntent };
