import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { runEmailWaterfall } from "../enrichment/email-waterfall.js";
import { findMobilePhone, profileSearch } from "../enrichment/providers/leadmagic.js";
import { domainsMatch } from "../enrichment/providers/cargo.js";
import { computeTier } from "../scoring/intent.js";
import { passesContactPushGateWithReason, isMql } from "../lib/gates.js";
import { createHubSpotContact, updateHubSpotContact, lookupHubSpotContact, lookupHubSpotContactEarly, isHubSpotPushEnabled } from "../lib/hubspot.js";
import { sendSlackAlert } from "../lib/slack.js";
import { generateLeadSummary } from "../lib/summaries.js";
import { deriveLeadOrigin, deriveLeadType, getSignalType, deriveAeOwner, AE_OWNERS, MQL_LIFECYCLE_STAGE } from "../lib/constants.js";
import { enrollInCampaign, isLemListEnabled, getRepACampaignId } from "../lib/lemlist.js";
import { tryMarkSignalDone } from "../lib/signal-lifecycle.js";
import { logEnrichmentCall, normalizeKey, startTimer } from "../enrichment/enrichment-logger.js";

// Contact Enrichment Pipeline
//
// 1. Email waterfall (Cargo primary, LeadMagic fallback)
// 2. Phone lookup (Cargo primary, LeadMagic fallback)
// 3. Look up company ICP score (from enrich-company)
// 4. Look up intent score (max from signals table)
// 5. Calculate Total Score + Lead Tier
// 6. Gate check → push to HubSpot
// 7. Hot → Slack alert
//
// getSignalType + deriveLeadOrigin live in lib/constants.ts (shared, testable).

export const enrichContactTask = task({
  id: "enrich-contact",
  run: async (payload: {
    raw_signal_id: string | null;
    domain: string;
    contact_name?: string | null;
    title?: string | null;
    email?: string | null;
    linkedin_url?: string | null;
    lead_source?: string | null;
    lead_type?: "inbound" | "outbound" | "referral" | "unknown" | null;
    company_id?: string | null;
    ae_owner?: "rep_a" | "rep_b" | null;
    existing_contact_id?: string | null;  // For stale contact refresh
  }) => {
    const { domain, contact_name, title, linkedin_url: payloadLinkedIn, lead_source, lead_type: explicitLeadType, ae_owner: explicitAeOwner } = payload;
    let linkedin_url = payloadLinkedIn; // Mutable — Cargo can backfill this

    // Stale refresh: If existing_contact_id is set, this is a refresh of a known contact.
    // Fetch existing contact to get hubspot_contact_id (avoids duplicate HubSpot create).
    let existingHubSpotId: string | null = null;
    if (payload.existing_contact_id) {
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("hubspot_contact_id, email, linkedin_url")
        .eq("id", payload.existing_contact_id)
        .single();

      if (existingContact?.hubspot_contact_id) {
        existingHubSpotId = existingContact.hubspot_contact_id;
        console.log(`[enrich-contact] Stale refresh for ${contact_name} — existing HubSpot ID: ${existingHubSpotId}`);
      }
      // Also use existing email/linkedin if not in payload
      if (!linkedin_url && existingContact?.linkedin_url) {
        linkedin_url = existingContact.linkedin_url;
      }
    }

    // Step 0: Early HubSpot check — skip enrichment if contact already exists
    // Saves LeadMagic credits on contacts Clay already pushed
    const titleCase = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase());
    const first_name = contact_name?.split(" ")[0] ? titleCase(contact_name.split(" ")[0]) : null;
    const last_name = contact_name?.split(" ").slice(1).join(" ") ? titleCase(contact_name.split(" ").slice(1).join(" ")) : null;

    const earlyLookup = await lookupHubSpotContactEarly({
      linkedinUrl: linkedin_url,
      firstName: first_name,
      lastName: last_name,
      companyDomain: domain,
    });
    if (earlyLookup.exists) {
      console.log(`[enrich-contact] ${contact_name} already in HubSpot (${earlyLookup.id}) — skipping enrichment, storing ID`);

      // Store the HubSpot contact ID so update-hubspot can push score updates later
      const identifier = earlyLookup.email || payload.email || linkedin_url;
      if (identifier) {
        const conflictCol = earlyLookup.email || payload.email ? "email" : "linkedin_url";
        const upsertData: Record<string, any> = {
          domain,
          first_name,
          last_name,
          title,
          linkedin_url,
          hubspot_contact_id: earlyLookup.id,
          ...(earlyLookup.email && { email: earlyLookup.email }),
          ...(!earlyLookup.email && payload.email && { email: payload.email }),
          ...(payload.company_id && { company_id: payload.company_id }),
        };
        await supabase.from("contacts").upsert(upsertData, { onConflict: conflictCol }).select("id");
      }

      // Link contact to raw_signal so tryMarkSignalDone can mark it done.
      // The upsert above may have created/found a contact row — grab its ID.
      if (payload.raw_signal_id && identifier) {
        const conflictColForLookup = earlyLookup.email || payload.email ? "email" : "linkedin_url";
        const lookupVal = conflictColForLookup === "email" ? (earlyLookup.email || payload.email) : linkedin_url;
        if (lookupVal) {
          const { data: linkedContact } = await supabase
            .from("contacts")
            .select("id")
            .eq(conflictColForLookup, lookupVal)
            .limit(1)
            .single();
          if (linkedContact) {
            await supabase.from("raw_signals").update({ contact_id: linkedContact.id }).eq("id", payload.raw_signal_id);
          }
        }
        await tryMarkSignalDone(payload.raw_signal_id);
      }

      // Backfill data to existing HubSpot contacts that V2 knows but HubSpot doesn't.
      // Syft native push, old Clay, and manual AE adds often miss LinkedIn URL and title.
      if (earlyLookup.id && isHubSpotPushEnabled() && (linkedin_url || title)) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: earlyLookup.id,
            ...(linkedin_url && { hs_linkedin_url: linkedin_url }),
            ...(title && { jobtitle: title }),
          });
          const fields = [linkedin_url && 'LinkedIn URL', title && 'title'].filter(Boolean).join(', ');
          console.log(`[enrich-contact] Backfilled ${fields} to existing HubSpot contact ${earlyLookup.id}`);
        } catch (err) {
          console.error(`[enrich-contact] Failed to backfill existing contact ${earlyLookup.id}:`, err);
        }
      }

      // Trigger score push for existing HubSpot contacts (fixes score gap)
      // Without this, contacts found as "already in HubSpot" never get V2 scores synced
      const { data: companyForPush } = await supabase
        .from("companies")
        .select("id, icp_score, lead_tier, name")
        .eq("domain", domain)
        .limit(1)
        .single();

      const { data: topSignalForPush } = await supabase
        .from("signals")
        .select("intent_score")
        .eq("domain", domain)
        .order("intent_score", { ascending: false })
        .limit(1)
        .single();

      if (companyForPush) {
        const icp = companyForPush.icp_score || 0;
        const intent = topSignalForPush?.intent_score || 0;
        const total = icp + intent;
        const tier = computeTier(total);

        const { updateHubSpot } = await import("./update-hubspot.js");
        await updateHubSpot.trigger({
          domain,
          company_id: companyForPush.id,
          company_name: companyForPush.name,
          intent_score: intent,
          icp_score: icp,
          total_score: total,
          lead_tier: tier,
        });
        console.log(`[enrich-contact] Triggered score push for existing contact ${contact_name} @ ${domain} (${tier}, ${total})`);
      }

      return {
        contact_id: null,
        domain,
        email: earlyLookup.email || null,
        tier: "unknown" as any,
        icp_score: 0,
        intent_score: 0,
        total_score: 0,
        pushed_to_hubspot: false,
        reason: "already_in_hubspot",
      };
    }

    // Step 0.5: LeadMagic employment verification via profile-search
    // Checks LinkedIn to verify contact still works at expected company.
    // Checks ALL active positions (handles consultants, fractional execs).
    // Departed contacts skip enrichment — saves credits.
    let cargoEmail: string | null = null;
    let cargoPhone: string | null = null;
    if (linkedin_url && domain) {
      try {
        const elapsed = startTimer();
        const profile = await profileSearch(linkedin_url);
        const durationMs = elapsed();

        logEnrichmentCall({
          provider: "leadmagic",
          operation: "profile_search",
          lookup_key: normalizeKey("linkedin", linkedin_url),
          input_payload: { profile_url: linkedin_url },
          output_payload: profile as any,
          credits_estimated: 1,
          trigger_source: "enrich-contact",
          success: !!profile,
          duration_ms: durationMs,
          company_id: payload.company_id || undefined,
          result_summary: profile ? { company: profile.current_company, title: profile.current_title } : undefined,
        }).catch(() => {});

        if (profile) {
          // Check ALL active positions — not just current_position.
          // Handles consultants, fractional execs, PE partners with concurrent roles.
          const workExperience: any[] = profile.raw?.work_experience || [];
          const activePositions = workExperience.filter((w: any) =>
            w.employment_period?.includes("Present")
          );

          const currentDomain = profile.company_website?.replace(/^https?:\/\//, "").replace(/\/.*/, "") || null;
          let match = domainsMatch(domain, currentDomain) || domainsMatch(domain, profile.current_company);

          if (!match) {
            for (const pos of activePositions) {
              const posDomain = pos.company_website?.replace(/^https?:\/\//, "").replace(/\/.*/, "") || null;
              if (domainsMatch(domain, posDomain) || domainsMatch(domain, pos.company_name)) {
                match = true;
                break;
              }
            }
          }

          if (!match && profile.current_company) {
            console.log(`[enrich-contact] DEPARTED: ${contact_name} left ${domain} → now at ${profile.current_company}`);

            // Upsert contact with departure info
            const conflictCol = payload.email ? "email" : "linkedin_url";
            const identifier = payload.email || linkedin_url;

            if (identifier) {
              const { data: departedContact } = await supabase.from("contacts").upsert({
                ...(payload.email && { email: payload.email }),
                ...(!payload.email && linkedin_url && { linkedin_url }),
                domain,
                first_name,
                last_name,
                title,
                job_change_detected_at: new Date().toISOString(),
                previous_title: title,
                previous_contact_name: contact_name,
                linkedin_url,
              }, { onConflict: conflictCol }).select("id").single();

              if (payload.raw_signal_id && departedContact) {
                await supabase.from("raw_signals").update({ contact_id: departedContact.id }).eq("id", payload.raw_signal_id);
              }
            }

            if (payload.raw_signal_id) {
              await tryMarkSignalDone(payload.raw_signal_id);
            }

            return {
              contact_id: null,
              domain,
              email: payload.email || null,
              tier: "unknown" as any,
              icp_score: 0,
              intent_score: 0,
              total_score: 0,
              pushed_to_hubspot: false,
              reason: "departed",
              departed_to: profile.current_company,
            };
          }

          if (match) {
            console.log(`[enrich-contact] Verified ${contact_name} @ ${domain} (title: ${profile.current_title})`);
          }
        }
      } catch (err) {
        // Non-blocking — verification failures don't stop enrichment
        console.warn(`[enrich-contact] Profile verification failed for ${contact_name}, continuing:`, err);
      }
    }

    // Step 1: Email — use Cargo's email if available, otherwise LeadMagic waterfall
    let email: string | null = cargoEmail || payload.email || null;
    let emailVerified: boolean = !!cargoEmail; // Cargo emails are LinkedIn-sourced
    let emailSource: string = cargoEmail ? "cargo" : "unknown";
    if (!email) {
      const emailResult = await runEmailWaterfall({
        existing_email: null,
        contact_name,
        domain,
      });
      email = emailResult.email;
      emailVerified = emailResult.verified;
      emailSource = emailResult.source;
    } else {
      console.log(`[enrich-contact] Skipping email waterfall — already have: ${email}`);
    }

    // Step 2: Phone — use Cargo's phone if available, otherwise LeadMagic mobile-finder
    let phone: string | null = cargoPhone;
    if (!phone && linkedin_url) {
      const phoneElapsed = startTimer();
      const phoneResult = await findMobilePhone(linkedin_url);
      const phoneDurationMs = phoneElapsed();
      phone = phoneResult?.mobile_number || null;

      logEnrichmentCall({
        provider: "leadmagic",
        operation: "find_mobile_phone",
        lookup_key: normalizeKey("linkedin", linkedin_url),
        input_payload: { linkedin_url },
        output_payload: phoneResult as any,
        credits_estimated: 1,
        trigger_source: "enrich-contact",
        success: !!phone,
        duration_ms: phoneDurationMs,
        company_id: payload.company_id || undefined,
        result_summary: phone ? { phone } : undefined,
      }).catch(() => {});
    } else if (phone) {
      console.log(`[enrich-contact] Skipping phone lookup — Cargo provided: ${phone}`);
    }

    // Step 3: Look up company ICP score
    let icp_score = 0;
    let vertical_fit_score = 0;
    let company_id = payload.company_id;
    let companyData: any = null;

    const companySelect = "id, icp_score, vertical_fit_score, name, sub_market, sales_org_summary, city, state, country, first_touch_source, utm_sources, utm_medium, touch_campaigns, lead_summary, employee_count, description, industry, funding_stage, funding_total, outbound_need_score, sales_team_data, hubspot_company_id";

    if (company_id) {
      const { data } = await supabase
        .from("companies")
        .select(companySelect)
        .eq("id", company_id)
        .single();
      if (data) {
        icp_score = data.icp_score || 0;
        vertical_fit_score = data.vertical_fit_score || 0;
        companyData = data;
      }
    } else {
      // Look up by domain
      const { data } = await supabase
        .from("companies")
        .select(companySelect)
        .eq("domain", domain)
        .limit(1)
        .single();
      if (data) {
        company_id = data.id;
        icp_score = data.icp_score || 0;
        vertical_fit_score = data.vertical_fit_score || 0;
        companyData = data;
      }
    }

    // Check if company has Fibbler engagement (from fibbler-sync signals)
    const { data: fibblerSignal } = await supabase
      .from("signals")
      .select("fibbler_clicks, fibbler_leads, fibbler_impressions")
      .eq("domain", domain)
      .eq("source", "fibbler_engagement")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const fibbler_influenced = !!(fibblerSignal && (
      (fibblerSignal.fibbler_clicks || 0) > 0 ||
      (fibblerSignal.fibbler_leads || 0) > 0
    ));

    // Step 4: Look up max intent score + tier from signals (single source of truth)
    // score-intent.ts computes these — read instead of recomputing (fixes scoring redundancy)
    const { data: topSignal } = await supabase
      .from("signals")
      .select("intent_score, total_score, lead_tier")
      .eq("domain", domain)
      .order("intent_score", { ascending: false })
      .limit(1)
      .single();

    const intent_score = topSignal?.intent_score || 0;
    // Always recompute total_score from fresh company ICP + signal intent.
    // score-intent may have run before enrich-company set ICP, so signal's
    // total_score can be stale (e.g. 0+40=40 instead of 91+40=131).
    const total_score = icp_score + intent_score;
    const tier = computeTier(total_score) as "hot" | "warm" | "cool" | "cold";
    const tier_display = tier.charAt(0).toUpperCase() + tier.slice(1); // "hot" → "Hot"

    const signal_type = getSignalType(lead_source || null);

    // MQL determination — GTMOS owns this, not HubSpot workflows
    // MQL = inbound + hot/warm + buyer title (allowlist) + SLED + intent > 0
    // Uses isMql() from gates.ts (buyer title allowlist + SLED check),
    // NOT isMQL() from constants.ts (which had no title or sub_market check).
    const contactIsMQL = isMql({
      lead_type: explicitLeadType || deriveLeadType(lead_source),
      lead_tier: tier,
      title: title || null,
      sub_market: companyData?.sub_market || null,
    }) && (intent_score > 0);
    const mql_at = contactIsMQL ? new Date().toISOString() : null;

    // Guard: must have at least one identifier (email or linkedin_url)
    // contacts table has CHECK constraint: contacts_has_identifier
    if (!email && !linkedin_url) {
      console.log(`[enrich-contact] No email or LinkedIn URL found for ${contact_name} @ ${domain} — skipping`);
      // No contact to create, but signal shouldn't stay stuck in "scoring".
      // contactExpected will be false (no email, no linkedin_url), so tryMarkSignalDone
      // will mark done if company_id is set.
      if (payload.raw_signal_id) {
        await tryMarkSignalDone(payload.raw_signal_id);
      }
      return {
        contact_id: null,
        domain,
        email: null,
        tier,
        icp_score,
        intent_score,
        total_score,
        pushed_to_hubspot: false,
        reason: "no_identifier",
      };
    }

    // Territory routing: derive ae_owner from sub_market if not explicitly set
    // RepA: K12 EdTech, RepB: Higher Ed + State/Local Gov
    const derivedAeOwner = explicitAeOwner || deriveAeOwner(companyData?.sub_market);

    // Upsert contact row — email and linkedin_url both have UNIQUE constraints
    // Race condition: two Syft signals for same person can arrive simultaneously
    const conflictColumn = email ? "email" : "linkedin_url";
    const { data: contact, error: insertErr } = await supabase
      .from("contacts")
      .upsert({
        company_id,
        domain,
        email,
        email_verified: emailVerified,
        email_source: emailSource,
        first_name,
        last_name,
        title,
        linkedin_url,
        phone,
        phone_source: cargoPhone ? "cargo" : (phone ? "leadmagic_mobile" : null),
        signal_type,
        icp_score,
        intent_score,
        tier,
        lead_origin: deriveLeadOrigin(lead_source),
        lead_type: explicitLeadType || deriveLeadType(lead_source),
        lead_source: lead_source || "unknown",
        first_touch_channel: companyData?.first_touch_source || null,
        utm_source: companyData?.utm_sources || null,
        utm_medium: companyData?.utm_medium || null,
        utm_campaign: companyData?.touch_campaigns || null,
        enriched_at: new Date().toISOString(),
        fibbler_influenced,
        enrichment_sources: [emailSource, phone ? (cargoPhone ? "cargo" : "leadmagic") : null].filter(Boolean),
        is_mql: contactIsMQL,
        ...(mql_at && { mql_at }),
        ...(derivedAeOwner && { ae_owner: derivedAeOwner }),
      }, { onConflict: conflictColumn })
      .select("id")
      .single();

    if (insertErr) throw insertErr;

    // Link raw signal to contact
    if (payload.raw_signal_id) {
      await supabase.from("raw_signals").update({ contact_id: contact.id }).eq("id", payload.raw_signal_id);
      // Always attempt to mark done — tryMarkSignalDone checks internally whether
      // both company_id and contact_id are set. The old guard (`if payload.company_id`)
      // caused a race condition: when both company and contact are new, normalize passes
      // company_id=null, so this was skipped. enrich-company's call also skipped because
      // contact_id wasn't written yet. Result: signal stuck in "scoring" forever.
      await tryMarkSignalDone(payload.raw_signal_id);
    }

    // Inline departure check — if we just enriched a new contact for a domain
    // that already has contacts, check if anyone got replaced (same role, different person).
    // No extra API calls — just a Supabase query comparing titles.
    if (title && contact_name) {
      try {
        const { data: existingContacts } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, title, full_name, email, linkedin_url, hubspot_contact_id, job_change_detected_at")
          .eq("domain", domain)
          .neq("id", contact.id)
          .is("job_change_detected_at", null); // Only check contacts not already flagged

        if (existingContacts?.length) {
          const newTitle = (title || "").toLowerCase();
          const newName = (contact_name || "").toLowerCase();

          for (const existing of existingContacts) {
            const existingTitle = (existing.title || "").toLowerCase();
            const existingName = (existing.full_name || `${existing.first_name || ""} ${existing.last_name || ""}`.trim()).toLowerCase();

            // Same role, different person = likely departed
            const titleOverlap = existingTitle && newTitle && titlesMatchRole(existingTitle, newTitle);
            const differentPerson = !namesLikelySamePerson(existingName, newName);

            if (titleOverlap && differentPerson) {
              console.log(`[enrich-contact] Departure detected: ${existingName} (${existingTitle}) replaced by ${contact_name} (${title}) at ${domain}`);

              await supabase.from("contacts").update({
                job_change_detected_at: new Date().toISOString(),
                previous_title: existing.title,
                previous_contact_name: existing.full_name || `${existing.first_name || ""} ${existing.last_name || ""}`.trim(),
                needs_refresh: true,
              }).eq("id", existing.id);

              try {
                await sendSlackAlert({
                  type: "contact_departed",
                  domain,
                  company_name: companyData?.name || undefined,
                  old_contact_name: existing.full_name || `${existing.first_name || ""} ${existing.last_name || ""}`.trim(),
                  old_title: existing.title || "",
                  new_contact_name: contact_name,
                  new_title: title,
                });
              } catch (err) {
                console.error(`[enrich-contact] Departure alert failed:`, err);
              }
            }
          }
        }
      } catch (err) {
        // Non-critical — don't block enrichment on departure check failure
        console.error(`[enrich-contact] Departure check error for ${domain}:`, err);
      }
    }

    // Step 6-7: Check push gate + generate lead summary
    const hsLookup = email ? await lookupHubSpotContact(email) : { exists: false };

    // If contact exists in HubSpot, store the ID even though we won't push (avoids duplicate)
    // This lets update-hubspot.ts push score updates to this contact later
    if (hsLookup.exists && hsLookup.id) {
      await supabase.from("contacts").update({
        hubspot_contact_id: hsLookup.id,
      }).eq("id", contact.id);
      console.log(`[enrich-contact] ${email} exists in HubSpot (${hsLookup.id}) — stored ID for future updates`);
    }

    const contactGateResult = passesContactPushGateWithReason({
      email,
      has_existing_hubspot_contact: hsLookup.exists,
      domain,
      title: title || null,
      icp_score,
      lead_tier: tier_display,
      lead_source: lead_source || null,
      vertical_fit_score,
      sub_market: companyData?.sub_market || null,  // SLED-only gate
      country: companyData?.country || null,        // Geo gate: US/CA only
    });

    if (!contactGateResult.passes) {
      console.log(`[enrich-contact] Push gate rejected ${email}: ${contactGateResult.reason}`);
      await supabase.from("push_log").insert({
        entity_type: "contact",
        entity_id: contact.id,
        destination: "hubspot",
        action: "gate_rejected",
        success: false,
        error: `Gate rejection: ${contactGateResult.reason}`,
      });
    }

    let lead_summary: string | null = null;
    let hsResult: { id: string } | null = null; // Track actual HubSpot push success

    if (contactGateResult.passes && isHubSpotPushEnabled()) {
      // G8-G10 fix: AI-generated summary with signal behavior data
      // Fetch latest signal with actual activity data — not empty Fibbler rows
      const { data: latestSignal } = await supabase
        .from("signals")
        .select("page_views, sessions, active_time_seconds, session_pages_visited, linkedin_action, syft_purchase_intent, fibbler_clicks, fibbler_leads, fibbler_impressions, utm_channel, created_at")
        .eq("domain", domain)
        .or("page_views.gt.0,sessions.gt.0,linkedin_action.not.is.null")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      lead_summary = await generateLeadSummary({
        contact_name: contact_name ?? null,
        title: title ?? null,
        email,
        company_name: companyData?.name || null,
        domain,
        description: companyData?.description || null,
        employee_count: companyData?.employee_count || null,
        industry: companyData?.industry || null,
        sales_team_data: null,
        sub_market: companyData?.sub_market || null,
        funding_stage: companyData?.funding_stage || null,
        funding_total: companyData?.funding_total || null,
        page_views: latestSignal?.page_views,
        sessions: latestSignal?.sessions,
        active_time_seconds: latestSignal?.active_time_seconds,
        pages_visited: latestSignal?.session_pages_visited,
        linkedin_action: latestSignal?.linkedin_action,
        syft_purchase_intent: latestSignal?.syft_purchase_intent,
        fibbler_clicks: latestSignal?.fibbler_clicks,
        fibbler_leads: latestSignal?.fibbler_leads,
        fibbler_impressions: latestSignal?.fibbler_impressions,
        lead_source: lead_source || null,
        signal_date: latestSignal?.created_at || null,
        icp_score,
        intent_score,
        total_score,
        tier,
        vertical_fit_score: companyData?.vertical_fit_score || null,
        outbound_need_score: companyData?.outbound_need_score || null,
        utm_source: companyData?.utm_sources,
        utm_medium: companyData?.utm_medium,
        utm_campaign: companyData?.touch_campaigns,
      });

      if (lead_summary) {
        await supabase.from("contacts").update({ lead_summary }).eq("id", contact.id);
      }

      // Step 8: Push to HubSpot
      // hsResult declared at top level — stays null if push fails, so return
      // correctly reports pushed_to_hubspot: false. Slack alert still fires
      // but without the HubSpot button.
      try {
        // Outbound + departed contacts: set owner directly, bypass MQL workflows
        const isOutboundSource = ["tam_import", "departed_follow", "departed_backfill"].includes(lead_source || "");

        // Owner assignment:
        // 1) Use explicit ae_owner if set (from TAM activate payload)
        // 2) Fall back to territory routing (derived from sub_market)
        // 3) For outbound with no territory routing, default to RepA (primary AE)
        let finalAeOwner = derivedAeOwner;
        if (!finalAeOwner && isOutboundSource) {
          finalAeOwner = "rep_a";  // Default outbound owner when no territory match
          console.log(`[enrich-contact] Outbound ${lead_source} with no territory routing, defaulting to RepA`);
        }

        // Set owner for: 1) outbound sources, OR 2) any lead with territory routing
        const shouldSetOwner = isOutboundSource || finalAeOwner !== null;
        const ownerHsId = shouldSetOwner && finalAeOwner ? AE_OWNERS[finalAeOwner] : undefined;

        // Stale refresh: update existing HubSpot contact instead of creating
        if (existingHubSpotId) {
          await updateHubSpotContact({
            hubspot_contact_id: existingHubSpotId,
            jobtitle: title || undefined,
            hs_linkedin_url: linkedin_url || undefined,
            lead_tier: isOutboundSource ? undefined : (tier_display === "Cold" ? "" : tier_display),
            lead_temp: isOutboundSource ? undefined : (tier_display === "Cool" ? "Cold" : (tier_display || "Cold")),
            total_score,
            icp_score,
            intent_score,
            lead_summary: lead_summary || undefined,
            phone: phone || undefined,
          });
          hsResult = { id: existingHubSpotId };
          console.log(`[enrich-contact] Stale refresh: updated HubSpot contact ${existingHubSpotId}`);
        } else {
          hsResult = await createHubSpotContact({
            email: email!,
            first_name: first_name || undefined,
            last_name: last_name || undefined,
            jobtitle: title || undefined,
            company: companyData?.name || domain,
            hs_linkedin_url: linkedin_url || undefined,
            // Only skip lead_tier/lead_temp for outbound sources (not territory-routed inbound)
            lead_tier: isOutboundSource ? undefined : (tier_display === "Cold" ? "" : tier_display),
            // Skip lead_temp for outbound/departed — triggers MQL Progression + Cold Lead Nurture workflows
            // that are designed for inbound signals, not assigned contacts.
            lead_temp: isOutboundSource ? undefined : (tier_display === "Cool" ? "Cold" : (tier_display || "Cold")),
            lead_origin: deriveLeadOrigin(lead_source),
            lead_type: explicitLeadType || deriveLeadType(lead_source),
            clay_lead_source: fibbler_influenced
              ? `${lead_source || "unknown"},fibbler_linkedin_ad`
              : (lead_source || "unknown"),
            // signal_type is now nullable (getSignalType returns null for non-
            // signal sources like tam_import). Coerce null→undefined so the
            // HubSpot push payload's optional-field spread (`...(data.signal_type
            // && { signal_type })` in lib/hubspot.ts) omits the property cleanly
            // instead of sending "null" as a string.
            signal_type: signal_type ?? undefined,
            total_score,
            icp_score,
            intent_score,
            lead_summary: lead_summary || undefined,
            sales_org_summary: companyData?.sales_org_summary || undefined,
            sub_market: companyData?.sub_market || undefined,
            city: companyData?.city || undefined,
            state: companyData?.state || undefined,
            first_touch_channel: companyData?.first_touch_source || undefined,
            utm_source: companyData?.utm_sources || undefined,
            utm_medium: companyData?.utm_medium || undefined,
            utm_campaign: companyData?.touch_campaigns || undefined,
            phone: phone || undefined,
            // Signal attribution: structured fields for HubSpot filtering/reporting
            signal_date: latestSignal?.created_at || undefined,
            signal_pages_visited: latestSignal?.session_pages_visited || undefined,
            signal_sessions: latestSignal?.sessions || undefined,
            signal_time_on_site: latestSignal?.active_time_seconds || undefined,
            // Lifecycle stage — GTMOS owns this, not HubSpot workflows:
            // - MQL (inbound + hot/warm): lifecyclestage = marketingqualifiedlead
            // - TAM/departed (outbound): lifecyclestage = lead (so MQL Progression skips)
            // - Otherwise: undefined (let HubSpot default)
            hubspot_owner_id: ownerHsId,
            lifecyclestage: contactIsMQL ? MQL_LIFECYCLE_STAGE : (isOutboundSource ? "lead" : undefined),
          });
        }

        await supabase.from("contacts").update({
          hubspot_contact_id: hsResult.id,
          hubspot_pushed_at: new Date().toISOString(),
        }).eq("id", contact.id);

        // Associate contact with existing HubSpot company (prevents HubSpot from
        // auto-creating a duplicate company from the contact's company name property)
        if (companyData?.hubspot_company_id && hsResult.id) {
          try {
            const { hubspot: hsClient } = await import("../lib/hubspot.js");
            await hsClient.apiRequest({
              method: "PUT",
              path: `/crm/v4/objects/contacts/${hsResult.id}/associations/companies/${companyData.hubspot_company_id}`,
              body: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }],
            });
            console.log(`[enrich-contact] Associated contact ${hsResult.id} with company ${companyData.hubspot_company_id}`);
          } catch (err) {
            console.error(`[enrich-contact] Association failed:`, err);
          }
        }

        await supabase.from("push_log").insert({
          entity_type: "contact",
          entity_id: contact.id,
          destination: "hubspot",
          action: "create",
          success: true,
        });
      } catch (err) {
        console.error(`[enrich-contact] HubSpot push failed for ${email}:`, err);
        await supabase.from("push_log").insert({
          entity_type: "contact",
          entity_id: contact.id,
          destination: "hubspot",
          action: "create",
          success: false,
          error: String(err),
        });
      }

      // Step 9: MQL Slack alert
      // Rich format: contact + company + score + attribution + signal detail
      // + lead_summary narrative + HubSpot deep link + AE @-mention.
      //
      // Fire for MQLs only. GTMOS owns the MQL decision — isMql() from gates.ts:
      // inbound + hot/warm + buyer title allowlist + SLED + intent > 0.
      // TAM outbound and HubSpot backfill contacts are never MQLs.
      if (contactIsMQL) {
        try {
          await sendSlackAlert({
            type: "hot_lead",
            contact_name: contact_name || "Unknown",
            title: title || "Unknown",
            domain,
            company_name: companyData?.name ?? null,
            email: email || "No email",
            linkedin_url: linkedin_url ?? null,
            icp_score,
            intent_score,
            total_score,
            tier: tier as "hot" | "warm",  // Safe cast: contactIsMQL is only true for hot/warm
            lead_source: lead_source || "unknown",
            lead_origin: deriveLeadOrigin(lead_source),
            signal_type,
            sub_market: companyData?.sub_market ?? null,
            lead_summary: lead_summary ?? null,
            page_views: latestSignal?.page_views ?? null,
            sessions: latestSignal?.sessions ?? null,
            last_seen: latestSignal?.created_at ?? null,
            hubspot_contact_id: hsResult?.id ?? null,
            // Firmographics — scannable context the AE needs to qualify
            employee_count: companyData?.employee_count ?? null,
            city: companyData?.city ?? null,
            state: companyData?.state ?? null,
            funding_stage: companyData?.funding_stage ?? null,
            funding_total: companyData?.funding_total ?? null,
            // Sales org hero line — THE signal (this is what ACME sells against)
            sales_team_data: companyData?.sales_team_data ?? null,
            // Source visibility — RepA's #1 ask from the Apr 7 1:1
            pages_visited: latestSignal?.session_pages_visited ?? null,
            utm_channel: latestSignal?.utm_channel ?? null,
          });
        } catch (err) {
          console.error(`[enrich-contact] Slack alert failed:`, err);
        }
      }

      // Step 10: LemList enrollment — auto-enroll Hot/Warm MQLs with LinkedIn URLs
      // Skip TAM contacts — outbound motion is manual (Sales Nav + Excel per RepC's directive)
      if (isLemListEnabled() && linkedin_url && (tier === "hot" || tier === "warm") && lead_source !== "tam_import") {
        try {
          const result = await enrollInCampaign({
            campaignId: getRepACampaignId(),
            email,
            firstName: first_name,
            lastName: last_name,
            companyName: companyData?.name || null,
            linkedinUrl: linkedin_url,
            domain,
            title,
            icpScore: icp_score,
            leadSource: lead_source,
          });
          if (result.enrolled) {
            console.log(`[enrich-contact] LemList enrolled: ${contact_name} @ ${domain} (${tier}, lead=${result.leadId})`);
          } else {
            console.log(`[enrich-contact] LemList skip: ${contact_name} @ ${domain} — ${result.reason}`);
          }
        } catch (err) {
          // Non-blocking — don't fail enrichment if LemList is down
          console.error(`[enrich-contact] LemList enrollment error for ${contact_name}:`, err);
        }
      }
    }

    return {
      contact_id: contact.id,
      domain,
      email,
      tier,
      icp_score,
      intent_score,
      total_score,
      pushed_to_hubspot: hsResult !== null, // Actual push success, not just gate pass
    };
  },
});

// Title role matching — detects when two titles cover the same functional role.
// "VP Sales" and "VP of Sales" = same role. "VP Sales" and "CTO" = different.
// Intentionally loose — false positives (flagging someone who's still there)
// are cheaper than false negatives (letting a departed contact rot in the CRM).
// Credential suffixes that enrichment providers tack onto names
const CREDENTIAL_SUFFIXES = /,?\s*\b(ms[a-z]*|mba|phd|edd|cpa|cfa|pmp|sphr|shrm|cissp|cisa|lcsw|rn|md|jd|esq|pe|ra|aia|faia|cbe|ii|iii|iv|jr|sr)\b\.?/gi;

/** Normalize a name for comparison: strip credentials, punctuation, collapse whitespace. */
function normalizeName(raw: string): string[] {
  return raw
    .replace(CREDENTIAL_SUFFIXES, "")
    .replace(/[^a-zA-Z\s'-]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(p => p.length > 1); // drop single-letter initials
}

/**
 * Are these likely the same person? Handles:
 * - Credential suffixes: "Nikhil Reddy Challa, MSIE" vs "Nikhil Reddy"
 * - Middle names: "John Michael Smith" vs "John Smith"
 * - Partial names from enrichment: "nikhil reddy" vs "nikhil reddy challa"
 *
 * Returns true if first parts match AND at least 2 parts overlap (or shorter name is fully contained).
 */
function namesLikelySamePerson(a: string, b: string): boolean {
  if (!a || !b) return false;
  const partsA = normalizeName(a);
  const partsB = normalizeName(b);
  if (partsA.length === 0 || partsB.length === 0) return false;

  // First name must match
  if (partsA[0] !== partsB[0]) return false;

  // If either name is just a first name, first-name match is enough
  if (partsA.length === 1 || partsB.length === 1) return true;

  // Check if the shorter name's parts are all contained in the longer
  const [shorter, longer] = partsA.length <= partsB.length ? [partsA, partsB] : [partsB, partsA];
  const allContained = shorter.every(p => longer.includes(p));
  if (allContained) return true;

  // Fallback: at least 2 parts overlap (first name already matched, need one more)
  const overlap = shorter.filter(p => longer.includes(p)).length;
  return overlap >= 2;
}

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(vp|vice president|head)\b.*\b(sales|revenue|growth)\b/i, "sales_leader"],
  [/\b(vp|vice president|head)\b.*\b(marketing)\b/i, "marketing_leader"],
  [/\b(vp|vice president|head)\b.*\b(product)\b/i, "product_leader"],
  [/\b(vp|vice president|head)\b.*\b(eng|engineering|technology)\b/i, "eng_leader"],
  [/\bceo\b|chief executive/i, "ceo"],
  [/\bcto\b|chief technology/i, "cto"],
  [/\bcmo\b|chief marketing/i, "cmo"],
  [/\bcro\b|chief revenue/i, "cro"],
  [/\bcoo\b|chief operating/i, "coo"],
  [/\b(director|dir)\b.*\b(sales|revenue|growth|business dev)\b/i, "sales_director"],
  [/\b(director|dir)\b.*\b(marketing)\b/i, "marketing_director"],
  [/\b(director|dir)\b.*\b(product)\b/i, "product_director"],
  [/\b(director|dir)\b.*\b(ops|operations)\b/i, "ops_director"],
  [/\bfounder|co-founder\b/i, "founder"],
  [/\b(ae|account executive)\b/i, "ae"],
  [/\b(sdr|bdr|sales dev|business dev rep)\b/i, "sdr"],
  [/\brevops|rev ops|revenue operations\b/i, "revops"],
];

function titlesMatchRole(titleA: string, titleB: string): boolean {
  const roleA = ROLE_PATTERNS.find(([re]) => re.test(titleA))?.[1];
  const roleB = ROLE_PATTERNS.find(([re]) => re.test(titleB))?.[1];
  if (roleA && roleB && roleA === roleB) return true;
  // Fallback: exact match after normalization
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z]/g, "");
  return norm(titleA) === norm(titleB);
}
