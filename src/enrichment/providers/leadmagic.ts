// LeadMagic — email validate + find + phone
// Replaces Clay waterfall steps 3-5:
//   Step 3: Validate email (f_0taxwwem2FYTJ5GgPKZ) — leadmagic-validate-email
//   Step 4: Find work email (f_0taxwwe2XGQP8p3Sjrf) — leadmagic-find-work-email
//   Step 5: Validate email (2) (f_0taxx07vDbGwE9ihAhm) — leadmagic-validate-email
//   Phone: Find Mobile Phone (f_0tbhd5eEB9nVuH9uemz) — leadmagic-find-mobile-number
//
// Auth: X-API-Key header (NOT Bearer token)
// Docs: LEADMAGIC.md

const LEADMAGIC_BASE_URL = "https://api.leadmagic.io/v1";

function getHeaders(): Record<string, string> | null {
  const apiKey = process.env.LEADMAGIC_API_KEY;
  if (!apiKey) return null;
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

// Validate email — returns status + deliverable check
export async function validateEmail(email: string): Promise<{
  status: string;
  deliverable: boolean;
  email: string;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/email-validation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    const status = data.email_status || data.status || "unknown";
    return {
      status,
      deliverable: data.deliverable === true || status === "valid",
      email: data.email || email,
    };
  } catch (err) {
    console.error("[leadmagic] validate error:", err);
    return null;
  }
}

// Find work email by name + domain
// LeadMagic's email-finder already verifies the email server-side.
// When status === "valid" the response message reads:
//   "Email was confidently found and verified."
// So we pass the status through and let callers trust it without
// a redundant /email-validation round-trip (which was producing false
// negatives and silently dropping verified emails — see Apr 7 2026 bug).
export async function findWorkEmail(params: {
  name: string;
  domain: string;
}): Promise<{
  email: string;
  status: string;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  // Split name into first/last for the API
  const parts = params.name.trim().split(/\s+/);
  const first_name = parts[0] || "";
  const last_name = parts.slice(1).join(" ") || "";

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/email-finder`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        first_name,
        last_name,
        domain: params.domain,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    if (data.email) {
      return { email: data.email, status: data.status || "unknown" };
    }
    return null;
  } catch (err) {
    console.error("[leadmagic] find email error:", err);
    return null;
  }
}

// Email to LinkedIn profile — returns profile URL from work email
// Endpoint: POST /v1/people/b2b-profile-email  (10 credits, pay-on-success)
export async function emailToProfile(email: string): Promise<{
  profile_url: string;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/b2b-profile-email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    if (data.profile_url || data.linkedin_url) {
      return { profile_url: data.profile_url || data.linkedin_url };
    }
    return null;
  } catch (err) {
    console.error("[leadmagic] email-to-profile error:", err);
    return null;
  }
}

// Profile Search — LinkedIn URL → full profile with current position
// Replaces Cargo's verifyEmploymentByUrl. 1 credit, <3s.
export async function profileSearch(linkedinUrl: string): Promise<{
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  company_website: string | null;
  linkedin_url: string;
  raw: any;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/profile-search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile_url: linkedinUrl }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    return {
      full_name: data.full_name || null,
      current_title: data.current_position?.position_title || data.professional_title || null,
      current_company: data.current_position?.company_name || data.company_name || null,
      company_website: data.current_position?.company_website || data.company_website || null,
      linkedin_url: data.profile_url || linkedinUrl,
      raw: data,
    };
  } catch (err) {
    console.error("[leadmagic] profile-search error:", err);
    return null;
  }
}

// B2B Profile — email → LinkedIn URL. 10 credits (free if not found).
export async function findLinkedInByEmail(email: string): Promise<{
  profile_url: string;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/b2b-profile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ work_email: email }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    if (data.profile_url) {
      return { profile_url: data.profile_url };
    }
    return null;
  } catch (err) {
    console.error("[leadmagic] b2b-profile error:", err);
    return null;
  }
}

// Find mobile phone number by LinkedIn URL or email
// API accepts either { profile_url: "..." } or { email: "..." }
// Matches Clay f_0tbhd5eEB9nVuH9uemz
export async function findMobilePhone(identifier: string): Promise<{
  mobile_number: string;
} | null> {
  const headers = getHeaders();
  if (!headers) return null;

  const isEmail = identifier.includes("@");
  const body = isEmail ? { email: identifier } : { profile_url: identifier };

  try {
    const res = await fetch(`${LEADMAGIC_BASE_URL}/people/mobile-finder`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    if (data.mobile_number) {
      return { mobile_number: data.mobile_number };
    }
    return null;
  } catch (err) {
    console.error("[leadmagic] find phone error:", err);
    return null;
  }
}
