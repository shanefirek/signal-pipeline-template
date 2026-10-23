import { describe, it, expect } from "vitest";
import {
  scoreVerticalFit,
  scoreHeadcount,
  scoreCompanyStage,
  scoreSalesTeam,
  scoreICP,
  companyLeadTemp,
} from "../scoring/icp.js";
import {
  scorePurchaseIntent,
  scoreEngagementDepth,
  scoreDirectAction,
  scoreReferralSource,
  scorePageIntent,
  scoreIntent,
  computeTier,
} from "../scoring/intent.js";
import { scoreFunding } from "../lib/funding.js";

// ============================================================
// ICP SCORING
// ============================================================

describe("scoreVerticalFit", () => {
  it("scores K12 EdTech top tier (35)", () => {
    expect(scoreVerticalFit("K12 EdTech SaaS")).toBe(35);
    expect(scoreVerticalFit("K12 Curriculum & Instruction")).toBe(35);
    expect(scoreVerticalFit("K12 Assessment & Testing")).toBe(35);
  });

  it("scores K12 adjacent (25)", () => {
    expect(scoreVerticalFit("K12 Cybersecurity")).toBe(25);
    expect(scoreVerticalFit("K12 PD & Coaching")).toBe(25);
  });

  it("scores Higher Ed (30)", () => {
    expect(scoreVerticalFit("Higher Ed SaaS")).toBe(30);
  });

  it("scores non-K12 B2B (25)", () => {
    expect(scoreVerticalFit("Financial Services")).toBe(25);
    expect(scoreVerticalFit("Healthcare IT")).toBe(25);
  });

  it("blocks Not B2B (0)", () => {
    expect(scoreVerticalFit("Not B2B")).toBe(0);
    expect(scoreVerticalFit("Other B2B")).toBe(0);
  });

  it("handles null/undefined (0)", () => {
    expect(scoreVerticalFit(null)).toBe(0);
    expect(scoreVerticalFit(undefined)).toBe(0);
  });
});

describe("scoreHeadcount", () => {
  it("scores sweet spot 20-100 highest (15)", () => {
    expect(scoreHeadcount(50)).toBe(15);
    expect(scoreHeadcount(100)).toBe(15);
    expect(scoreHeadcount(20)).toBe(15);
  });

  it("scores 10-19 moderate (10)", () => {
    expect(scoreHeadcount(10)).toBe(10);
    expect(scoreHeadcount(19)).toBe(10);
  });

  it("scores small and large lower", () => {
    expect(scoreHeadcount(5)).toBe(5);
    expect(scoreHeadcount(251)).toBe(5);
  });

  it("handles null/zero (0)", () => {
    expect(scoreHeadcount(null)).toBe(0);
    expect(scoreHeadcount(0)).toBe(0);
  });
});

describe("scoreCompanyStage", () => {
  it("scores $5-10M sweet spot (30)", () => {
    expect(scoreCompanyStage("$5M - $10M")).toBe(30);
  });

  it("scores $10-20M as large mid-market (25)", () => {
    // "$10M - $20M" matches "$20m" first in the function → 25
    expect(scoreCompanyStage("$10M - $20M")).toBe(25);
  });

  it("gives benefit of doubt for no data (15)", () => {
    expect(scoreCompanyStage(null)).toBe(15);
    expect(scoreCompanyStage(undefined)).toBe(15);
  });

  it("scores enterprise low (10)", () => {
    expect(scoreCompanyStage("$100M+")).toBe(10);
    expect(scoreCompanyStage("Public Company")).toBe(10);
  });
});

describe("scoreSalesTeam", () => {
  it("passes through AI score", () => {
    expect(scoreSalesTeam(40)).toBe(40);
    expect(scoreSalesTeam(0)).toBe(0);
  });

  it("handles null (0)", () => {
    expect(scoreSalesTeam(null)).toBe(0);
  });
});

describe("scoreICP (full)", () => {
  it("max score = 125 for perfect K12 company", () => {
    const result = scoreICP({
      sub_market: "K12 EdTech SaaS",
      employee_count: 50,
      annual_revenue: "$5M - $10M",
      outbound_need_score: 45,
    });
    expect(result.total).toBe(35 + 15 + 30 + 45); // 125
    expect(result.vertical_fit).toBe(35);
    expect(result.headcount).toBe(15);
    expect(result.company_stage).toBe(30);
    expect(result.sales_team).toBe(45);
  });

  it("scores 0 for Not B2B with no data", () => {
    const result = scoreICP({
      sub_market: "Not B2B",
      employee_count: null,
      annual_revenue: null,
      outbound_need_score: null,
    });
    expect(result.total).toBe(0 + 0 + 15 + 0); // 15 (company stage benefit of doubt)
  });
});

describe("companyLeadTemp", () => {
  it("Hot >= 100", () => expect(companyLeadTemp(100)).toBe("Hot"));
  it("Warm 60-99", () => expect(companyLeadTemp(60)).toBe("Warm"));
  it("Cold < 60", () => expect(companyLeadTemp(59)).toBe("Cold"));
});

// ============================================================
// FUNDING SCORING (imported from funding.ts)
// ============================================================

describe("scoreFunding (in ICP context)", () => {
  it("Series A = 30 (max funding points)", () => {
    expect(scoreFunding("Series A")).toBe(30);
  });

  it("no data = 5 (RepC's rule)", () => {
    expect(scoreFunding(null)).toBe(5);
  });
});

// ============================================================
// INTENT SCORING
// ============================================================

describe("scorePurchaseIntent", () => {
  it("Very High/High = 20", () => {
    expect(scorePurchaseIntent("Very High")).toBe(20);
    expect(scorePurchaseIntent("High")).toBe(20);
  });

  it("Medium = 10", () => {
    expect(scorePurchaseIntent("Medium")).toBe(10);
  });

  it("Low/null = 0", () => {
    expect(scorePurchaseIntent("Low")).toBe(0);
    expect(scorePurchaseIntent(null)).toBe(0);
  });

  it("caps at 20 with high intent session bonus", () => {
    expect(scorePurchaseIntent("High", 5)).toBe(20); // 20 + 5 capped
  });
});

describe("scoreEngagementDepth", () => {
  it("max = 25 for deep engagement", () => {
    expect(scoreEngagementDepth(5, 3, 600, 5)).toBe(25); // 15+10+10+5 = 40, capped 25
  });

  it("zero for no engagement", () => {
    expect(scoreEngagementDepth(0, 0, 0, 0)).toBe(0);
  });
});

describe("scoreDirectAction", () => {
  it("form/message/dm = 35", () => {
    expect(scoreDirectAction("form")).toBe(35);
    expect(scoreDirectAction("message")).toBe(35);
    expect(scoreDirectAction("dm")).toBe(35);
  });

  it("comment = 15", () => {
    expect(scoreDirectAction("comment")).toBe(15);
  });

  it("like = 5", () => {
    expect(scoreDirectAction("like")).toBe(5);
  });

  it("null = 0", () => {
    expect(scoreDirectAction(null)).toBe(0);
  });
});

describe("scoreReferralSource", () => {
  it("LinkedIn = 10", () => {
    expect(scoreReferralSource("LinkedIn")).toBe(10);
  });

  it("no UTM = 5 (benefit of doubt)", () => {
    expect(scoreReferralSource(null)).toBe(5);
  });
});

describe("scorePageIntent", () => {
  // 30-pointers (BOFU / high-intent)
  it("pricing page = 30", () => {
    expect(scorePageIntent("/pricing, /about")).toBe(30);
  });
  it("results page = 30", () => {
    expect(scorePageIntent("/results/")).toBe(30);
  });
  it("case study page = 30", () => {
    expect(scorePageIntent("/case-study/acme/")).toBe(30);
  });
  it("SDR meeting benchmarks page = 30 (ACME BOFU content)", () => {
    expect(scorePageIntent("/sdr-meeting-benchmarks/")).toBe(30);
  });
  it("K-12 lead-gen funnel page = 30", () => {
    expect(scorePageIntent("/k-12-lead-generation-funnel/")).toBe(30);
  });
  it("education lead-gen companies comparison page = 30", () => {
    expect(scorePageIntent("/education-lead-generation-companies/")).toBe(30);
  });
  it("go-to-market systems page = 30", () => {
    expect(scorePageIntent("/go-to-market-systems/")).toBe(30);
  });

  // 15-pointers (mid-funnel / solution pages)
  it("about page = 15", () => {
    expect(scorePageIntent("/about")).toBe(15);
  });
  it("sales-development service page = 15", () => {
    expect(scorePageIntent("/sales-development/")).toBe(15);
  });
  it("industries hub = 15", () => {
    expect(scorePageIntent("/industries/")).toBe(15);
  });
  it("K-12 software solution page = 15", () => {
    expect(scorePageIntent("/k-12-software-edtech-sales/")).toBe(15);
  });
  it("higher-ed solution page = 15", () => {
    expect(scorePageIntent("/higher-ed-outreach/")).toBe(15);
  });
  it("market-intelligence page = 15", () => {
    expect(scorePageIntent("/blog/market-intelligence-guide/")).toBe(15);
  });

  // 5-pointers (any other page)
  it("any page = 5", () => {
    expect(scorePageIntent("/blog")).toBe(5);
  });
  it("homepage only = 5", () => {
    expect(scorePageIntent("/")).toBe(5);
  });

  // pageViews floor fallback
  it("null pages + page_views > 0 = 5 (floor — visitor saw something)", () => {
    expect(scorePageIntent(null, 3)).toBe(5);
  });
  it("null pages + page_views = 0 → 0", () => {
    expect(scorePageIntent(null, 0)).toBe(0);
  });
  it("null pages + page_views undefined → 0", () => {
    expect(scorePageIntent(null)).toBe(0);
  });

  // High-value short-circuits legal/low-value pages in the same list
  it("privacy + pricing in same session = 30 (pricing wins)", () => {
    expect(scorePageIntent("/privacy-policy/, /pricing/")).toBe(30);
  });
});

describe("computeTier", () => {
  it("hot >= 100", () => expect(computeTier(100)).toBe("hot"));
  it("warm 60-99", () => expect(computeTier(60)).toBe("warm"));
  it("cool 30-59", () => expect(computeTier(30)).toBe("cool"));
  it("cold < 30", () => expect(computeTier(29)).toBe("cold"));
});

describe("scoreIntent (full)", () => {
  it("max realistic score for LinkedIn form + deep engagement + pricing page", () => {
    const result = scoreIntent({
      syft_purchase_intent: "Very High",
      high_intent_sessions: 3,
      page_views: 5,
      sessions: 3,
      active_time_seconds: 600,
      visitor_count: 5,
      linkedin_action: "form",
      utm_channel: "LinkedIn",
      session_pages_visited: "/pricing, /case-studies",
    });
    // 20 + 25 + 35 + 10 + 30 = 120
    expect(result.total).toBe(120);
  });

  it("zero for empty signal", () => {
    const result = scoreIntent({});
    // 0 + 0 + 0 + 5 (utm benefit of doubt) + 0 = 5
    expect(result.total).toBe(5);
  });
});
