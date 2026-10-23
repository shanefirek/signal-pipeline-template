import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { updateHubSpotContact, isHubSpotPushEnabled } from "../lib/hubspot.js";

// PostHog Identify — webhook handler (real-time, not cron)
//
// PostHog Action fires on $identify → POST to Trigger.dev endpoint.
// If contact exists with signal_type "Company Intent", upgrade to "Identified Visitor".
// If contact doesn't exist, insert raw_signal → enters enrichment pipe.
//
// Replaces: posthog-signal-upgrade.py (growth-ops cron)
//
// PostHog Action config (UI):
//   Name: "GTMOS Identify Webhook"
//   Match: event name = "$identify"
//   Action: Send webhook to POST {TRIGGER_DEV_URL}

export const posthogIdentify = task({
  id: "posthog-identify",
  run: async (payload: {
    event?: string;
    distinct_id?: string;
    properties?: {
      $set?: { email?: string; name?: string };
      $current_url?: string;
      $referrer?: string;
      utm_source?: string;
      utm_medium?: string;
      utm_campaign?: string;
    };
    timestamp?: string;
  }) => {
    // Extract email from distinct_id or $set
    const email = (
      payload.properties?.$set?.email ||
      (payload.distinct_id?.includes("@") ? payload.distinct_id : null)
    )?.toLowerCase().trim();

    if (!email || email === "anonymous" || !email.includes("@")) {
      console.log("[posthog-identify] No valid email, skipping");
      return { action: "skipped", reason: "no_email" };
    }

    // Look up existing contact
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, signal_type, hubspot_contact_id, tier, domain")
      .eq("email", email)
      .limit(1)
      .single();

    if (contact && contact.signal_type === "Company Intent") {
      // Upgrade signal type
      await supabase.from("contacts").update({
        signal_type: "Identified Visitor",
      }).eq("id", contact.id);

      if (contact.hubspot_contact_id && isHubSpotPushEnabled()) {
        try {
          await updateHubSpotContact({
            hubspot_contact_id: contact.hubspot_contact_id,
            signal_type: "Identified Visitor",
          });
        } catch (err) {
          console.error(`[posthog-identify] HubSpot update failed for ${email}:`, err);
        }
      }

      console.log(`[posthog-identify] ${email}: Company Intent → Identified Visitor`);
      return { action: "upgraded", email, contact_id: contact.id };
    }

    if (contact) {
      console.log(`[posthog-identify] ${email}: already ${contact.signal_type}, skipping`);
      return { action: "skipped", reason: "already_typed", signal_type: contact.signal_type };
    }

    // Contact doesn't exist — extract domain and insert raw signal
    let domain: string | null = null;
    const currentUrl = payload.properties?.$current_url;
    if (currentUrl) {
      try {
        domain = new URL(currentUrl).hostname.replace(/^www\./, "");
      } catch {}
    }
    // Fall back to email domain
    if (!domain) {
      domain = email.split("@")[1] || null;
    }

    if (!domain) {
      console.log(`[posthog-identify] ${email}: no domain, skipping`);
      return { action: "skipped", reason: "no_domain" };
    }

    const { data: rawSignal } = await supabase
      .from("raw_signals")
      .insert({
        source: "posthog_identify",
        // lead_source MUST match source — downstream code (gates.ts, deriveLeadOrigin)
        // checks lead_source to bypass certain checks and derive the human label.
        // Without this, posthog signals fall through to "V2 Enriched" placeholder.
        // Same class of bug as deal-sync.ts was Apr 8.
        lead_source: "posthog_identify",
        domain,
        email,
        contact_name: payload.properties?.$set?.name || null,
        raw_payload: payload,
        status: "pending",
        utm_channel: payload.properties?.utm_source ? "Paid" : null,
      })
      .select("id")
      .single();

    if (rawSignal) {
      const { normalize } = await import("./normalize.js");
      await normalize.trigger({ raw_signal_id: rawSignal.id });
    }

    console.log(`[posthog-identify] ${email}: new contact, raw_signal inserted → normalize`);
    return { action: "new_contact", email, domain };
  },
});
