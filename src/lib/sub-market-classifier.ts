// Sub-Market Classifier — single source of truth for company vertical classification.
//
// v2.0.0 — SLED-only. Classifies by WHO THE COMPANY SELLS TO, not what they are.
// 4 categories: K12 EdTech SaaS, Higher Ed, Government & Public Sector, Not SLED.
//
// Classification flow:
//   1. TLD detection (.edu, .gov, .k12.*) → "Not SLED" (institutions aren't prospects)
//   2. Industry keyword pre-filter        → fast-path non-SLED (Healthcare, Finance, etc.)
//   3. Claude Haiku (low cost)            → SLED-focused 4-way classification
//
// Versioned: bumping CLASSIFIER_VERSION lets us know which records need re-running.

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const CLASSIFIER_VERSION = "2.0.0";

// --- Sub-market enum (4 categories) ---
// String values match what downstream consumers expect (gates, routing, scoring).

export const SUB_MARKETS = [
  "K12 EdTech SaaS",
  "Higher Ed",
  "Government & Public Sector",
  "Not SLED",
] as const;

export type SubMarket = (typeof SUB_MARKETS)[number];

// --- Inputs and outputs ---

export interface ClassifierInput {
  domain: string;
  name?: string | null;
  description?: string | null;
  industry?: string | null; // LeadMagic raw industry
  employee_count?: number | null;
  // Free-text content from a website scrape (Apify or cheerio fallback)
  scraped_text?: string | null;
}

export type ClassifierSource =
  | "tld" // Hard rule from TLD
  | "industry_keyword" // Hard rule from LeadMagic industry string
  | "claude" // Full Claude classification
  | "default"; // Fallback to "Not SLED"

export type ClassifierConfidence = "high" | "medium" | "low";

export interface ClassifierOutput {
  sub_market: SubMarket;
  confidence: ClassifierConfidence;
  reason: string;
  source: ClassifierSource;
  version: string;
}

// --- Hard rules: TLD detection ---
// Institutions (.edu, .k12.*, .gov, .mil) are NOT ACME prospects — they're the
// BUYERS of our clients' products. ACME sells SDR services to vendors, not institutions.
// validateDomain in gates.ts already blocks these from Syft; this catches TAM/backfill edge cases.

function classifyByTld(domain: string): ClassifierOutput | null {
  const d = domain.toLowerCase();

  if (/\.k12\.[a-z]{2}\.us$/.test(d) || /\.k12\.[a-z]{2,3}$/.test(d)) {
    return {
      sub_market: "Not SLED",
      confidence: "high",
      reason: "K-12 school district TLD (.k12.*) — institution, not a vendor",
      source: "tld",
      version: CLASSIFIER_VERSION,
    };
  }

  if (d.endsWith(".edu")) {
    return {
      sub_market: "Not SLED",
      confidence: "high",
      reason: ".edu TLD — institution, not a vendor selling to Higher Ed",
      source: "tld",
      version: CLASSIFIER_VERSION,
    };
  }

  if (d.endsWith(".gov") || d.endsWith(".mil") || /\.gov\.[a-z]{2}$/.test(d)) {
    return {
      sub_market: "Not SLED",
      confidence: "high",
      reason: "Government TLD (.gov/.mil) — institution, not a GovTech vendor",
      source: "tld",
      version: CLASSIFIER_VERSION,
    };
  }

  return null;
}

// --- Hard rules: industry keyword pre-filter ---
// Fast-path obvious non-SLED industries to "Not SLED" (saves Claude calls).
// Education-related industries (E-learning, Education Management, etc.) are
// deliberately NOT hard-ruled — Claude disambiguates K12 vs Higher Ed vs Not SLED.

function classifyByIndustry(industry: string | null | undefined): ClassifierOutput | null {
  if (!industry) return null;
  const i = industry.toLowerCase().trim();
  if (i.length === 0) return null;

  // Obvious non-SLED — no Claude call needed
  const NOT_SLED_INDUSTRIES = [
    // Healthcare
    "hospitals and health care", "hospitals & health care", "medical practice",
    "health, wellness and fitness",
    // Financial Services
    "financial services", "banking", "insurance", "investment management", "investment banking",
    // Government institutions (the agency itself, not vendors selling to gov)
    "government administration", "public policy", "judiciary",
    // Non-profit
    "non-profit organization management", "nonprofit organization management", "religious institutions",
    // Manufacturing
    "manufacturing", "machinery", "automotive", "aviation & aerospace", "chemicals",
    "defense and space manufacturing", "international affairs",
    // Consumer / B2C
    "consumer goods", "consumer services", "retail", "apparel & fashion",
    "food & beverages", "luxury goods & jewelry", "sporting goods", "wine and spirits",
    // School districts / institutions (not vendors)
    "primary/secondary education", "primary and secondary education",
  ];

  if (NOT_SLED_INDUSTRIES.includes(i)) {
    return {
      sub_market: "Not SLED",
      confidence: "high",
      reason: `LeadMagic industry: "${industry}" — not a SLED vendor`,
      source: "industry_keyword",
      version: CLASSIFIER_VERSION,
    };
  }

  // Ambiguous — punt to Claude:
  //   "E-Learning", "Education Management", "Education Technology", "Education",
  //   "Higher Education", "Computer Software", "SaaS", "IT and Services",
  //   "Professional Training & Coaching", "Publishing", etc.
  return null;
}

// --- Main entry point ---

/**
 * Classify a company into one of 4 SLED sub-market categories.
 *
 * Single source of truth — all enrichment paths call this function.
 * Returns: K12 EdTech SaaS | Higher Ed | Government & Public Sector | Not SLED.
 */
export async function classifySubMarket(input: ClassifierInput): Promise<ClassifierOutput> {
  // 1. TLD hard rule
  const tldResult = classifyByTld(input.domain);
  if (tldResult) return tldResult;

  // 2. Industry keyword hard rule
  const industryResult = classifyByIndustry(input.industry);
  if (industryResult) return industryResult;

  // 3. Claude classifier for ambiguous cases
  // If we have NO description, NO scraped text, AND NO useful industry, we
  // can't classify with Claude either — return Cannot Determine.
  const hasContext =
    (input.description && input.description.length > 30) ||
    (input.scraped_text && input.scraped_text.length > 100) ||
    (input.industry && input.industry.length > 0);

  if (!hasContext) {
    return {
      sub_market: "Not SLED",
      confidence: "low",
      reason: "No description, no scraped content, no industry — insufficient data to confirm SLED",
      source: "default",
      version: CLASSIFIER_VERSION,
    };
  }

  return classifyWithClaude(input);
}

// --- Claude classifier ---

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const SYSTEM_PROMPT = `You are a B2B sub-market classifier for Acme GTM, a B2B company that sells to companies in the SLED market.

Given a company, classify it into ONE of these 4 categories:

- "K12 EdTech SaaS" — Company sells products or services TO K-12 school districts, schools, or educators. The delivery model (SaaS, services, hardware, curriculum, tutoring, assessments, consulting) does not matter. Classify by BUYER, not product type.
- "Higher Ed" — Company sells products or services TO universities, community colleges, or post-secondary institutions.
- "Government & Public Sector" — Company sells products or services TO federal, state, or local government agencies. GovTech vendors, civic tech, public safety tech.
- "Not SLED" — Company does NOT primarily sell to K-12, Higher Ed, or Government buyers. This includes:
  - Institutions themselves (universities, school districts, government agencies are BUYERS, not sellers — they are NOT ACME prospects)
  - Corporate learning / L&D (sells to enterprise HR, not schools)
  - Consumer / B2C (admissions consulting for families, test prep for individuals)
  - General B2B SaaS not targeting SLED buyers
  - Healthcare, financial services, manufacturing, non-profit
  - Adult education / workforce development sold to employers
  - Companies where the primary buyer cannot be determined

CRITICAL RULES:
1. CLASSIFY BY WHO THE COMPANY SELLS TO, not what they are or how they deliver. A tutoring company that contracts with K-12 districts is "K12 EdTech SaaS". An admissions consulting firm that sells to individual families is "Not SLED". A company making LMS software for universities is "Higher Ed".
2. "E-learning" / "Education Technology" tags do NOT automatically mean K12 or Higher Ed. They cover corporate training, adult education, and compliance too. READ THE DESCRIPTION.
3. If a company sells to multiple SLED segments, classify by PRIMARY market. Count buyer-specific mentions to determine primary:
   - K12 signals: "school districts", "districts", "K-12", "K12", "schools", "teachers", "classrooms", "curriculum", "EMO", "CMO", "charter", "Title I", "ESSER", "E-Rate"
   - Higher Ed signals: "universities", "colleges", "campus", "higher education", "post-secondary", "registrar", "provost"
   - Gov signals: "government agencies", "federal agencies", "municipalities", "public safety", "civic"
   If K12 signals outnumber others, classify as K12. "Funding" or "grants" in context of school districts = K12 signal.
4. Look for buyer signals in the description — they outweigh generic industry labels.
5. When in doubt between two SLED categories, prefer the one with more specific buyer mentions. When in doubt between SLED and Not SLED, "Not SLED" is safer — false positives waste AE time.

Confidence levels:
- "high"   — Description clearly identifies the SLED buyer
- "medium" — Strong inference but some uncertainty
- "low"    — Best guess from limited signal

One-sentence reason citing specific evidence.`;

async function classifyWithClaude(input: ClassifierInput): Promise<ClassifierOutput> {
  const userPrompt = buildClaudePrompt(input);

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "classify_sub_market",
          description: "Classify a B2B company into one of Acme GTM's sub-market categories",
          input_schema: {
            type: "object",
            properties: {
              sub_market: {
                type: "string",
                enum: SUB_MARKETS as unknown as string[],
                description: "The sub-market category that best matches this company",
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Confidence level in the classification",
              },
              reason: {
                type: "string",
                description: "One-sentence justification citing specific evidence from the input",
              },
            },
            required: ["sub_market", "confidence", "reason"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "classify_sub_market" },
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract the tool_use block
    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      console.error(`[classifier] No tool_use in Claude response for ${input.domain}`);
      return {
        sub_market: "Not SLED",
        confidence: "low",
        reason: "Claude returned no tool_use response",
        source: "claude",
        version: CLASSIFIER_VERSION,
      };
    }

    const result = toolUse.input as {
      sub_market: SubMarket;
      confidence: ClassifierConfidence;
      reason: string;
    };

    // Defensive: validate the enum match (Claude tool-use enforces it but be safe)
    if (!SUB_MARKETS.includes(result.sub_market as SubMarket)) {
      console.error(`[classifier] Claude returned invalid sub_market "${result.sub_market}" for ${input.domain}`);
      return {
        sub_market: "Not SLED",
        confidence: "low",
        reason: `Claude returned invalid enum: ${result.sub_market}`,
        source: "claude",
        version: CLASSIFIER_VERSION,
      };
    }

    return {
      sub_market: result.sub_market,
      confidence: result.confidence,
      reason: result.reason,
      source: "claude",
      version: CLASSIFIER_VERSION,
    };
  } catch (err) {
    console.error(`[classifier] Claude API error for ${input.domain}:`, err);
    return {
      sub_market: "Not SLED",
      confidence: "low",
      reason: `Claude API error: ${(err as Error)?.message || "unknown"}`,
      source: "claude",
      version: CLASSIFIER_VERSION,
    };
  }
}

function buildClaudePrompt(input: ClassifierInput): string {
  const parts: string[] = ["Classify this company:"];
  parts.push(`Domain: ${input.domain}`);
  if (input.name) parts.push(`Name: ${input.name}`);
  if (input.industry) parts.push(`LeadMagic Industry: ${input.industry}`);
  if (input.employee_count) parts.push(`Employee count: ${input.employee_count}`);
  if (input.description) parts.push(`Description: ${input.description.slice(0, 1500)}`);
  if (input.scraped_text) {
    parts.push(`\nWebsite content (scraped):\n${input.scraped_text.slice(0, 3000)}`);
  }
  return parts.join("\n");
}
