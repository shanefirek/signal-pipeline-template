import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { cleanDomain, cleanEmail, validateDomain } from "../lib/gates.js";

// Syft Webhook Intake — replaces Clay Website Visitors + LinkedIn Activity webhook tables
//
// Receives raw Syft payload: { account, lead, session?, linkedin? }
//   - Website visitors: account + lead + session (session has page visit data)
//   - LinkedIn activity: account + lead + linkedin (no session object)
//
// Field name source of truth: real payloads in ~/projects/acme-syft/payloads/
//   - real-linkedin-renaissance-causey.json (LinkedIn Profile View)
//   - 2026-02-12T21-18-54-356Z_payload_1.json (Website visitor with session)
//
// CRITICAL: Syft sends BOTH unprefixed and syft_-prefixed versions of most fields.
// Always try the unprefixed version first, fall back to syft_-prefixed.
// LinkedIn URLs are at `lead.linkedin` and `account.linkedin` (NOT linkedinUrl).
//
// UTM SOURCE EXTRACTION: Syft does NOT expose utm_source as a top-level field.
// The raw utm_source/medium/campaign/term/content values live inside the full
// URL string at `account.syft_visited_pages`. syft_latest_utm_medium and
// syft_latest_utm_campaign ARE exposed as top-level fields, but utm_source
// must be parsed from the URL. When the URL has no UTM query params (direct
// / referral traffic), these stay null — which is correct.

// Convert Shape B's snake_case action type to Shape A's human-readable form so
// downstream scoring (scoreDirectAction in src/scoring/intent.ts) recognizes it.
// Shape B examples: "linkedin_new_follower", "linkedin_profile_view",
// "linkedin_new_company_follower", "linkedin_post_reaction",
// "linkedin_received_connection_request_accepted", "linkedin_sent_message",
// "linkedin_connection_established".
function humanizeShapeBAction(rawActionType: string): string | null {
  if (!rawActionType) return null;
  const t = rawActionType.toLowerCase().replace(/^linkedin_/, "");
  const map: Record<string, string> = {
    new_follower: "New Follower",
    new_company_follower: "New Company Follower",
    profile_view: "Profile View",
    profile_views: "Profile View",
    post_reaction: "Reaction",
    post_comment: "Comment",
    new_connection: "New Connection",
    connection_established: "New Connection",
    received_connection_request: "Received Connection Request",
    received_connection_request_accepted: "New Connection",
    sent_connection_request: "Sent Connection Request",
    sent_message: "Sent Message",
    received_message: "Received Message",
  };
  return map[t] || rawActionType;
}

// Extract UTM params from a URL string. Handles:
//   - Single URL: "https://acmegtm.com/?utm_source=google&utm_medium=cpc"
//   - Comma-separated list: "https://acmegtm.com/, https://acmegtm.com/pricing/?utm_source=linkedin"
//   - Invalid or null input (returns all-null)
// Picks the FIRST URL in the list that actually contains UTM params — this is
// typically the entry page for paid traffic. Falls back to the first URL for
// reference extraction (e.g. to identify pages visited even without UTMs).
function parseUtmsFromUrl(urlField: string | null | undefined): {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  gclid: string | null;
} {
  const empty = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    gclid: null,
  };
  if (!urlField || typeof urlField !== "string") return empty;

  // Split on comma (Syft sometimes joins multiple URLs) and find the first
  // one that has a `?utm_` param. If none, fall back to the first URL.
  const urls = urlField.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) return empty;

  const utmUrl = urls.find((u) => /[?&]utm_/.test(u)) || urls[0];

  try {
    const parsed = new URL(utmUrl);
    return {
      utm_source: parsed.searchParams.get("utm_source") || null,
      utm_medium: parsed.searchParams.get("utm_medium") || null,
      utm_campaign: parsed.searchParams.get("utm_campaign") || null,
      utm_term: parsed.searchParams.get("utm_term") || null,
      utm_content: parsed.searchParams.get("utm_content") || null,
      gclid: parsed.searchParams.get("gclid") || null,
    };
  } catch {
    // Malformed URL — just return nulls, don't throw
    return empty;
  }
}

export const syftWebhook = task({
  id: "syft-webhook",
  run: async (payload: {
    source: "syft_website" | "syft_linkedin";
    data: any;
  }) => {
    const { source, data } = payload;

    // ── Detect payload shape ──
    //
    // Syft sends TWO distinct webhook payload shapes for LinkedIn activity:
    //
    // Shape A: "LinkedIn Activity" webhook
    //   { account, lead, session?, linkedin: { action, timestamp, ... } }
    //   Fires on: Profile View, Connection Request (sent/received), New Follower,
    //   Sent Message, New Connection, etc. Has an explicit `linkedin.action` field.
    //
    // Shape B: "Lead Identified" webhook
    //   { id, domain, name, contacts: [{ properties: {...} }], vendorProps,
    //     matchedICPs, matchedIPersonaDetails, lastSeenVisitorDetail: { lastActionType } }
    //   Fires on the same underlying actions but ships Syft's pre-enriched lead
    //   record (with persona match, ICP score, tech stack). The action is in
    //   `lastSeenVisitorDetail.lastActionType` instead of `linkedin.action`.
    //
    // Prior to Apr 8, V2 only handled Shape A — Shape B events got all-null
    // fields and silently failed the validation gate. 18+ enriched leads dropped
    // in 2 weeks, including Phil Tallman (VP Partnerships @ Mantra Health) and
    // Eddie Vaisman (COO @ ChalkTalk). Detection rule: Shape B has `contacts[]`
    // and lacks `linkedin`.
    const isShapeB = !data.linkedin && Array.isArray(data.contacts);

    let account: any;
    let lead: any;
    let session: any;
    let linkedin: any;

    if (isShapeB) {
      // Normalize Shape B into the same field names the extractor uses.
      // The engaged person is the first entry in `contacts[]`. The company
      // lives at the top level.
      const firstContact = data.contacts[0] || {};
      const contactProps = firstContact.properties || {};
      const vendorCb = data.vendorProps?.cb || {};

      account = {
        domain: data.domain,
        name: data.name,
        industry: data.industry || vendorCb.industry,
        employees: data.employees || vendorCb.employees,
        employeeCount: data.employees || vendorCb.employees,
        city: data.city || vendorCb.address?.city,
        state: data.state || vendorCb.address?.state,
        country: vendorCb.address?.country,
        lastSeen: data.lastSeen,
        syft_last_seen: data.lastSeen,
        icps: data.matchedICPs,
        syft_icp: Array.isArray(data.matchedICPs) ? data.matchedICPs.join(", ") : null,
        purchaseIntent: data.intent,
        syft_purchase_intent: data.intent,
        highIntentSessions: data.highIntentSessions,
        syft_high_intent_sessions: data.highIntentSessions,
        pageViews: data.pageViews || 0,
        sessions: data.nSessions || 0,
        visitors: data.nVisitors || 0,
        timeSpent: data.timeSpent || 0,
        syft_intents_array: data.matchedIntents,
        syft_intents: Array.isArray(data.matchedIntents) ? data.matchedIntents.join(", ") : null,
        syft_latest_utm_channel: Array.isArray(data.touchChannels) ? data.touchChannels[0] : null,
        syft_utm_campaigns: Array.isArray(data.touchCampaigns) ? data.touchCampaigns.join(", ") : null,
        syft_visited_pages: data.pagesViewedStr || null,
        latestSource: data.firstTouchSource,
        originalSource: data.firstTouchSource,
        syft_persona_array: Array.isArray(data.matchedIPersonas) ? data.matchedIPersonas : null,
        syft_persona: Array.isArray(data.matchedIPersonas) ? data.matchedIPersonas.join(", ") : null,
        linkedin: vendorCb.linkedin ? `https://linkedin.com/${vendorCb.linkedin}` : null,
      };

      lead = {
        firstName: contactProps.firstName,
        lastName: contactProps.lastName,
        fullName: contactProps.fullName,
        email: firstContact.email || (Array.isArray(firstContact.emails) ? firstContact.emails[0] : null),
        title: contactProps.title,
        jobTitle: contactProps.title,
        linkedin: contactProps.linkedin ? `https://linkedin.com/${contactProps.linkedin}` : null,
        city: firstContact.city,
        state: firstContact.state,
        country: firstContact.country,
        personas: contactProps.properties?.personas || null,
        syft_persona: Array.isArray(data.matchedIPersonas) ? data.matchedIPersonas.join(", ") : null,
        lastSeen: firstContact.lastSeen || data.lastSeen,
        syft_last_seen: firstContact.lastSeen || data.lastSeen,
      };

      session = null; // Shape B has no session object

      // Shape B's action lives in lastSeenVisitorDetail.lastActionType,
      // formatted like "linkedin_new_follower" / "linkedin_profile_view".
      // Convert to the human-readable format Shape A uses so downstream
      // scoring (scoreDirectAction) recognizes it.
      const rawActionType = data.lastSeenVisitorDetail?.lastActionType || "";
      linkedin = {
        action: humanizeShapeBAction(rawActionType),
        timestamp: firstContact.lastSeen || data.lastSeen,
      };
    } else {
      // Shape A — the original { account, lead, session, linkedin } structure
      // NOTE: Some Syft webhook configs send "visitor" instead of "lead" — same
      // data, different key name. Check both. Apr 15 2026: This was the root
      // cause of 92% of signals having no contact data — we were reading `lead`
      // but Syft was sending `visitor`. Mike Levy (CRO @ SalesIntel) was the
      // smoking gun.
      ({ account, session, linkedin } = data);
      lead = data.lead || data.visitor;
    }

    // Extract fields from verified Syft payload structure
    const domain_raw = account?.domain || "";
    const domain = cleanDomain(domain_raw);
    const email = cleanEmail(lead?.email);

    // Early-exit: internal / partner / invalid domains. validateDomain blocks
    // acmegtm.com, starbridge.ai, digital-made.com, .edu, .gov,
    // .k12 domains. Without this check, syft-webhook inserts the raw_signal
    // first and then normalize drops it at the validation gate — wastes DB
    // writes and (as of Apr 8) crashes on Syft's float timeSpent before
    // normalize even runs. Apr 8 2026: Yoseph Tesfaye's LinkedIn post view on
    // acmegtm.com caused 3 consecutive syft-webhook failures because the
    // float-to-int error short-circuited the insert.
    const domainCheck = validateDomain(domain);
    if (!domainCheck.valid) {
      console.log(`[syft-webhook] Skipping ${domain} — ${domainCheck.reason}`);
      return { skipped: true, domain, reason: domainCheck.reason };
    }

    // Parse raw UTMs from the visited-pages URL (the ONLY place utm_source
    // lives in the Syft payload). When the entry URL has no UTM query params
    // (direct/referral traffic), these stay null — correct behavior.
    const visitedPagesUrl = account?.syft_visited_pages || lead?.syft_visited_pages || null;
    const parsedUtms = parseUtmsFromUrl(visitedPagesUrl);

    const extracted = {
      source,
      raw_payload: data,
      domain,
      domain_raw,
      email: email || null,
      first_name: lead?.firstName || lead?.first_name || null,
      last_name: lead?.lastName || lead?.last_name || null,
      contact_name: [lead?.firstName || lead?.first_name, lead?.lastName || lead?.last_name]
        .filter(Boolean).join(" ") || null,
      company_name: account?.name || null,
      title: lead?.title || lead?.jobTitle || null,

      // LinkedIn URLs: Syft uses `linkedin` (not linkedinUrl)
      linkedin_url: lead?.linkedin || lead?.linkedinUrl || lead?.linkedin_url || null,
      company_linkedin_url: account?.linkedin || account?.linkedinUrl || account?.linkedin_url || null,

      // Employee count: Syft sends both `employees` (number) and `employeeCount` (number)
      employees: (account?.employees ?? account?.employeeCount ?? account?.employee_count ?? "").toString() || null,
      industry: account?.industry || null,

      // Geo: lead-level overrides account-level. NOTE: Syft sometimes swaps city/state.
      city: lead?.city || account?.city || session?.city || null,
      state: lead?.state || account?.state || session?.state || null,
      country: lead?.country || account?.country || session?.country || null,

      // ── Engagement data ──
      // Page views: NOT in session object. Use account-level aggregate.
      // Session has `pages_visited` (URL array) and `active_time` (seconds), not counts.
      // Math.round() — Syft sends floats (e.g., 2.5) for these fields. Our
      // schema uses integer columns; unrounded values crash the insert.
      page_views: Math.round(account?.pageViews ?? account?.syft_page_views ?? lead?.pageViews ?? lead?.syft_page_views ?? 0),
      // Sessions: account-level aggregate
      sessions: Math.round(account?.sessions ?? account?.syft_sessions ?? lead?.sessions ?? lead?.syft_sessions ?? 0),
      // Active time: session-level for current visit, fallback to account aggregate
      // Math.round() — timeSpent is frequently a float (e.g., 9.5 for 9:30 min
      // on site). Apr 8 2026: Yoseph Tesfaye's visit caused 3 consecutive
      // syft-webhook failures with Postgres 22P02 "invalid input syntax for
      // type integer: 9.5" before this coercion was added.
      active_time_seconds: Math.round(session?.active_time ?? session?.activeTime ?? account?.timeSpent ?? account?.syft_time_spent ?? 0),
      // Visitor count: `account.visitors` (NOT visitorCount)
      visitor_count: Math.round(account?.visitors ?? account?.syft_visitors ?? account?.visitorCount ?? account?.visitor_count ?? 0),

      // Intent signals
      syft_purchase_intent: account?.purchaseIntent ?? account?.syft_purchase_intent ?? lead?.purchaseIntent ?? lead?.syft_purchase_intent ?? null,
      syft_intent_level: account?.purchaseIntent ?? account?.syft_purchase_intent ?? null, // Same as purchase_intent (Syft doesn't have a separate "intent level")
      icp_match: Array.isArray(account?.icps) ? account.icps.join(", ") : (account?.syft_icp ?? account?.icpMatch ?? null),
      // last_seen also serves as the dedup key for the partial unique index
      // raw_signals_syft_dedup_idx (domain, source, last_seen). LinkedIn
      // webhooks frequently lack account.lastSeen / lead.lastSeen, so fall
      // back to linkedin.timestamp (always present on linkedin events per
      // verified payloads) and then session.end_time/start_time as last
      // resorts. Without this, linkedin duplicates slip past the index.
      last_seen:
        account?.lastSeen ??
        account?.syft_last_seen ??
        lead?.lastSeen ??
        lead?.syft_last_seen ??
        linkedin?.timestamp ??
        session?.end_time ??
        session?.start_time ??
        null,

      // LinkedIn-specific action
      // action: "Profile View", "Like", "Comment", "Sent Message", "Received Message"
      // post_url + post_id in raw_payload.linkedin for post-level scoring
      linkedin_action: linkedin?.action || null,

      // ── Attribution ──
      // utm_channel: Syft's categorical label ("Direct", "Paid Search",
      // "Referral", "linkedin_organic", "Paid Other"). Exposed as a
      // top-level field by Syft.
      utm_channel: session?.utm_channel ?? session?.utmChannel ?? account?.syft_latest_utm_channel ?? null,
      // utm_sources (singular source, despite the plural column name):
      // Parsed from the URL in syft_visited_pages. NULL for direct/referral
      // traffic (no query string). This is the ONLY way to get raw
      // utm_source — Syft does not expose it as a top-level field.
      utm_sources: parsedUtms.utm_source,
      // utm_medium: URL-parsed takes priority (rich for paid traffic),
      // falls back to Syft's top-level field which catches "referral" and
      // similar categorical values.
      utm_medium: parsedUtms.utm_medium ?? session?.utm_medium ?? account?.syft_latest_utm_medium ?? lead?.syft_latest_utm_medium ?? null,
      // First touch: session referrer for current visit, fallback to account original
      first_touch_source: session?.referrer ?? account?.syft_original_referrer ?? account?.originalSource ?? null,
      // Aggregate attribution
      touch_channels: account?.syft_original_utm_channel ? `${account.syft_original_utm_channel}, ${account.syft_latest_utm_channel || ""}`.replace(/, $/, "") : null,
      // touch_campaigns: URL-parsed utm_campaign takes priority for current
      // visit, falls back to Syft's aggregate (syft_utm_campaigns) which
      // may contain multiple campaign IDs across touches.
      touch_campaigns: parsedUtms.utm_campaign ?? account?.syft_utm_campaigns ?? null,
      referrers: account?.syft_original_referrer ? `${account.syft_original_referrer}, ${account.syft_latest_referrer || ""}`.replace(/, $/, "") : null,
      latest_source: account?.latestSource ?? account?.syft_latest_source ?? lead?.latestSource ?? lead?.syft_latest_source ?? null,
      // Intents: Syft sends as array, join for text storage
      matched_intents: Array.isArray(account?.syft_intents_array) ? account.syft_intents_array.join(", ") : (account?.syft_intents ?? null),
      high_intent_sessions: Math.round(account?.highIntentSessions ?? account?.syft_high_intent_sessions ?? lead?.highIntentSessions ?? lead?.syft_high_intent_sessions ?? 0),
      // Pages: session-level array for current visit, fallback to account aggregate
      session_pages_visited: Array.isArray(session?.pages_visited) ? session.pages_visited.join(", ") : (account?.syft_visited_pages ?? lead?.syft_visited_pages ?? null),
      pages_viewed: account?.syft_visited_pages ?? account?.pagesViewed ?? account?.pages_viewed ?? null,
      // Personas: Syft sends as array
      lead_personas: Array.isArray(lead?.personas) ? lead.personas.join(", ") : (lead?.syft_persona ?? account?.syft_persona ?? null),

      lead_source: source,
    };

    // ── Dedup: Syft fires 2-3 webhooks per visit ──
    //
    // Every visit produces multiple webhook events within milliseconds:
    //   1. creationTrigger="Returning Visitors - To Clay"  (anonymous account +
    //      session + visitor, no lead data)
    //   2. creationTrigger="Syft Website - To Process"     (account + session +
    //      lead data, no visitor object)
    //   3. Sometimes a third sync event for linkedin activity
    //
    // Without dedup, every visit creates 2-3 raw_signals rows, all get
    // normalized, all get scored, all get contact-enriched, all fire Slack
    // alerts. RepA / RepB would see 2-3x alerts per visit.
    //
    // Dedup strategy: DB-level partial unique index on
    //   (domain, source, last_seen) WHERE last_seen IS NOT NULL
    // Syft sends the SAME account.lastSeen value on every webhook for the
    // same event, so the constraint catches duplicates regardless of
    // millisecond-level timing races (the prior 15-second app-layer dedup
    // couldn't — both queries ran before either had inserted, so neither
    // found the other).
    //
    // On conflict we catch the 23505 error and merge lead identity fields
    // (contact_name, email, linkedin_url, title, first/last name) from the
    // conflicting payload into the existing row. These are typically the
    // fields the second webhook brings but the first anonymous one lacks.
    const { data: row, error } = await supabase
      .from("raw_signals")
      .insert(extracted)
      .select("id")
      .single();

    if (error) {
      // Postgres unique-constraint violation code
      if (error.code === "23505") {
        // Find the existing row for this dedup key and merge lead fields
        const { data: existing } = await supabase
          .from("raw_signals")
          .select("id, contact_name, email, linkedin_url, title, first_name, last_name")
          .eq("domain", domain)
          .eq("source", source)
          .eq("last_seen", extracted.last_seen!)
          .maybeSingle();

        if (existing) {
          const mergeUpdate: Record<string, any> = {};
          if (!existing.contact_name && extracted.contact_name) mergeUpdate.contact_name = extracted.contact_name;
          if (!existing.email && extracted.email) mergeUpdate.email = extracted.email;
          if (!existing.linkedin_url && extracted.linkedin_url) mergeUpdate.linkedin_url = extracted.linkedin_url;
          if (!existing.title && extracted.title) mergeUpdate.title = extracted.title;
          if (!existing.first_name && extracted.first_name) mergeUpdate.first_name = extracted.first_name;
          if (!existing.last_name && extracted.last_name) mergeUpdate.last_name = extracted.last_name;

          if (Object.keys(mergeUpdate).length > 0) {
            await supabase.from("raw_signals").update(mergeUpdate).eq("id", existing.id);
            console.log(`[syft-webhook] Merged into existing ${existing.id} for ${domain}: ${Object.keys(mergeUpdate).join(", ")}`);
          } else {
            console.log(`[syft-webhook] Exact duplicate for ${domain} — skipping insert`);
          }
          return { raw_signal_id: existing.id, domain, source, deduped: true };
        }

        // Dedup key matched but we can't find the row — shouldn't happen
        console.error(`[syft-webhook] 23505 conflict but no existing row found for ${domain}/${source}/${extracted.last_seen}`);
        throw error;
      }

      console.error("[syft-webhook] Insert error:", error);
      throw error;
    }

    console.log(`[syft-webhook] Inserted raw signal ${row.id} for ${domain} (${source})`);

    // Trigger normalize task
    const { normalize } = await import("./normalize.js");
    await normalize.trigger({ raw_signal_id: row.id });

    return { raw_signal_id: row.id, domain, source };
  },
});
