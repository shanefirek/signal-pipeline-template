// System constants — single source of truth

// Canonical AE owner names — used as ae_owner values in Supabase.
// NEVER store HubSpot numeric IDs in ae_owner; use this type + AE_OWNERS lookup at push time.
export type AeOwnerName = "rep_a" | "rep_b";

// AE owner HubSpot IDs — used by TAM activate to set owner on push
// Source: HubSpot owners API (scripts/list-owners.mts)
export const AE_OWNERS: Record<string, string> = {
  rep_c: "160713153",
  rep_a: "162280197",
  rep_b: "163458119",
  shane: "162113539",
  emily: "161686689",
  trevor: "161220166",
  cara: "161219000",
  rose: "160659293",
  nick: "87494953",
};


// Lead origin derivation — maps technical lead_source to human-readable HubSpot value.
// Supabase stores lead_source (machine key). HubSpot gets lead_origin (human label).
// No more hardcoded LEAD_ORIGIN constant — derived at push time from lead_source.
//
// Old "Clay" records in HubSpot stay as-is. New records get the mapped value.
export function deriveLeadOrigin(leadSource: string | null | undefined): string {
  switch (leadSource) {
    case "syft_website":
      return "Website Visitor";
    case "syft_linkedin":
      return "LinkedIn Engagement";
    case "tam_import":
      return "TAM Outbound";
    case "salesnav_import":
      return "Sales Nav";
    case "starbridge_referral":
      return "Starbridge Referral";
    case "hubspot_backfill":
      return "HubSpot Backfill";
    case "hubspot_deal_created":
      return "Deal Created";
    case "company_discovery":
      return "Company Discovery";
    case "fibbler_engagement":
      return "LinkedIn Ad Engagement";
    case "departed_follow":
      return "Departed Follow";
    case "departed_backfill":
      return "Departed Backfill";
    default:
      return "V2 Enriched";
  }
}

// Signal type derivation — returns the signal_type for signal-driven sources,
// or null when the source isn't signal-driven (TAM outbound, HubSpot backfill,
// unknown sources). NEVER return "Unknown" as a placeholder — that's a lie
// that destroys AE attribution. `lead_origin` carries the "where did this
// come from" story for non-signal sources.
//
// See: memory/feedback_mql_tam_distinction.md — MQL = demonstrated intent,
// TAM = ICP-fit outbound. These are distinct data contracts.
export function getSignalType(leadSource: string | null | undefined): string | null {
  switch (leadSource) {
    case "syft_website":
      return "Company Intent";
    case "syft_linkedin":
      return "LinkedIn Engagement";
    case "hubspot_deal_created":
      return "Deal Created";
    case "company_discovery":
      return "Company Intent";
    case "fibbler_engagement":
      return "LinkedIn Engagement";
    // Non-signal sources — no signal_type should be written. Attribution
    // lives in lead_origin via deriveLeadOrigin().
    case "tam_import":
      return null;
    case "hubspot_backfill":
      return null;
    default:
      return null;
  }
}

// Lead type derivation — classifies how the lead was qualified.
// Separates MQL workflows (inbound) from TAM workflows (outbound).
//
// - inbound: they came to us (signal-driven)
// - outbound: we reached out to them (TAM list)
// - referral: third-party introduction (Sales Nav, Starbridge)
//
// Note: A lead can be outbound AND later show intent. Use has_intent_signal
// to track "outbound contact who showed interest" — both are true.
export function deriveLeadType(leadSource: string | null | undefined): "inbound" | "outbound" | "referral" | "unknown" {
  const inbound = ["syft_website", "syft_linkedin", "fibbler_engagement", "company_discovery", "posthog_identify"];
  const outbound = ["tam_import", "departed_follow", "departed_backfill"];
  const referral = ["salesnav_import", "starbridge_referral"];

  if (inbound.includes(leadSource || "")) return "inbound";
  if (outbound.includes(leadSource || "")) return "outbound";
  if (referral.includes(leadSource || "")) return "referral";
  return "unknown";
}

// AE owner derivation — routes leads by territory based on sub_market.
// Used by enrich-contact to set hubspot_owner_id before push.
//
// Territories:
// - RepA: K12 EdTech
// - RepB: Higher Ed + Government & Public Sector
//
// Uses exact matching against canonical SUB_MARKETS enum values from sub-market-classifier.ts
// to avoid false positives from substring matching (e.g., "Local Business SaaS" matching "local").
//
// Returns null for non-SLED or unknown sub_market — HubSpot Auto-Assign handles those.
export function deriveAeOwner(subMarket: string | null | undefined): "rep_a" | "rep_b" | null {
  if (!subMarket) return null;

  // Canonical values from SUB_MARKETS enum (exact match)
  // RepA: K12
  if (subMarket === "K12 EdTech SaaS") return "rep_a";

  // RepB: Higher Ed + Government
  if (subMarket === "Higher Ed") return "rep_b";
  if (subMarket === "Government & Public Sector") return "rep_b";

  // Fallback: loose matching for legacy/ad-hoc values
  const sm = subMarket.toLowerCase();
  if (sm.includes("k12") || sm.includes("k-12")) return "rep_a";
  if (sm.includes("higher ed") || sm.includes("public sector") || sm.includes("government")) return "rep_b";

  // Default: null (no auto-assign, HubSpot workflow decides)
  return null;
}

// MQL determination — GTMOS owns this, not HubSpot workflows.
//
// MQL = inbound Syft signal + qualified tier + actual intent activity.
// ICP fit alone is not enough — the company must have demonstrated intent
// (page views, sessions, or LinkedIn engagement scored by score-intent.ts).
//
// This function is called in enrich-contact.ts after scoring.
// If true: set is_mql=true, mql_at=now(), push lifecyclestage=marketingqualifiedlead,
// fire Slack alert.
export function isMQL(
  leadSource: string | null | undefined,
  tier: string | null | undefined,
  intentScore: number | null | undefined
): boolean {
  // Must be inbound (signal-driven: syft_website, syft_linkedin, company_discovery)
  const leadType = deriveLeadType(leadSource);
  if (leadType !== "inbound") return false;

  // Must be hot or warm tier
  if (tier !== "hot" && tier !== "warm") return false;

  // Must have actual signal activity (intent_score > 0 means Syft scored real engagement)
  if (!intentScore || intentScore <= 0) return false;

  return true;
}

// HubSpot lifecycle stage for MQLs
export const MQL_LIFECYCLE_STAGE = "marketingqualifiedlead";
