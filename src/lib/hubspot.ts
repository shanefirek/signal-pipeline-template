import { Client } from "@hubspot/api-client";
import { deriveLeadOrigin, deriveLeadType } from "./constants.js";
import { toHubSpotFundingStage } from "./funding.js";

// HubSpot push layer — matches exact Clay property mappings
// Source: Clay Company Profiles Push to HubSpot (f_0taxyt9FUM2gYNyqrkF)
//         Clay Contact Profiles Push to HubSpot (f_0taxx5sqGD8Rm6B7ixb)
//         Clay Contact Profiles Update HubSpot Contact (f_0tbawowRtkqYdqMEXyx)

const hubspot = new Client({ accessToken: process.env.HUBSPOT_API_KEY });

/** Convert any date-like value to HubSpot date format (midnight UTC epoch ms). */
export function toHubSpotDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (isNaN(d.getTime())) return undefined;
  d.setUTCHours(0, 0, 0, 0);
  return String(d.getTime());
}

export { hubspot };

/** Map tam_tier / icp_score to the HubSpot icp_tier enum value. */
export function toIcpTierValue(tamTier: string | null | undefined, icpScore: number | null | undefined): string {
  if (tamTier === "T1" || (icpScore != null && icpScore >= 86)) return "priority";
  if (tamTier === "T2" || (icpScore != null && icpScore >= 57)) return "strong_fit";
  if (tamTier === "T3" || (icpScore != null && icpScore >= 36)) return "high_potential";
  return "review";
}

// Gate all HubSpot writes behind env flag. Default OFF for safety.
// Re-enabled Apr 10 2026 after scoring audit + title blocklist fix.
// Kill switch was engaged Apr 8 after Lilly Santiago (EA @ BrainPOP) auto-pushed.
// Fix: "executive assistant" added to title blocklist.
export function isHubSpotPushEnabled(): boolean {
  return process.env.HUBSPOT_PUSH_ENABLED === "true";
}

// ============================================================
// COMPANY PUSH — matches Clay f_0taxyt9FUM2gYNyqrkF exactly
// Uses create-update-company action (creates if new, updates if exists by domain)
// ============================================================

export interface CompanyPushData {
  domain: string;
  name?: string;
  linkedin_company_page?: string;
  employee_count?: number;
  sub_market?: string;
  icp_score?: number;
  intent_score?: number;     // G12 fix: was missing entirely
  lead_tier?: string;        // G12 fix: was missing entirely
  lead_temp?: string;        // "Hot", "Warm", "Cold"
  lead_origin?: string;
  total_score?: number;
  first_touch_source?: string;
  touch_channels?: string;
  touch_campaigns?: string;
  syft_intent?: string;      // "very high" → "high" mapping
  matched_intents?: string;
  utm_medium?: string;
  latest_source?: string;
  lead_summary?: string;
  sales_org_summary?: string;
  description?: string;
  city?: string;
  state?: string;
  country?: string;
  // Funding/revenue — RepB's schema gap ask (Apr 10)
  funding_stage?: string;
  annualrevenue?: number;
  total_money_raised?: string;
  // ICP tier dropdown (Priority / Strong Fit / High Potential / Review)
  icp_tier?: string;
}

export async function pushCompanyToHubSpot(data: CompanyPushData): Promise<{
  action: "created" | "updated";
  id: string;
}> {
  // Global blocklist — no HubSpot pushes for blocked domains
  const { isDomainBlocked } = await import("./gates.js");
  if (await isDomainBlocked(data.domain)) {
    throw new Error(`Blocked domain: ${data.domain}`);
  }

  // Syft intent mapping: "very high" → "high" (matches Clay formula)
  const syftIntent = data.syft_intent
    ? (data.syft_intent.toLowerCase() === "very high" ? "high" : data.syft_intent.toLowerCase())
    : "";

  const properties: Record<string, string> = {
    domain: data.domain,
    ...(data.name && { name: data.name }),
    ...(data.linkedin_company_page && { linkedin_company_page: data.linkedin_company_page }),
    ...(data.employee_count != null && { numberofemployees: String(data.employee_count) }),
    ...(data.sub_market && { sub_market: data.sub_market }),
    ...(data.icp_score != null && { icp_score: String(data.icp_score) }),
    ...(data.intent_score != null && { intent_score: String(data.intent_score) }),
    ...(data.lead_tier && { lead_tier: data.lead_tier }),
    ...(data.lead_temp && { lead_temp: data.lead_temp }),
    ...(data.lead_origin && { lead_origin: data.lead_origin }),
    ...(data.total_score != null && { total_score: String(data.total_score) }),
    ...(data.first_touch_source && { first_touch_source: data.first_touch_source }),
    ...(data.touch_channels && { touch_channels: data.touch_channels }),
    ...(data.touch_campaigns && { touch_campaigns: data.touch_campaigns }),
    ...(syftIntent && { syft_intent: syftIntent }),
    ...(data.matched_intents && { matched_intents: data.matched_intents }),
    ...(data.utm_medium && { utm_medium: data.utm_medium }),
    ...(data.latest_source && { latest_source: data.latest_source }),
    ...(data.lead_summary && { lead_summary: data.lead_summary.replace(/"/g, "'") }),
    ...(data.sales_org_summary && { sales_org_summary: data.sales_org_summary.replace(/"/g, "'") }),
    ...(data.description && { description: data.description }),
    ...(data.city && { city: data.city }),
    ...(data.state && { state: data.state }),
    ...(data.country && { country: data.country }),
    // Funding/revenue — Segment 5b (mapped to HubSpot enums)
    ...(data.funding_stage && toHubSpotFundingStage(data.funding_stage) && { funding_stage: toHubSpotFundingStage(data.funding_stage) }),
    ...(data.annualrevenue != null && { annualrevenue: String(data.annualrevenue) }),
    ...(data.total_money_raised && { total_money_raised: data.total_money_raised }),
    ...(data.icp_tier && { icp_tier: data.icp_tier }),
  };

  // Search for existing company by domain
  const searchRes = await hubspot.crm.companies.searchApi.doSearch({
    filterGroups: [{
      filters: [{
        propertyName: "domain",
        operator: "EQ" as any,
        value: data.domain,
      }],
    }],
    properties: ["domain"],
    limit: 1,
  });

  if (searchRes.results.length > 0) {
    const existingId = searchRes.results[0].id;
    await hubspot.crm.companies.basicApi.update(existingId, { properties });
    return { action: "updated", id: existingId };
  } else {
    const created = await hubspot.crm.companies.basicApi.create({ properties, associations: [] });
    return { action: "created", id: created.id };
  }
}

// ============================================================
// CONTACT CREATE — matches Clay f_0taxx5sqGD8Rm6B7ixb exactly
// ============================================================

export interface ContactCreateData {
  email: string;
  first_name?: string;
  last_name?: string;
  jobtitle?: string;
  company?: string;             // Company NAME (not domain!) — from Company ICP Lookup
  hs_linkedin_url?: string;
  lead_tier?: string;           // "Cold" → empty string mapping
  lead_temp?: string;           // "Cool" → "Cold" mapping
  lead_origin?: string;         // Always "Clay"
  lead_type?: string;           // inbound / outbound / referral — separates MQL from TAM workflows
  clay_lead_source?: string;    // syft_website, syft_linkedin, company_discovery, etc.
  signal_type?: string;         // "Company Intent", "LinkedIn Engagement", "Deal Created"
  total_score?: number;
  icp_score?: number;
  intent_score?: number;
  lead_summary?: string;
  sales_org_summary?: string;
  sub_market?: string;
  city?: string;
  state?: string;
  first_touch_channel?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  phone?: string;
  // TAM activation fields — set owner + lifecycle directly on push
  hubspot_owner_id?: string;
  lifecyclestage?: string;
  // Signal attribution fields — structured data for HubSpot filtering/reporting
  // NOTE: Create these properties in HubSpot Settings > Properties first
  signal_date?: string;           // ISO date string → HubSpot date
  signal_pages_visited?: string;  // Comma-separated URLs
  signal_sessions?: number;       // Session count
  signal_time_on_site?: number;   // Seconds on site
  // ICP tier dropdown (Priority / Strong Fit / High Potential / Review)
  icp_tier?: string;
}

export async function createHubSpotContact(data: ContactCreateData): Promise<{
  action: "created";
  id: string;
}> {
  // Global blocklist — extract domain from email
  const emailDomain = data.email.split("@")[1];
  if (emailDomain) {
    const { isDomainBlocked } = await import("./gates.js");
    if (await isDomainBlocked(emailDomain)) {
      throw new Error(`Blocked domain: ${emailDomain}`);
    }
  }

  const properties: Record<string, string> = {
    email: data.email,
    ...(data.first_name && { firstname: data.first_name }),
    ...(data.last_name && { lastname: data.last_name }),
    ...(data.jobtitle && { jobtitle: data.jobtitle }),
    ...(data.company && { company: data.company.replace(/"/g, "'") }),
    ...(data.hs_linkedin_url && { hs_linkedin_url: data.hs_linkedin_url }),
    // lead_tier: "Cold" → empty string (Clay mapping). Skip entirely if not provided.
    ...(data.lead_tier != null && {
      lead_tier: data.lead_tier === "Cold" || data.lead_tier === "cold" ? "" : data.lead_tier,
    }),
    // lead_temp: "Cool" → "Cold" (Clay mapping). Skip entirely if not provided —
    // TAM contacts must NOT get lead_temp or they trigger MQL/nurture workflows.
    ...(data.lead_temp != null && {
      lead_temp: data.lead_temp === "Cool" || data.lead_temp === "cool" ? "Cold" : data.lead_temp,
    }),
    lead_origin: data.lead_origin || deriveLeadOrigin(data.clay_lead_source),
    lead_type: data.lead_type || deriveLeadType(data.clay_lead_source),
    ...(data.clay_lead_source && { clay_lead_source: data.clay_lead_source }),
    ...(data.signal_type && { signal_type: data.signal_type }),
    ...(data.total_score != null && { total_score: String(data.total_score) }),
    ...(data.icp_score != null && { icp_score: String(data.icp_score) }),
    ...(data.intent_score != null && { intent_score: String(data.intent_score) }),
    ...(data.lead_summary && { lead_summary: data.lead_summary.replace(/"/g, "'") }),
    ...(data.sales_org_summary && { sales_org_summary: data.sales_org_summary.replace(/"/g, "'") }),
    ...(data.sub_market && { sub_market: data.sub_market }),
    ...(data.city && { city: data.city }),
    ...(data.state && { state: data.state }),
    ...(data.first_touch_channel && { first_touch_channel: data.first_touch_channel }),
    ...(data.utm_source && { utm_source: data.utm_source }),
    ...(data.utm_medium && { utm_medium: data.utm_medium }),
    ...(data.utm_campaign && { utm_campaign: data.utm_campaign }),
    ...(data.phone && { phone: data.phone }),
    // TAM activation: set owner + lifecycle directly so HubSpot workflows don't touch it
    ...(data.hubspot_owner_id && { hubspot_owner_id: data.hubspot_owner_id }),
    ...(data.lifecyclestage && { lifecyclestage: data.lifecyclestage }),
    // Signal attribution: structured fields for HubSpot filtering/reporting
    ...(data.signal_date && { signal_date: toHubSpotDate(data.signal_date) }),
    ...(data.signal_pages_visited && { signal_pages_visited: data.signal_pages_visited }),
    ...(data.signal_sessions != null && { signal_sessions: String(data.signal_sessions) }),
    ...(data.signal_time_on_site != null && { signal_time_on_site: String(data.signal_time_on_site) }),
    ...(data.icp_tier && { icp_tier: data.icp_tier }),
  };

  const created = await hubspot.crm.contacts.basicApi.create({ properties, associations: [] });
  return { action: "created", id: created.id };
}

// ============================================================
// CONTACT UPDATE — matches Clay f_0tbawowRtkqYdqMEXyx exactly
// Same properties as create, but targets existing contact by ID
// ============================================================

export interface ContactUpdateData {
  hubspot_contact_id: string;
  intent_score?: number;
  icp_score?: number;
  total_score?: number;
  lead_tier?: string;
  lead_temp?: string;
  lead_summary?: string;
  sales_org_summary?: string;
  sub_market?: string;
  city?: string;
  state?: string;
  lead_origin?: string;
  lead_type?: string;
  clay_lead_source?: string;
  signal_type?: string;
  first_touch_channel?: string;
  // G14: UTMs removed from update — Syft owns these on existing contacts
  phone?: string;
  company?: string;
  jobtitle?: string;
  // LinkedIn URL — added Apr 8 2026 after discovery that existing HubSpot
  // contacts never got their LinkedIn URL populated from V2, even when V2
  // had it. createHubSpotContact writes it on new contact creation, but
  // update path was missing the field entirely. Bug was particularly bad
  // for contacts that pre-existed in HubSpot (from Syft native push, old
  // Clay, RepA's manual adds, etc.) and got enriched later by V2.
  hs_linkedin_url?: string;
  // Signal attribution — pushed on score updates so existing contacts get fresh signal data
  signal_date?: string;
  signal_pages_visited?: string;
  signal_sessions?: number;
  signal_time_on_site?: number;
  // ICP tier dropdown (Priority / Strong Fit / High Potential / Review)
  icp_tier?: string;
}

export async function updateHubSpotContact(data: ContactUpdateData): Promise<{
  action: "updated";
  id: string;
}> {
  const properties: Record<string, string> = {
    ...(data.intent_score != null && { intent_score: String(data.intent_score) }),
    ...(data.icp_score != null && { icp_score: String(data.icp_score) }),
    ...(data.total_score != null && { total_score: String(data.total_score) }),
    // Same lead_tier/lead_temp mapping as create
    ...(data.lead_tier != null && {
      lead_tier: data.lead_tier === "Cold" || data.lead_tier === "cold" ? "" : data.lead_tier,
    }),
    ...(data.lead_temp != null && {
      lead_temp: data.lead_temp === "Cool" || data.lead_temp === "cool" ? "Cold" : (data.lead_temp || "Cold"),
    }),
    ...(data.lead_summary && { lead_summary: data.lead_summary.replace(/"/g, "'") }),
    ...(data.sales_org_summary && { sales_org_summary: data.sales_org_summary.replace(/"/g, "'") }),
    ...(data.sub_market && { sub_market: data.sub_market }),
    ...(data.city && { city: data.city }),
    ...(data.state && { state: data.state }),
    lead_origin: data.lead_origin || deriveLeadOrigin(data.clay_lead_source),
    lead_type: data.lead_type || deriveLeadType(data.clay_lead_source),
    ...(data.clay_lead_source && { clay_lead_source: data.clay_lead_source }),
    ...(data.signal_type && { signal_type: data.signal_type }),
    ...(data.first_touch_channel && { first_touch_channel: data.first_touch_channel }),
    // G14 fix: NEVER overwrite UTMs on update — Syft pushes these directly (351 contacts)
    // UTMs are only set on CREATE (new contacts via enrich-contact.ts)
    ...(data.phone && { phone: data.phone }),
    ...(data.company && { company: data.company.replace(/"/g, "'") }),
    ...(data.jobtitle && { jobtitle: data.jobtitle }),
    ...(data.hs_linkedin_url && { hs_linkedin_url: data.hs_linkedin_url }),
    // Signal attribution — existing contacts get fresh signal data on score updates
    ...(data.signal_date && { signal_date: toHubSpotDate(data.signal_date) }),
    ...(data.signal_pages_visited && { signal_pages_visited: data.signal_pages_visited }),
    ...(data.signal_sessions != null && { signal_sessions: String(data.signal_sessions) }),
    ...(data.signal_time_on_site != null && { signal_time_on_site: String(data.signal_time_on_site) }),
    ...(data.icp_tier && { icp_tier: data.icp_tier }),
  };

  await hubspot.crm.contacts.basicApi.update(data.hubspot_contact_id, { properties });
  return { action: "updated", id: data.hubspot_contact_id };
}

// ============================================================
// HUBSPOT LOOKUPS — replaces Clay lookup actions
// ============================================================

// Lookup company by domain — matches Clay HubSpot Company Lookup on Normalization
export async function lookupHubSpotCompany(domain: string): Promise<{
  exists: boolean;
  id?: string;
  lifecycle?: string;
}> {
  try {
    const searchRes = await hubspot.crm.companies.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: "domain",
          operator: "EQ" as any,
          value: domain,
        }],
      }],
      properties: ["domain", "lifecyclestage"],
      limit: 1,
    });

    if (searchRes.results.length > 0) {
      return {
        exists: true,
        id: searchRes.results[0].id,
        lifecycle: searchRes.results[0].properties.lifecyclestage || undefined,
      };
    }
  } catch (err) {
    console.error(`[hubspot] Company lookup failed for ${domain}:`, err);
  }
  return { exists: false };
}

// Early contact lookup — checks LinkedIn URL, then name+company before burning enrichment credits.
// LinkedIn slugs differ across sources (Clay vs HubSpot vs V2), so name+company is the reliable fallback.
export async function lookupHubSpotContactEarly(params: {
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyDomain?: string | null;
}): Promise<{
  exists: boolean;
  id?: string;
  email?: string;
}> {
  try {
    // Try 1: LinkedIn URL lookup — attempts multiple format variants.
    //
    // Why multiple attempts: createHubSpotContact writes the full URL (e.g.,
    // https://www.linkedin.com/in/jane-doe/), but legacy Clay pushes
    // may have stored just the slug or a slug-only path. HubSpot's URL property
    // tokenizer is finicky, so a single CONTAINS_TOKEN on a slug doesn't always
    // hit a stored full-URL value. We try variants in decreasing specificity:
    //   1. EQ on the canonical full URL (strict match for records V2 created)
    //   2. CONTAINS_TOKEN on the slug alone (handles legacy stored formats)
    if (params.linkedinUrl) {
      // Extract the canonical slug once — everything after /in/, no trailing slash
      const slug = params.linkedinUrl.split("/in/")[1]?.replace(/\/$/, "") || "";
      // Normalize the full URL to HubSpot's stored format (no trailing slash)
      const fullUrlNoSlash = params.linkedinUrl.replace(/\/$/, "");

      const attempts: Array<{ operator: string; value: string; label: string }> = [];
      if (fullUrlNoSlash) attempts.push({ operator: "EQ", value: fullUrlNoSlash, label: "full URL EQ" });
      if (fullUrlNoSlash) attempts.push({ operator: "CONTAINS_TOKEN", value: fullUrlNoSlash, label: "full URL CONTAINS_TOKEN" });
      if (slug) attempts.push({ operator: "CONTAINS_TOKEN", value: slug, label: "slug CONTAINS_TOKEN" });

      for (const attempt of attempts) {
        const searchRes = await hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: "hs_linkedin_url",
              operator: attempt.operator as any,
              value: attempt.value,
            }],
          }],
          properties: ["email", "hs_linkedin_url"],
          limit: 1,
        });

        if (searchRes.results.length > 0) {
          return {
            exists: true,
            id: searchRes.results[0].id,
            email: searchRes.results[0].properties.email || undefined,
          };
        }
      }
    }

    // Try 2: firstname + lastname + associated company domain
    if (params.firstName && params.lastName && params.companyDomain) {
      const searchRes = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: "firstname", operator: "EQ" as any, value: params.firstName },
            { propertyName: "lastname", operator: "EQ" as any, value: params.lastName },
            { propertyName: "associatedcompanyid", operator: "HAS_PROPERTY" as any },
          ],
        }],
        properties: ["email", "firstname", "lastname", "company"],
        limit: 5,
      });

      // Filter results to match company domain
      for (const result of searchRes.results) {
        const email = result.properties.email || "";
        if (email.endsWith(`@${params.companyDomain}`)) {
          return { exists: true, id: result.id, email };
        }
      }
    }
  } catch (err) {
    console.error(`[hubspot] Early contact lookup failed:`, err);
  }
  return { exists: false };
}

// Lookup contact by email — matches Clay HubSpot Contact Lookup
export async function lookupHubSpotContact(email: string): Promise<{
  exists: boolean;
  id?: string;
}> {
  try {
    const searchRes = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: "email",
          operator: "EQ" as any,
          value: email,
        }],
      }],
      properties: ["email"],
      limit: 1,
    });

    if (searchRes.results.length > 0) {
      return { exists: true, id: searchRes.results[0].id };
    }
  } catch (err) {
    console.error(`[hubspot] Contact lookup failed for ${email}:`, err);
  }
  return { exists: false };
}
