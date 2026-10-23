// ICP Scoring — formula-based (0-125)
//   Vertical Fit (0-35) — from Sub-Market Classification AI
//   Headcount (0-15) — from employee_count
//   Company Stage (0-30) — from annual_revenue
//   Sales Team / Outbound Need (0-50) — AI-scored

export interface CompanyData {
  sub_market?: string | null;
  employee_count?: number | null;
  annual_revenue?: string | null;
  outbound_need_score?: number | null; // AI output (0-50)
}

export interface ICPBreakdown {
  total: number;
  vertical_fit: number;
  headcount: number;
  company_stage: number;
  sales_team: number;
}

// Vertical Fit (0-35) — maps Sub-Market Classification → score
// Matches Clay formula f_0taqjoqQCxCvZQRQMkK exactly
export function scoreVerticalFit(subMarket?: string | null): number {
  if (!subMarket) return 0;
  const c = subMarket.toLowerCase();

  if (c.includes("not b2b")) return 0;
  if (c.includes("other b2b")) return 0;

  // K12 top tier = 35
  if (c.includes("k12 edtech")) return 35;
  if (c.includes("k12 curriculum")) return 35;
  if (c.includes("k12 assessment")) return 35;

  // K12 adjacent = 25
  if (c.includes("k12 cyber")) return 25;
  if (c.includes("k12 pd")) return 25;
  if (c.includes("k12 hiring")) return 25;
  if (c.includes("k12 student")) return 25;
  if (c.includes("k12 facilities")) return 25;
  if (c.includes("k12 food")) return 25;

  // Higher Ed = 30
  if (c.includes("higher ed")) return 30;

  // Non-K12 B2B verticals = 25
  if (c.includes("financial services")) return 25;
  if (c.includes("healthcare")) return 25;
  if (c.includes("logistics")) return 25;
  if (c.includes("workforce")) return 25;
  if (c.includes("e-commerce") || c.includes("retail")) return 25;
  if (c.includes("sports") || c.includes("apparel")) return 25;

  // Government = 20
  if (c.includes("government") || c.includes("public sector")) return 20;

  return 0;
}

// Headcount (0-15) — from MixRank employee_count
// Matches Clay formula f_0taqhqsWzxZS8VAjBCU exactly
// Primary: MixRank employee_count. Fallback: Employees from Normalization source.
export function scoreHeadcount(count?: number | null): number {
  if (!count) return 0;
  if (count < 10) return 5;
  if (count <= 19) return 10;
  if (count <= 100) return 15;
  if (count <= 250) return 10;
  return 5; // > 250
}

// Company Stage (0-30) — from MixRank annual_revenue
// Matches Clay formula f_0taqjoyvMDQcMgEkxct exactly
// RepC's rule: no data = 15 (benefit of the doubt)
export function scoreCompanyStage(annualRevenue?: string | null): number {
  if (!annualRevenue) return 15; // RepC's rule: no data = benefit of doubt

  const rev = annualRevenue.toLowerCase();

  // Public companies
  if (rev.includes("public")) return 10;

  // $50M+ = enterprise, less relevant
  if (rev.includes("$50m") || rev.includes("50m+") || rev.includes("$100m") || rev.includes("100m+") ||
      rev.includes("$500m") || rev.includes("$1b") || rev.includes("billion")) return 10;

  // $20-50M = large mid-market
  if (rev.includes("$20m") || rev.includes("20m")) return 25;

  // $5-20M = sweet spot
  if (rev.includes("$5m") || rev.includes("$10m") || rev.includes("5m") || rev.includes("10m")) return 30;

  // $1-5M = growing
  if (rev.includes("$1m") || rev.includes("1m")) return 20;

  // < $1M
  if (rev.includes("less than") || rev.includes("< 1m") || rev.includes("<$1m") || rev.includes("under")) return 10;

  return 15; // Can't parse = treat as no data
}

// Sales Team Score (0-50) — extracted from AI Outbound Need Score output
// The AI returns just a number (0-50). This just extracts it.
// Matches Clay formula f_0taqlktKBkJWUpWR6mJ
export function scoreSalesTeam(outboundNeedScore?: number | null): number {
  return outboundNeedScore ?? 0;
}

// Full ICP Score = Vertical + Headcount + Stage + Sales Team (max 125)
// Matches Clay formula f_0taqlkzrTAZ5knfo876
export function scoreICP(data: CompanyData): ICPBreakdown {
  const vertical_fit = scoreVerticalFit(data.sub_market);
  const headcount = scoreHeadcount(data.employee_count);
  const company_stage = scoreCompanyStage(data.annual_revenue);
  const sales_team = scoreSalesTeam(data.outbound_need_score);

  return {
    total: vertical_fit + headcount + company_stage + sales_team,
    vertical_fit,
    headcount,
    company_stage,
    sales_team,
  };
}

// Company-level lead temp (used on HubSpot company records)
// Matches Clay push gate formula
export function companyLeadTemp(icpScore: number): "Hot" | "Warm" | "Cold" {
  if (icpScore >= 100) return "Hot";
  if (icpScore >= 60) return "Warm";
  return "Cold";
}

