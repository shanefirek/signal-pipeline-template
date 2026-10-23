// Funding extraction — pulls latest round from crunchBaseFunding[] array
// Verified against 3 real responses: exampleco (Series B $21M), Newsela (Series D $100M), Securly (Series B $16M)

export interface FundingRound {
  roundName: string;
  roundAmount: number | null;
  roundDate: string | null;
  investorNames: string[];
  investorCount: number;
  fundingRoundCount: number;
}

export interface FundingExtraction {
  funding_stage: string | null;     // "Seed", "Series A", "Series B", etc.
  funding_total: number | null;     // Dollars raised in latest round
  funding_date: string | null;      // ISO date of latest round
  investors: string[];              // Investor names from latest round
  funding_round_count: number;      // Total rounds
}

// Extract latest funding round from crunchBaseFunding array
// Sorts by date descending, takes most recent
export function extractFunding(crunchBaseFunding: FundingRound[] | null | undefined): FundingExtraction {
  const empty: FundingExtraction = {
    funding_stage: null,
    funding_total: null,
    funding_date: null,
    investors: [],
    funding_round_count: 0,
  };

  if (!crunchBaseFunding || !Array.isArray(crunchBaseFunding) || crunchBaseFunding.length === 0) {
    return empty;
  }

  // Sort by date descending (latest first). Handle missing dates by pushing to end.
  const sorted = [...crunchBaseFunding].sort((a, b) => {
    if (!a.roundDate && !b.roundDate) return 0;
    if (!a.roundDate) return 1;
    if (!b.roundDate) return -1;
    return new Date(b.roundDate).getTime() - new Date(a.roundDate).getTime();
  });

  const latest = sorted[0];

  return {
    funding_stage: normalizeFundingStage(latest.roundName),
    funding_total: latest.roundAmount ?? null,
    funding_date: latest.roundDate ?? null,
    investors: latest.investorNames || [],
    funding_round_count: latest.fundingRoundCount || crunchBaseFunding.length,
  };
}

// Normalize round names to canonical stages
// Crunchbase uses: "Seed", "Series A", "Series B", "Series C", "Series D", etc.
// Also: "Angel", "Pre-Seed", "Debt Financing", "Grant", "Corporate Round", etc.
export function normalizeFundingStage(roundName: string | null | undefined): string | null {
  if (!roundName) return null;

  const r = roundName.toLowerCase().trim();

  if (r.includes("pre-seed") || r.includes("pre seed")) return "Pre-Seed";
  if (r === "seed" || r.includes("seed round")) return "Seed";
  if (r === "angel" || r.includes("angel round")) return "Angel";
  if (r.includes("series a")) return "Series A";
  if (r.includes("series b")) return "Series B";
  if (r.includes("series c")) return "Series C";
  if (r.includes("series d")) return "Series D";
  if (r.includes("series e")) return "Series E";
  if (r.includes("series f")) return "Series F";
  if (r.includes("ipo")) return "IPO";
  if (r.includes("debt")) return "Debt";
  if (r.includes("grant")) return "Grant";
  if (r.includes("corporate")) return "Corporate Round";
  if (r.includes("private equity")) return "Private Equity";
  if (r.includes("venture")) return "Venture Round";

  return roundName; // Pass through unknown stages
}

// Score funding stage for ICP (0-30)
// Funded = signal of market validation + budget for GTM services
// Series A = sweet spot (just raised, need to scale sales)
export function scoreFunding(fundingStage: string | null | undefined): number {
  if (!fundingStage) return 5; // RepC's rule: no data = benefit of doubt

  const s = fundingStage.toLowerCase();

  if (s === "series a") return 30;           // Sweet spot — just raised, scaling sales
  if (s === "series b") return 25;           // Strong — proven model, expanding
  if (s === "seed") return 15;               // Early — may not have budget yet
  if (s === "pre-seed" || s === "angel") return 10;  // Very early
  if (s === "series c" || s === "series d" || s === "series e" || s === "series f") return 10;  // Late stage — likely have internal team
  if (s === "ipo" || s === "private equity") return 5;  // Probably too big
  if (s === "debt" || s === "grant" || s === "corporate round") return 5;  // Non-equity

  return 5; // Unknown stage
}

// Derive funding stage from a numeric total funding amount.
// Used as a fallback when LeadMagic returns total_funding but no stage label.
// Promoted from a private helper in tam-enrich.ts so enrich-company can share it.
export function deriveFundingStage(totalFunding: number | null | undefined): string | null {
  if (!totalFunding || isNaN(totalFunding)) return null;

  if (totalFunding >= 50_000_000) return "Series C";
  if (totalFunding >= 15_000_000) return "Series B";
  if (totalFunding >= 3_000_000) return "Series A";
  if (totalFunding >= 500_000) return "Seed";
  if (totalFunding > 0) return "Pre-Seed";

  return null;
}

// Map canonical funding stage names to HubSpot enum values.
// HubSpot uses lowercase/underscored enums; our internal names are titlecase.
// Returns undefined for stages that have no HubSpot enum (IPO, Debt, Grant, etc.)
// so the field is omitted from the push via conditional spread.
export function toHubSpotFundingStage(stage: string | null | undefined): string | undefined {
  if (!stage) return undefined;

  const s = stage.toLowerCase().trim();

  if (s === "seed" || s === "pre-seed") return "seed";
  if (s === "angel") return "angel";
  if (s === "series a") return "series_a";
  if (s === "series b") return "series_b";
  if (s === "series c") return "series_c";
  if (s === "series d" || s === "series e" || s === "series f") return "series_d+";
  if (s === "private equity" || s === "pe") return "pe_backed";
  if (s === "bootstrapped") return "bootstrapped";

  return undefined;
}
