import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { cleanDomain, cleanEmail } from "../lib/gates.js";

// Syft Poller — runs every 30 min
//
// Polls Syft REST API for recent accounts, dedupes against raw_signals,
// inserts new ones, and triggers normalize for each.
//
// This is the V2 intake path while Syft motions still point at Clay.
// Replaces the need to change Syft webhook URLs.
//
// Syft REST API: POST /api/accounts/search (cookie auth)

/** Capitalize first letter of each word — fixes LeadMagic/Syft lowercase names */
function capitalize(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

const SYFT_BASE = "https://app.syftdata.com";
const SYFT_SOURCE_ID = "cmb5aiva4000ajo0aguxv0l69";

// Enterprise blocklist (matches gates.ts)
const ENTERPRISE_BLOCKLIST = new Set([
  "google.com", "microsoft.com", "apple.com", "amazon.com", "meta.com",
  "facebook.com", "linkedin.com", "twitter.com", "x.com", "salesforce.com",
  "oracle.com", "ibm.com", "adobe.com", "splunk.com", "cisco.com",
  "vmware.com", "dell.com", "hp.com", "intel.com", "nvidia.com",
  "samsung.com", "bmw.com", "mercedes-benz.com", "toyota.com", "ford.com",
  "walmart.com", "target.com", "costco.com", "homedepot.com",
  "upwork.com", "fiverr.com", "freelancer.com",
  "github.com", "gitlab.com", "atlassian.com", "slack.com", "zoom.us",
  "hubspot.com", "mailchimp.com", "stripe.com", "shopify.com",
  "genesys.com", "pitchbook.com", "grafana.com", "iterable.com",
  "accenture.com", "netsuite.com", "extrahop.com", "classpass.com",
]);

const INTERNAL_DOMAINS = new Set([
  "digital-made.com", "starbridge.ai", "syftdata.com", "octave.club",
  "trigger.dev", "supabase.com", "posthog.com", "octavehq.com",
  "emailbison.com", "acmegtm.com", "rhosales.com",
]);

function isJunkDomain(d: string): boolean {
  if (!d) return true;
  if (d.endsWith(".edu") || d.endsWith(".gov") || d.includes(".k12.")) return true;
  if (ENTERPRISE_BLOCKLIST.has(d)) return true;
  if (INTERNAL_DOMAINS.has(d)) return true;
  if (["gmail.com", "yahoo.com", "outlook.com", "hotmail.com"].includes(d)) return true;
  return false;
}

async function pullSyftAccounts(cookie: string, lastDays: number): Promise<any[]> {
  const accounts: any[] = [];
  let page = 0;

  while (page < 20) {
    const res = await fetch(`${SYFT_BASE}/api/accounts/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        sourceId: SYFT_SOURCE_ID,
        filters: {
          filters: [],
          contactFilters: [],
          lastDays,
          pagination: { pageSize: 100, pageIndex: page },
          sorting: { lastSeen: "desc" },
          viewVisitors: "identified_or_suggested",
        },
        linkedinSyncImpressionsOnlySessions: false,
      }),
    });

    if (!res.ok) {
      console.error(`[syft-poll] API error ${res.status}: ${(await res.text()).substring(0, 200)}`);
      break;
    }

    const data = await res.json();
    const companies = data.companies || [];
    if (!companies.length) break;

    accounts.push(...companies);
    console.log(`[syft-poll] Page ${page}: ${companies.length} accounts (total: ${accounts.length})`);

    if (!data.pagination?.hasMore) break;
    page++;
  }

  return accounts;
}

function mapToRawSignal(account: any): Record<string, any> {
  const props = account.properties || {};
  const domain = cleanDomain(account.domain || "");

  // Determine source
  const pageViews = account.pageViews || 0;
  const hasLinkedIn = (account.nLiVisitors || 0) > 0;
  const source = pageViews === 0 && hasLinkedIn ? "syft_linkedin" : "syft_website";

  // First contact — Syft nests contact data in contacts[] and lastSeenVisitorDetail
  // Fallback: account.lead is a separate top-level object (populated when contacts[] is empty)
  const contacts = account.contacts || [];
  const lead = contacts[0] || {};
  const leadProps = lead.properties || {};
  const leadGeo = leadProps.geo || {};
  const lastSeen = account.lastSeenVisitorDetail || {};
  const accountLead = account.lead || {};

  // Attribution
  const touchChannels = account.touchChannels || [];
  const touchMediums = account.touchMediums || [];
  const touchCampaigns = account.touchCampaigns || [];
  const utmSources = account.utmSources || [];
  const referrersList = account.referrers || [];
  const matchedIntents = account.matchedIntents || [];
  const matchedICPs = account.matchedICPs || [];
  const pagesViewed = account.pagesViewed || [];

  return {
    source,
    raw_payload: account,
    domain,
    domain_raw: account.domain || "",
    email: lead.email && lead.email !== "null" ? cleanEmail(lead.email) : accountLead.email && accountLead.email !== "null" ? cleanEmail(accountLead.email) : null,
    first_name: capitalize(lead.name?.split(" ")[0] || leadProps.name?.split(" ")[0] || accountLead.firstName || accountLead.name?.split(" ")[0] || null),
    last_name: capitalize(lead.name?.split(" ").slice(1).join(" ") || leadProps.name?.split(" ").slice(1).join(" ") || accountLead.lastName || accountLead.name?.split(" ").slice(1).join(" ") || null),
    contact_name: lead.name || leadProps.name || accountLead.fullName || accountLead.name || null,
    company_name: account.name || null,
    title: lastSeen.title || leadProps.title || accountLead.title || accountLead.jobTitle || null,
    linkedin_url: (() => {
      const raw = lead.linkedin || leadProps.linkedin || accountLead.linkedin || null;
      if (!raw) return null;
      return raw.startsWith("http") ? raw : `https://linkedin.com/${raw}`;
    })(),
    company_linkedin_url: props.linkedin ? `https://linkedin.com/${props.linkedin}` : null,
    employees: String(props.employees || account.employees || account.size || ""),
    industry: props.industry || account.industry || null,
    city: leadGeo.city || account.city || props.address?.city || null,
    state: leadGeo.state || account.state || props.address?.state || null,
    country: leadGeo.country || account.country || props.address?.country || null,
    page_views: pageViews,
    sessions: account.nSiteSessions || account.nSessions || 0,
    active_time_seconds: account.timeSpent || 0,
    visitor_count: account.nSiteVisitors || account.nVisitors || 0,
    syft_purchase_intent: account.intent || null,
    syft_intent_level: account.intent || null,
    icp_match: matchedICPs.length ? matchedICPs.join(", ") : null,
    last_seen: account.lastSeen || null,
    linkedin_action: (lead.liLikes || 0) > 0 || (lead.liNewConnections || 0) > 0 || (lead.liShares || 0) > 0
      ? [
          (lead.liLikes || 0) > 0 ? "liked_post" : null,
          (lead.liNewConnections || 0) > 0 ? "connected" : null,
          (lead.liShares || 0) > 0 ? "shared_post" : null,
        ].filter(Boolean).join(", ")
      : null,
    utm_channel: touchChannels[0] || null,
    utm_sources: utmSources.length ? utmSources.join(", ") : null,
    utm_medium: touchMediums.length ? touchMediums.join(", ") : null,
    first_touch_source: account.firstTouchSource || null,
    touch_channels: touchChannels.length ? touchChannels.join(", ") : null,
    touch_campaigns: touchCampaigns.length ? touchCampaigns.join(", ") : null,
    referrers: referrersList.length ? referrersList.join(", ") : null,
    latest_source: touchChannels.length ? touchChannels[touchChannels.length - 1] : null,
    matched_intents: matchedIntents.length ? matchedIntents.join(", ") : null,
    high_intent_sessions: account.highIntentSessions || 0,
    session_pages_visited: null,
    pages_viewed: pagesViewed.length ? pagesViewed.slice(0, 20).join(", ") : null,
    lead_personas: null,
    lead_source: source,
  };
}

export const syftPoll = schedules.task({
  id: "syft-poll",
  cron: "*/30 * * * *", // Every 30 minutes
  maxDuration: 120,
  run: async () => {
    const cookie = process.env.SYFT_COOKIE;
    if (!cookie) {
      console.error("[syft-poll] SYFT_COOKIE not set");
      return { error: "SYFT_COOKIE not configured" };
    }

    // Pull last 2 days to catch anything missed
    console.log("[syft-poll] Pulling Syft accounts (last 2 days)...");
    const accounts = await pullSyftAccounts(cookie, 2);
    console.log(`[syft-poll] Got ${accounts.length} accounts from Syft`);

    // Filter junk domains and too-large companies
    const valid = accounts.filter((a) => {
      const domain = (a.domain || "").toLowerCase();
      if (isJunkDomain(domain)) return false;
      const emp = a.properties?.employees || 0;
      if (typeof emp === "number" && emp >= 500) return false;
      // Must have some engagement
      const pv = a.pageViews || 0;
      const li = (a.nLiVisitors || 0) + (a.liTotalEngagements || 0);
      if (pv === 0 && li === 0) return false;
      return true;
    });
    console.log(`[syft-poll] ${valid.length} pass filter (${accounts.length - valid.length} rejected)`);

    // Dedup by domain
    const seen = new Set<string>();
    const deduped = valid.filter((a) => {
      const d = a.domain.toLowerCase();
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });

    // Check which domains already exist in raw_signals (last 3 days)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: existingSignals } = await supabase
      .from("raw_signals")
      .select("domain")
      .gte("created_at", threeDaysAgo);

    const existingDomains = new Set((existingSignals || []).map((s) => s.domain));
    const newAccounts = deduped.filter((a) => !existingDomains.has(a.domain.toLowerCase()));
    console.log(`[syft-poll] ${newAccounts.length} new domains (${deduped.length - newAccounts.length} already in Supabase)`);

    if (newAccounts.length === 0) {
      return { pulled: accounts.length, filtered: valid.length, new: 0, inserted: 0 };
    }

    // Cap: skip domains with >10 signals in last 7 days (prevents burst bloat)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const newDomainList = newAccounts.map(a => a.domain.toLowerCase());
    const { data: heavyDomains } = await supabase
      .from("signals")
      .select("domain")
      .gte("created_at", sevenDaysAgo)
      .in("domain", newDomainList);

    const domainSignalCounts = new Map<string, number>();
    for (const s of heavyDomains || []) {
      domainSignalCounts.set(s.domain, (domainSignalCounts.get(s.domain) || 0) + 1);
    }

    const cappedAccounts = newAccounts.filter(a => {
      const count = domainSignalCounts.get(a.domain.toLowerCase()) || 0;
      if (count > 10) {
        console.log(`[syft-poll] Skipping ${a.domain} — ${count} signals in 7d (cap: 10)`);
        return false;
      }
      return true;
    });

    if (cappedAccounts.length === 0) {
      return { pulled: accounts.length, filtered: valid.length, new: 0, inserted: 0, capped: newAccounts.length - cappedAccounts.length };
    }

    // Map and insert
    const rows = cappedAccounts.map(mapToRawSignal);
    let insertedCount = 0;

    // Insert in batches of 25
    for (let i = 0; i < rows.length; i += 25) {
      const batch = rows.slice(i, i + 25);
      const { data: inserted, error } = await supabase
        .from("raw_signals")
        .insert(batch)
        .select("id, domain");

      if (error) {
        console.error(`[syft-poll] Insert batch error:`, error);
        continue;
      }

      insertedCount += (inserted || []).length;

      // Trigger normalize for each
      const { normalize } = await import("./normalize.js");
      for (const row of inserted || []) {
        await normalize.trigger({ raw_signal_id: row.id });
        console.log(`[syft-poll] Triggered normalize for ${row.domain} (${row.id})`);
      }
    }

    console.log(`[syft-poll] Done: ${insertedCount} new signals inserted and triggered`);
    return {
      pulled: accounts.length,
      filtered: valid.length,
      deduped: deduped.length,
      new: newAccounts.length,
      capped: newAccounts.length - cappedAccounts.length,
      inserted: insertedCount,
    };
  },
});
