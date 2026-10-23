import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import {
  passesValidationGate,
  isEnterpriseDomain,
  isDomainBlocked,
  isNotCustomer,
  passesContactDiscoveryGate,
  isSledSubMarket,
} from "../lib/gates.js";
import { lookupHubSpotCompany, lookupHubSpotContact } from "../lib/hubspot.js";
import { tryMarkSignalDone } from "../lib/signal-lifecycle.js";

// Normalize — replaces Clay Normalization table (t_0taomlkjy4mF9dPf9SE)
// Source: ~/projects/acme-clay/tables/normalization.md
//
// 1. Validate domain (not .edu/.gov/.k12, not acmegtm.com)
// 2. Validation gate (pageViews > 0 OR has LinkedIn action)
// 3. Enterprise blocklist check (39 domains)
// 4. Domain blocklist check (56 domains in Supabase)
// 5. HubSpot customer/opportunity lifecycle check
// 6. Dedup: company exists in Supabase?
// 7. Dedup: contact exists in Supabase + HubSpot?
// 8. Route to downstream tasks

export const normalize = task({
  id: "normalize",
  run: async (payload: { raw_signal_id: string }) => {
    const { raw_signal_id } = payload;

    // Fetch the raw signal
    const { data: signal, error } = await supabase
      .from("raw_signals")
      .select("*")
      .eq("id", raw_signal_id)
      .single();

    if (error || !signal) {
      throw new Error(`Raw signal ${raw_signal_id} not found`);
    }

    // Update status to enriching
    await supabase.from("raw_signals").update({ status: "enriching" }).eq("id", raw_signal_id);

    const domain = signal.domain;

    // 1. Validation gate
    if (!passesValidationGate({
      domain,
      page_views: signal.page_views,
      linkedin_action: signal.linkedin_action,
      lead_source: signal.lead_source,
    })) {
      await supabase.from("raw_signals").update({
        status: "filtered",
        validation: "fail",
        validation_gate: false,
      }).eq("id", raw_signal_id);
      return { status: "blocked", reason: "validation_gate" };
    }

    // 2. Enterprise blocklist
    if (isEnterpriseDomain(domain)) {
      await supabase.from("raw_signals").update({
        status: "filtered",
        validation: "pass",
        validation_gate: true,
        is_not_blocked: false,
      }).eq("id", raw_signal_id);
      return { status: "blocked", reason: "enterprise_blocklist" };
    }

    // 3. Domain blocklist (Supabase lookup)
    const blocked = await isDomainBlocked(domain);

    // 4. HubSpot customer check
    const hsCompany = await lookupHubSpotCompany(domain);
    const notCustomer = isNotCustomer(hsCompany.lifecycle, blocked, signal.lead_source);

    if (!notCustomer) {
      await supabase.from("raw_signals").update({
        status: "filtered",
        validation: "pass",
        validation_gate: true,
        is_not_blocked: !blocked,
        is_not_customer: false,
      }).eq("id", raw_signal_id);
      return { status: "blocked", reason: blocked ? "domain_blocklist" : "existing_customer" };
    }

    // 5. Dedup: company exists in Supabase?
    const { data: existingCompany } = await supabase
      .from("companies")
      .select("id, sub_market, icp_score, employee_count, vertical_fit_score, ae_owner, sales_team_data")
      .eq("domain", domain)
      .limit(1)
      .single();

    // Also check if enrichment is already in-flight (another signal for same domain)
    // Only check recent signals (last 10 min) to avoid permanent blocking on failed enrichments
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: pendingSignal } = await supabase
      .from("raw_signals")
      .select("id")
      .eq("domain", domain)
      .eq("status", "enriching")
      .neq("id", raw_signal_id)
      .gte("created_at", tenMinAgo)
      .limit(1)
      .single();

    const companyExists = !!existingCompany || !!pendingSignal;

    // 6. Dedup: contact exists in Supabase? (check by PERSON, not domain — G2 fix)
    // FIX: When contact exists, link signal to it and check if stale (needs refresh)
    let contactExistsClay = false;
    let existingContactId: string | null = null;
    let contactIsStale = false;

    if (signal.linkedin_url) {
      const { data } = await supabase
        .from("contacts")
        .select("id, enriched_at")
        .eq("linkedin_url", signal.linkedin_url)
        .limit(1)
        .single();
      if (data) {
        contactExistsClay = true;
        existingContactId = data.id;
        // Contact is stale if never enriched or enriched > 7 days ago
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        contactIsStale = !data.enriched_at || new Date(data.enriched_at) < sevenDaysAgo;
      } else if (signal.email && signal.email.trim() !== "") {
        // LinkedIn URL didn't match — fall back to email lookup.
        // Handles contacts stored with a different/null LinkedIn URL.
        const { data: byEmail } = await supabase
          .from("contacts")
          .select("id, enriched_at")
          .eq("email", signal.email)
          .limit(1)
          .single();
        if (byEmail) {
          contactExistsClay = true;
          existingContactId = byEmail.id;
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          contactIsStale = !byEmail.enriched_at || new Date(byEmail.enriched_at) < sevenDaysAgo;
        }
      }
    } else if (signal.email && signal.email.trim() !== "") {
      const { data } = await supabase
        .from("contacts")
        .select("id, enriched_at")
        .eq("email", signal.email)
        .limit(1)
        .single();
      if (data) {
        contactExistsClay = true;
        existingContactId = data.id;
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        contactIsStale = !data.enriched_at || new Date(data.enriched_at) < sevenDaysAgo;
      }
    }

    // Note: contact_id is set in the full validation update below (line ~168)
    // to avoid race condition with enrich-contact's contact_id write.

    // 7. Dedup: contact exists in HubSpot?
    const contactExistsHubspot = signal.email
      ? (await lookupHubSpotContact(signal.email)).exists
      : false;

    // Update raw signal with all validation results
    await supabase.from("raw_signals").update({
      validation: "pass",
      validation_gate: true,
      is_not_blocked: !blocked,
      is_not_customer: true,
      company_exists: companyExists,
      contact_exists_clay: contactExistsClay,
      contact_exists_hubspot: contactExistsHubspot,
      company_id: existingCompany?.id || null,
      contact_id: existingContactId,  // Link signal to existing contact
    }).eq("id", raw_signal_id);

    // 8. Route to downstream tasks
    // Set status BEFORE triggering to avoid race condition where
    // downstream tasks finish and set "done" before we set "scoring"
    await supabase.from("raw_signals").update({ status: "scoring" }).eq("id", raw_signal_id);

    // Always route to signal scoring (every signal gets scored)
    const { scoreIntent } = await import("./score-intent.js");
    await scoreIntent.trigger({
      raw_signal_id,
      domain,
      company_id: existingCompany?.id || null,
    });

    // Update has_intent_signal on existing outbound contacts when inbound signal arrives
    // This handles "two things can be true" — a TAM target can later show intent
    const inboundSources = ["syft_website", "syft_linkedin", "fibbler_engagement", "posthog_identify"];
    if (inboundSources.includes(signal.lead_source || "")) {
      const { error: intentErr } = await supabase
        .from("contacts")
        .update({ has_intent_signal: true })
        .eq("domain", domain)
        .eq("lead_type", "outbound")
        .eq("has_intent_signal", false);

      if (!intentErr) {
        // Check if any rows were updated (Supabase doesn't return count easily)
        const { data: updated } = await supabase
          .from("contacts")
          .select("id")
          .eq("domain", domain)
          .eq("lead_type", "outbound")
          .eq("has_intent_signal", true)
          .limit(1);

        if (updated?.length) {
          console.log(`[normalize] Updated has_intent_signal for outbound contacts at ${domain}`);
        }
      }
    }

    // Determine contact enrichment eligibility early — needed for deferred_contact below
    const hasIdentifier = signal.linkedin_url || (signal.email && signal.email.trim() !== "");
    const shouldEnrichContact = hasIdentifier && (
      (!contactExistsClay && !contactExistsHubspot) ||  // New contact
      contactIsStale  // Existing but stale (> 7 days since last enrichment)
    );

    // Route to company enrichment if company is new
    if (!companyExists) {
      const { enrichCompanyTask } = await import("./enrich-company.js");
      // Pass contact info as deferred_contact so enrich-company can trigger
      // enrich-contact AFTER the company row exists (prevents icp_score=0 race).
      const deferContact = shouldEnrichContact ? {
        contact_name: signal.contact_name,
        title: signal.title,
        email: signal.email,
        linkedin_url: signal.linkedin_url,
        lead_source: signal.lead_source,
        existing_contact_id: existingContactId,
      } : undefined;

      await enrichCompanyTask.trigger({
        raw_signal_id,
        domain,
        company_name: signal.company_name,
        signal_data: {
          lead_source: signal.lead_source,
          employees: signal.employees,
          industry: signal.industry,
          first_touch_source: signal.first_touch_source,
          touch_channels: signal.touch_channels,
          touch_campaigns: signal.touch_campaigns,
          utm_channel: signal.utm_channel,
          utm_sources: signal.utm_sources,
          utm_medium: signal.utm_medium,
          latest_source: signal.latest_source,
          matched_intents: signal.matched_intents,
          pages_viewed: signal.pages_viewed,
          lead_personas: signal.lead_personas,
          syft_intent_level: signal.syft_intent_level,
          // Syft company fields — used as fallback when LeadMagic has gaps
          city: signal.city,
          state: signal.state,
          country: signal.country,
          company_linkedin_url: signal.company_linkedin_url,
          syft_revenue: (signal.raw_payload as any)?.revenue || null,
          syft_description: (signal.raw_payload as any)?.description || (signal.raw_payload as any)?.researchSummary || null,
        },
        deferred_contact: deferContact,
      });
    }

    // When company is NEW, defer contact enrichment to enrich-company (via deferred_contact
    // in the payload). This prevents the race condition where enrich-contact runs before the
    // company row exists, gets company_id=null → icp_score=0 → is_mql=false → never pushed.
    // When company ALREADY EXISTS, trigger contact enrichment directly (no race).
    if (shouldEnrichContact && companyExists) {
      const { enrichContactTask } = await import("./enrich-contact.js");
      await enrichContactTask.trigger({
        raw_signal_id,
        domain,
        contact_name: signal.contact_name,
        title: signal.title,
        email: signal.email,
        linkedin_url: signal.linkedin_url,
        lead_source: signal.lead_source,
        company_id: existingCompany?.id || null,
        existing_contact_id: existingContactId,  // Pass existing contact ID for update
      });
      console.log(`[normalize] Triggered enrich-contact for ${signal.linkedin_url || signal.email} (stale=${contactIsStale})`);
    } else if (shouldEnrichContact && !companyExists) {
      console.log(`[normalize] Deferring enrich-contact for ${signal.linkedin_url || signal.email} to enrich-company (new company)`);
    }

    // Contact discovery for existing SLED companies with few contacts.
    // enrich-company runs discover-contact for NEW companies (Step 10), but
    // existing companies that get new signals never get it. This means a company
    // can be enriched, scored, and tier-upgraded but have zero people to call.
    //
    // 24h cooldown: prevents batch explosion when Syft sends multiple signals
    // for the same domain in one poll cycle. Without this, 20 signals = 20
    // discover-contact runs = 60 enrich-contact runs = Slack spam.
    let discoveryTriggered = false;
    if (companyExists && existingCompany && !shouldEnrichContact &&
        isSledSubMarket(existingCompany.sub_market) &&
        passesContactDiscoveryGate({
          icp_score: existingCompany.icp_score || 0,
          vertical_fit_score: existingCompany.vertical_fit_score || 0,
          employee_count: existingCompany.employee_count,
          has_sales_team: existingCompany.sales_team_data
            ? ((existingCompany.sales_team_data as any).ae_count > 0 ||
               (existingCompany.sales_team_data as any).sdr_count > 0 ||
               (existingCompany.sales_team_data as any).hiring_sales ||
               (existingCompany.sales_team_data as any).hiring_ae ||
               (existingCompany.sales_team_data as any).hiring_sdr)
            : undefined,  // No data yet — don't block, let discovery run
        })
    ) {
      // Only discover if company has < 3 contacts
      const { count: contactCount } = await supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("company_id", existingCompany.id);

      // 24h cooldown: skip if discover-contact already ran for this domain recently
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentDiscovery } = await supabase
        .from("enrichment_log")
        .select("id")
        .eq("provider", "cargo")
        .eq("operation", "find_stakeholders")
        .eq("lookup_key", `domain:${domain}`)
        .gte("created_at", oneDayAgo)
        .limit(1)
        .single();

      if ((!contactCount || contactCount < 3) && !recentDiscovery) {
        const { discoverContact } = await import("./discover-contact.js");
        await discoverContact.trigger({
          company_id: existingCompany.id,
          domain,
          employee_count: existingCompany.employee_count,
          lead_source: signal.lead_source || "company_discovery",
          ae_owner: existingCompany.ae_owner === "rep_a" || existingCompany.ae_owner === "rep_b" ? existingCompany.ae_owner : undefined,
        });
        discoveryTriggered = true;
        console.log(`[normalize] Triggered discover-contact for existing SLED company ${domain} (${contactCount || 0} contacts, < 3)`);
      } else if (recentDiscovery) {
        console.log(`[normalize] Skipping discover-contact for ${domain} — already ran in last 24h`);
      }
    }

    // If no downstream task will call tryMarkSignalDone (existing company +
    // no contact to enrich + no discovery), mark done here.
    if (companyExists && !shouldEnrichContact && !discoveryTriggered) {
      await tryMarkSignalDone(raw_signal_id);
    }

    return {
      status: "routed",
      company_exists: companyExists,
      contact_exists: contactExistsClay || contactExistsHubspot,
      contact_is_stale: contactIsStale,
      routes: {
        signal_scoring: true,
        company_enrichment: !companyExists,
        contact_enrichment: shouldEnrichContact,
      },
    };
  },
});
