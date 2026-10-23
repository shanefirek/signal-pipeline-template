// Enrichment types — Cargo-first architecture
// Cargo handles: employment verification, email find/verify
// LeadMagic handles: fallback email discovery, phone lookup

// Email waterfall result — tracks which step found the email
export interface EmailWaterfallResult {
  email: string | null;
  verified: boolean;
  source: "cargo_validate" | "cargo_find" | "leadmagic_validate" | "leadmagic_find" | "existing" | "none";
}

// Contact enrichment (email/phone from Cargo primary, LeadMagic fallback)
export interface ContactEnrichment {
  email?: string;
  email_verified?: boolean;
  first_name?: string;
  last_name?: string;
  title?: string;
  linkedin_url?: string;
  phone?: string;
}
