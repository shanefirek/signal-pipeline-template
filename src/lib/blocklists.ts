// Blocklists — replaces Clay enterprise blocklist (39 domains) + domain blocklist table (56 domains)
// Source: Clay Company Profiles conditional run on f_0taolalFoEhC3QN39GQ

// Enterprise domains: saves enrichment credits on companies that will never be clients.
// These get blocked at the Company Info enrichment step.
export const ENTERPRISE_BLOCKLIST: ReadonlySet<string> = new Set([
  "microsoft.com",
  "amazon.com",
  "aws.amazon.com",
  "ibm.com",
  "google.com",
  "apple.com",
  "meta.com",
  "facebook.com",
  "oracle.com",
  "sap.com",
  "adobe.com",
  "cisco.com",
  "intel.com",
  "dell.com",
  "salesforce.com",
  "udemy.com",
  "accenture.com",
  "deloitte.com",
  "pwc.com",
  "mckinsey.com",
  "walmart.com",
  "target.com",
  "hubspot.com",
  "linkedin.com",
  "twitter.com",
  "zoom.us",
  "slack.com",
  "atlassian.com",
  "dropbox.com",
  "spotify.com",
  "netflix.com",
  "uber.com",
  "airbnb.com",
  "stripe.com",
  "shopify.com",
  "squarespace.com",
  "wix.com",
  "godaddy.com",
  "wordpress.com",
  "mailchimp.com",
]);

// Internal domains: never process our own traffic or partner traffic.
// This set is checked by validateDomain() — any raw_signal from one of these
// domains is dropped at the validation gate with reason="internal".
//
// Includes:
//   acmegtm.com   — our primary site
//   starbridge.ai     — exclusive agency partner (Justin/Antonio)
//   digital-made.com  — DMA (RepD's agency)
//
// NOTE: Do NOT add an employee's personal/former company domain here. Other
// real prospects may share the domain. Block the individual person instead
// via INTERNAL_EMPLOYEES_LINKEDIN / INTERNAL_EMPLOYEES_EMAIL (below).
export const INTERNAL_DOMAINS: ReadonlySet<string> = new Set([
  "acmegtm.com",
  "starbridge.ai",
  "digital-made.com",
  "octave.is",
]);

// Internal employees: individual people who work at ACME. Their visits and
// activity should never be processed as leads regardless of what domain they
// appear to come from (e.g., a former company domain, a personal site, etc.).
//
// Matched by LinkedIn URL (most reliable — Syft always sends this when
// available) OR by email. Both sets are lowercased at compare time.
//
// When adding a new employee, populate BOTH fields if known. The matcher
// short-circuits on the first hit so either alone is sufficient to block.
export const INTERNAL_EMPLOYEES_LINKEDIN: ReadonlySet<string> = new Set<string>([
  // Populated below via normalizeLinkedinUrl — add canonical linkedin.com/in/<slug> paths.
  // "https://linkedin.com/in/rep_b-oswald-example",
]);

export const INTERNAL_EMPLOYEES_EMAIL: ReadonlySet<string> = new Set<string>([
  // e.g. "user@example.com" — ACME-domain emails are already caught by
  // INTERNAL_DOMAINS. Add former/personal emails here when the employee
  // identifies with a non-ACME email on web visits.
]);

// Title blocklist: contacts with these titles are NOT decision makers for ACME's services.
// ACME ICP buyer = CEO/Founder or VP Sales/CRO. Block non-buyer titles.
// Matches Clay Contact Profiles conditional run on Push to HubSpot (f_0taxx5sqGD8Rm6B7ixb)
//
// Two lists: substring patterns (safe for .includes) and short acronyms (need word-boundary regex).
// "cto" must NOT match "director" — use TITLE_BLOCKLIST_ACRONYMS with \b word boundaries.
export const TITLE_BLOCKLIST_PATTERNS: readonly string[] = [
  // HR
  "human resource",
  "chro",
  "chief human",
  "vp hr",
  // Marketing
  "chief marketing",
  "marketing manager",
  "vp marketing",
  "vice president of marketing",
  "head of marketing",
  // Finance
  "chief financial",
  // Tech / Engineering
  "chief technology officer",
  "vp engineering",
  "vice president of engineering",
  "head of engineering",
  "director of engineering",
  "software engineer",
  // Product
  "chief product officer",
  "vp product",
  "vice president of product",
  "head of product",
  "director of product",
  "product manager",
  // Ops / non-buyer
  "chief operating officer",
  "chief information officer",
  "chief data officer",
  "chief legal",
  "general counsel",
  // SDR/BDR/AE (they're the service we sell, not the buyer)
  "sdr manager",
  "bdr manager",
  "sales development rep",
  "business development rep",
  "business development executive",
  "account executive",
  // Customer-side roles
  "customer success",
  "account manager",
  "support manager",
  // Admin / assistant — not decision makers (Lilly Santiago fix Apr 10)
  "executive assistant",
  "office manager",
  "administrative assistant",
  // Education (Higher Ed TAM — these are buyers of education, not sales tools)
  "teacher",
  "professor",
  "instructor",
  "lecturer",
  "adjunct",
  // Curriculum / academic roles — not sales buyers (joanne whitley fix Apr 15)
  "mathematics",
  "curriculum",
  "professional development",
  "academic affairs",
  "dean of",
  "provost",
  "registrar",
  // Junior / non-operational
  "student",
  "intern",
  "fellow",
  "volunteer",
  "board member",
  "advisory board",
  // Retail / ops (getloper.com false positive)
  "shop manager",
  "store manager",
  "retail",
  // Consultant (too generic, not a decision maker at the company)
  "consultant",
  // Development (expanded) — catches all developer-level roles
  // Apr 15: "Lead Developer", "Software Developer" were getting through
  "developer",
  "head of software",
  // Marketing (expanded) — marketing people are not buyers for SDR services.
  // Apr 29: "Associate Vice President, Marketing" slipped through all existing
  // patterns. Using "president, marketing" catches comma variants.
  "director of marketing",
  "marketing director",
  "vice president marketing",  // variant without "of"
  "president, marketing",  // catches "VP, Marketing", "AVP, Marketing", etc.
  // Creative/Design — not decision makers for ACME
  // Apr 15: "Art Director" was getting through
  "art director",
  "creative director",
  "design director",
];

// Partner / customer domains: contacts here should never be dialed.
// coursedog.com = Starbridge partner (Justin Wenig). Add more as Shane identifies them.
export const PARTNER_DOMAINS: ReadonlySet<string> = new Set([
  "coursedog.com",
]);

// Short acronyms that would false-positive with .includes() (e.g., "cto" in "director").
// Matched with \b word boundaries instead.
export const TITLE_BLOCKLIST_ACRONYMS: readonly RegExp[] = [
  /\bcto\b/i,
  /\bcmo\b/i,
  /\bcfo\b/i,
  /\bcpo\b/i,
  /\bcio\b/i,
  /\bae\b/i,  // Account Executive — ACME sells SDR outsourcing, AEs are peers, not buyers
  /\bsdr\b/i,
  /\bbdr\b/i,
  /\bbde\b/i, // Business Development Executive
];
