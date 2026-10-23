// Validation gates — replaces Clay conditional run formulas
// Source: Clay Normalization + Company Profiles + Contact Profiles conditional runs

import { ENTERPRISE_BLOCKLIST, INTERNAL_DOMAINS, TITLE_BLOCKLIST_PATTERNS, TITLE_BLOCKLIST_ACRONYMS } from "./blocklists.js";
import { supabase } from "./supabase.js";

// ============================================================
// NORMALIZATION GATES (from Normalization table)
// ============================================================

// Domain validation — matches Clay f_0taomn7rNosDBmYdCe5
// Uses INTERNAL_DOMAINS set so any internal/partner domain is blocked at the
// earliest gate. Prior version hardcoded "acmegtm.com" only, which meant
// starbridge.ai / digital-made.com / octave.is / fuzemee.com were in the
// internal set but never actually blocked at validation time.
export function validateDomain(domain: string | null | undefined): { valid: boolean; reason?: string } {
  if (!domain || domain.trim() === "") return { valid: false, reason: "empty_domain" };

  const d = domain.toLowerCase();

  if (INTERNAL_DOMAINS.has(d)) return { valid: false, reason: "internal" };
  if (d.endsWith(".edu")) return { valid: false, reason: "edu_domain" };
  if (d.endsWith(".gov")) return { valid: false, reason: "gov_domain" };
  if (d.includes(".k12.")) return { valid: false, reason: "k12_domain" };

  return { valid: true };
}

// Clean domain — matches Clay f_0taomn6Ge36T3Y3zvY2
export function cleanDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .replace(/\/+$/, "")
    .split("?")[0]
    .split("#")[0];
}

// Clean email — handles Syft's literal "null" string
// Matches Clay f_0taromuENhP4QN3EFd4
export function cleanEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  const lower = (raw + "").trim().toLowerCase();
  if (lower === "null") return "";
  return lower;
}

// Validation gate — passes domain validation + has page views OR linkedin action
// Matches Clay f_0taomort8MaCe5Bzu8m
export function passesValidationGate(data: {
  domain: string;
  page_views?: number;
  linkedin_action?: string;
  lead_source?: string;
}): boolean {
  const domainCheck = validateDomain(data.domain);
  if (!domainCheck.valid) return false;

  // Deal-created signals bypass engagement check — they come from HubSpot, not Syft
  if (data.lead_source === "hubspot_deal_created") return true;

  // Must have page views > 0 OR a LinkedIn action
  const hasPageViews = (data.page_views || 0) > 0;
  const hasLinkedInAction = !!(data.linkedin_action && data.linkedin_action.trim() !== "");

  return hasPageViews || hasLinkedInAction;
}

// Enterprise domain check — matches Clay Company Info conditional run
export function isEnterpriseDomain(domain: string): boolean {
  return ENTERPRISE_BLOCKLIST.has(domain.toLowerCase());
}

// Domain blocklist check (async — queries Supabase)
// Matches Clay Blocklist Lookup f_0tbhdo3x3ydidW5Rkmu
export async function isDomainBlocked(domain: string): Promise<boolean> {
  const { data } = await supabase
    .from("domain_blocklist")
    .select("domain")
    .eq("domain", domain.toLowerCase())
    .limit(1);

  return !!(data && data.length > 0);
}

// Customer gate — checks HubSpot lifecycle stage
// Matches Clay f_0tb1px2qhsY6Buz8BoN
// Deal-created rows bypass this gate
export function isNotCustomer(
  lifecycle: string | null | undefined,
  isBlocked: boolean,
  leadSource?: string,
): boolean {
  // Deal-created rows always pass
  if (leadSource === "hubspot_deal_created") return true;

  // Must not be on blocklist
  if (isBlocked) return false;

  // Must not be existing customer or opportunity
  if (!lifecycle) return true;
  return lifecycle !== "customer" && lifecycle !== "opportunity";
}

// ============================================================
// COMPANY PROFILES GATES (from Company Profiles conditional runs)
// ============================================================

// Sub-Market gate — blocks downstream enrichments for Not B2B / Other B2B / empty
// Matches Clay conditional run on Sales Team, Sales Hiring, Outbound Need, Sales Org Summary
export function passesSubMarketGate(subMarket: string | null | undefined): boolean {
  if (!subMarket || subMarket === "") return false;
  return subMarket !== "Not B2B" && subMarket !== "Other B2B";
}

// SLED sub_markets — the only verticals ACME sells to and pushes to HubSpot.
// K12, Higher Ed, Government. Healthcare, Financial Services, etc. stay in Supabase only.
// Single canonical set — used by push gates AND alert gates.
const SLED_SUB_MARKETS = new Set([
  "K12 EdTech SaaS",
  "K-12 EdTech SaaS",
  "Higher Ed",
  "Higher Ed SaaS",
  "Government & Public Sector",
  "Government",
  "Gov",
]);

export function isSledSubMarket(subMarket: string | null | undefined): boolean {
  if (!subMarket) return false;
  return SLED_SUB_MARKETS.has(subMarket);
}

const SLED_PUSH_MARKETS = SLED_SUB_MARKETS;

// Company push gate — matches Clay Push to HubSpot conditional run on f_0taxyt9FUM2gYNyqrkF
// Apr 16: Added SLED gate — only K12/Higher Ed/Government companies push to HubSpot
export type GateResult = { passes: boolean; reason?: string };

export function passesCompanyPushGateWithReason(data: {
  domain: string;
  sub_market: string | null;
  icp_score: number;
  vertical_fit_score: number;
  employee_count: number | null;
  lead_source?: string;
}): GateResult {
  if (data.lead_source === "hubspot_deal_created") return { passes: true };
  if (data.lead_source === "syft_linkedin") return { passes: false, reason: "linkedin_signal" };

  const domainCheck = validateDomain(data.domain);
  if (!domainCheck.valid) return { passes: false, reason: `invalid_domain:${domainCheck.reason}` };

  if (isEnterpriseDomain(data.domain)) return { passes: false, reason: "enterprise_domain" };

  if (!data.sub_market || data.sub_market === "") return { passes: false, reason: "no_sub_market" };
  if (data.sub_market === "Not B2B" || data.sub_market === "Other B2B") return { passes: false, reason: "non_b2b" };

  if (!SLED_PUSH_MARKETS.has(data.sub_market)) return { passes: false, reason: `not_sled:${data.sub_market}` };

  if (data.icp_score < 50) return { passes: false, reason: `icp_below_50:${data.icp_score}` };
  if (data.vertical_fit_score <= 0) return { passes: false, reason: "no_vertical_fit" };
  if (data.employee_count && data.employee_count >= 500) return { passes: false, reason: `too_large:${data.employee_count}` };

  return { passes: true };
}

export function passesCompanyPushGate(data: Parameters<typeof passesCompanyPushGateWithReason>[0]): boolean {
  return passesCompanyPushGateWithReason(data).passes;
}

// Contact discovery gate — ICP >= 50 + Vertical Fit > 0 + < 500 employees
// Lowered from 60 to 50 on Apr 10 to cover full TAM range (RepB's Higher Ed ICP 50-59 band)
// Matches Clay Find Decision Maker conditional run on f_0tayvafRuDzZ24FrFdH
export function passesContactDiscoveryGate(data: {
  icp_score: number;
  vertical_fit_score: number;
  employee_count: number | null;
  has_sales_team?: boolean;  // From sales_team_data — false = 0 AEs + 0 SDRs + no hiring
}): boolean {
  if (data.icp_score < 50) return false;
  if (data.vertical_fit_score <= 0) return false;
  if (data.employee_count && data.employee_count >= 500) return false;
  // Skip discovery for companies with no sales org — ACME can't sell SDR
  // outsourcing where there's no sales function to augment. Saves Cargo credits.
  if (data.has_sales_team === false) return false;
  return true;
}

// ============================================================
// CONTACT PROFILES GATES (from Contact Profiles conditional runs)
// Inlined Mar 10 — no more Route To intermediate formula
// ============================================================

// Title blocklist — matches Clay IIFE in Push to HubSpot conditional
export function isTitleBlocked(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return TITLE_BLOCKLIST_PATTERNS.some((pattern) => t.includes(pattern))
    || TITLE_BLOCKLIST_ACRONYMS.some((re) => re.test(t));
}

// Decision maker title check — used in contact discovery to prioritize
const DECISION_MAKER_PATTERNS = [
  /\bceo\b/i, /\bcto\b/i, /\bcfo\b/i, /\bcoo\b/i, /\bcro\b/i, /\bcmo\b/i, /\bcio\b/i,
  /\bchief\b/i,
  /\bfounder\b/i,
  /\bpresident\b/i,
  /\bowner\b/i,
  /\bvp\b/i, /vice president/i,
  /\bdirector\b/i,
  /\bhead of\b/i,
  /general manager/i,
  /superintendent/i,
  /\bprincipal\b/i,
];

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return DECISION_MAKER_PATTERNS.some((pattern) => pattern.test(title));
}

// MQL Buyer Title Allowlist — Apr 15
// ACME sells SDR services. Buyers are executives who own revenue or sales function.
// This is an ALLOWLIST — only these titles qualify for MQL.
const MQL_BUYER_PATTERNS = [
  // Executive leadership (owns company revenue)
  /\bceo\b/i,
  /\bcoo\b/i,
  /\bcro\b/i,
  /chief executive/i,
  /chief operating/i,
  /chief revenue/i,
  /\bfounder\b/i,
  /co-founder/i,
  /\bpresident\b/i,
  /\bowner\b/i,
  // Sales leadership (owns sales function)
  /vp.{0,5}sales/i,
  /vice president.{0,5}sales/i,
  /head of sales/i,
  /sales.{0,5}director/i,
  /director.{0,5}sales/i,
  /chief sales/i,
  /svp.{0,5}sales/i,
  /evp.{0,5}sales/i,
  // General manager (often owns P&L including sales)
  /general manager/i,
  /\bgm\b/i,
  // Managing Director (common in some industries)
  /managing director/i,
];

export function isMqlBuyerTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return MQL_BUYER_PATTERNS.some((pattern) => pattern.test(title));
}

// Internal domain check for contacts
export function isInternalDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return INTERNAL_DOMAINS.has(domain.toLowerCase());
}

// Contact push gate — matches Clay Push to HubSpot (f_0taxx5sqGD8Rm6B7ixb) inlined conditional
// Requires: has email + no existing HubSpot contact + not internal domain + not blocked title
//   + ICP >= 50 + SLED sub_market + US/CA + (Hot/Warm OR company_discovery)
export function passesContactPushGateWithReason(data: {
  email: string | null;
  has_existing_hubspot_contact: boolean;
  domain: string | null;
  title: string | null;
  icp_score: number;
  lead_tier: string | null;
  lead_source: string | null;
  vertical_fit_score: number;
  sub_market?: string | null;
  country?: string | null;
}): GateResult {
  if (!data.email || data.email.trim() === "") return { passes: false, reason: "no_email" };
  if (data.lead_source === "syft_linkedin") return { passes: false, reason: "linkedin_signal" };
  if (data.has_existing_hubspot_contact) return { passes: false, reason: "already_in_hubspot" };
  if (isInternalDomain(data.domain)) return { passes: false, reason: "internal_domain" };
  if (isTitleBlocked(data.title)) return { passes: false, reason: `title_blocked:${data.title}` };
  if (data.icp_score < 50) return { passes: false, reason: `icp_below_50:${data.icp_score}` };
  if (!isSledSubMarket(data.sub_market)) return { passes: false, reason: `not_sled:${data.sub_market}` };

  if (data.country) {
    const validCountries = ["US", "USA", "United States", "CA", "Canada"];
    if (!validCountries.includes(data.country)) return { passes: false, reason: `geo_blocked:${data.country}` };
  }

  if (data.lead_tier === "Hot" || data.lead_tier === "hot" ||
      data.lead_tier === "Warm" || data.lead_tier === "warm") {
    return { passes: true };
  }

  if (data.lead_source === "company_discovery" && data.vertical_fit_score > 0) {
    return { passes: true };
  }

  if (data.lead_source === "tam_import") {
    return { passes: true };
  }

  return { passes: false, reason: `tier_too_low:${data.lead_tier}` };
}

export function passesContactPushGate(data: Parameters<typeof passesContactPushGateWithReason>[0]): boolean {
  return passesContactPushGateWithReason(data).passes;
}

// Contact update gate — matches Clay Update HubSpot Contact (f_0tbawowRtkqYdqMEXyx) inlined conditional
// Same as push gate but requires HubSpot Contact ID instead of "no existing contact"
// Also fires on needs_refresh
export function passesContactUpdateGate(data: {
  hubspot_contact_id: string | null;
  domain: string | null;
  title: string | null;
  icp_score: number;
  lead_tier: string | null;
  lead_source: string | null;
  vertical_fit_score: number;
  needs_refresh: boolean;
}): boolean {
  // Must have HubSpot Contact ID
  if (!data.hubspot_contact_id || data.hubspot_contact_id.trim() === "") return false;

  // Needs refresh path — always fire if has ID
  if (data.needs_refresh) return true;

  // Same gates as push (minus email/existing check)
  if (isInternalDomain(data.domain)) return false;
  if (isTitleBlocked(data.title)) return false;
  if (data.icp_score < 50) return false;

  if (data.lead_tier === "Hot" || data.lead_tier === "hot" ||
      data.lead_tier === "Warm" || data.lead_tier === "warm") {
    return true;
  }

  if (data.lead_source === "company_discovery" && data.vertical_fit_score > 0) {
    return true;
  }

  return false;
}

// MQL Gate — Apr 15
// MQL = inbound + hot/warm + buyer title (allowlist) + SLED
// This is the gate for Slack alerts and priority routing.
export function isMql(data: {
  lead_type: string | null;
  lead_tier: string | null;
  title: string | null;
  sub_market?: string | null;
}): boolean {
  // Must be inbound
  if (data.lead_type !== "inbound") return false;

  // Must be hot or warm
  const tier = (data.lead_tier || "").toLowerCase();
  if (tier !== "hot" && tier !== "warm") return false;

  // Must have buyer title (allowlist)
  if (!isMqlBuyerTitle(data.title)) return false;

  // Must be SLED (if sub_market provided)
  if (data.sub_market && !isSledSubMarket(data.sub_market)) return false;

  return true;
}
