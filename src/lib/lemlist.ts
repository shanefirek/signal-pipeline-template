// LemList API — LinkedIn sequence enrollment
//
// Used by enrich-contact.ts to auto-enroll Hot/Warm MQLs into RepA's LinkedIn sequence.
// RepC's proven pattern: profile visit → blank invite → manual DM on accept (36% accept rate).
//
// API docs: https://developer.lemlist.com

const LEMLIST_API = "https://api.lemlist.com/api";

function authHeader(): string {
  const key = process.env.LEMLIST_API_KEY;
  if (!key) throw new Error("LEMLIST_API_KEY not set");
  // LemList uses HTTP Basic Auth with empty username and API key as password
  return `Basic ${Buffer.from(`:${key}`).toString("base64")}`;
}

export interface LemListEnrollResult {
  enrolled: boolean;
  leadId?: string;
  reason?: string;
}

// Enroll a contact into a LemList campaign
// Requires at minimum: linkedinUrl (LinkedIn-only campaigns don't need email)
export async function enrollInCampaign(params: {
  campaignId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  linkedinUrl: string;
  // Custom variables passed to LemList templates
  domain?: string | null;
  title?: string | null;
  icpScore?: number;
  leadSource?: string | null;
}): Promise<LemListEnrollResult> {
  const { campaignId, linkedinUrl } = params;

  if (!process.env.LEMLIST_API_KEY) {
    console.warn("[lemlist] LEMLIST_API_KEY not set — skipping enrollment");
    return { enrolled: false, reason: "no_api_key" };
  }

  // LemList requires email as the lead identifier, even for LinkedIn-only campaigns.
  // Use a placeholder if no email (LemList dedupes by email within a campaign).
  const email = params.email || `${linkedinUrl.split("/in/")[1]?.replace(/\//g, "") || "unknown"}@linkedin.placeholder`;

  const body: Record<string, any> = {
    email,
    linkedinUrl,
    ...(params.firstName && { firstName: params.firstName }),
    ...(params.lastName && { lastName: params.lastName }),
    ...(params.companyName && { companyName: params.companyName }),
    ...(params.domain && { companyDomain: params.domain }),
    ...(params.title && { jobTitle: params.title }),
    ...(params.icpScore !== undefined && { icpScore: String(params.icpScore) }),
    ...(params.leadSource && { leadSource: params.leadSource }),
  };

  const res = await fetch(`${LEMLIST_API}/campaigns/${campaignId}/leads/${encodeURIComponent(email)}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    // Lead already exists in this campaign
    return { enrolled: false, reason: "already_enrolled" };
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[lemlist] Enrollment failed (${res.status}): ${errText}`);
    return { enrolled: false, reason: `api_error_${res.status}` };
  }

  const data = await res.json();
  return {
    enrolled: true,
    leadId: data._id,
  };
}

// Check if LemList enrollment is enabled
export function isLemListEnabled(): boolean {
  return !!(process.env.LEMLIST_API_KEY && process.env.LEMLIST_CAMPAIGN_ID);
}

// Get RepA's campaign ID from env
export function getRepACampaignId(): string {
  return process.env.LEMLIST_CAMPAIGN_ID || "";
}
