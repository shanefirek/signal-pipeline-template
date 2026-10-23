import { describe, it, expect } from "vitest";
import {
  scoreSalesTeamReal,
  scoreTechStack,
  computeTamICP,
  tamTier,
  generateSalesOrgSummary,
} from "../scoring/tam-icp.js";
import type { SalesTeamAnalysis } from "../enrichment/providers/leadmagic-company.js";

// Helper: build a SalesTeamAnalysis with defaults
function team(overrides: Partial<SalesTeamAnalysis> = {}): SalesTeamAnalysis {
  return {
    ae_count: 0,
    sdr_count: 0,
    has_vp_sales: false,
    has_sales_director: false,
    has_sales_manager: false,
    founder_selling: false,
    sales_employees: [],
    hiring_sdr: false,
    hiring_ae: false,
    hiring_sales: false,
    sales_jobs: [],
    ...overrides,
  };
}

// ============================================================
// OUTBOUND NEED SCORING — Clay's 7 rules
// ============================================================

describe("scoreSalesTeamReal", () => {
  it("scores 10 when company has SDRs (they don't need us)", () => {
    expect(scoreSalesTeamReal(team({ sdr_count: 2 })).score).toBe(10);
    expect(scoreSalesTeamReal(team({ sdr_count: 2 })).pattern).toBe("has_sdr");
  });

  it("scores 10 when company is hiring SDRs", () => {
    expect(scoreSalesTeamReal(team({ hiring_sdr: true })).score).toBe(10);
    expect(scoreSalesTeamReal(team({ hiring_sdr: true })).pattern).toBe("has_sdr");
  });

  it("scores 35 for 4+ AEs no SDRs (scaling, needs help)", () => {
    expect(scoreSalesTeamReal(team({ ae_count: 5 })).score).toBe(35);
    expect(scoreSalesTeamReal(team({ ae_count: 5 })).pattern).toBe("4plus_ae_no_sdr");
  });

  it("scores 50 for 2-3 AEs no SDRs (golden ICP)", () => {
    expect(scoreSalesTeamReal(team({ ae_count: 2 })).score).toBe(50);
    expect(scoreSalesTeamReal(team({ ae_count: 3 })).score).toBe(50);
    expect(scoreSalesTeamReal(team({ ae_count: 2 })).pattern).toBe("2_3_ae_no_sdr");
  });

  it("scores 45 for founder selling (no AEs)", () => {
    expect(scoreSalesTeamReal(team({ founder_selling: true })).score).toBe(45);
    expect(scoreSalesTeamReal(team({ founder_selling: true })).pattern).toBe("founder_selling");
  });

  it("scores 40 for single AE no SDR", () => {
    expect(scoreSalesTeamReal(team({ ae_count: 1 })).score).toBe(40);
    expect(scoreSalesTeamReal(team({ ae_count: 1 })).pattern).toBe("single_ae_no_sdr");
  });

  it("scores 25 for hiring sales (no SDR)", () => {
    expect(scoreSalesTeamReal(team({ hiring_sales: true })).score).toBe(25);
    expect(scoreSalesTeamReal(team({ hiring_ae: true })).score).toBe(25);
  });

  it("scores 5 for no data", () => {
    expect(scoreSalesTeamReal(team()).score).toBe(5);
    expect(scoreSalesTeamReal(team()).pattern).toBe("no_data");
  });

  it("SDR rule takes priority over AE rules", () => {
    // Company has 3 AEs AND SDRs — SDR rule wins (score 10, not 50)
    expect(scoreSalesTeamReal(team({ ae_count: 3, sdr_count: 1 })).score).toBe(10);
  });

  it("founder selling with AE goes to single AE rule", () => {
    // Founder + 1 AE = AE rule (40), not founder rule (45)
    expect(scoreSalesTeamReal(team({ founder_selling: true, ae_count: 1 })).score).toBe(40);
  });
});

// ============================================================
// TECH STACK SCORING
// ============================================================

describe("scoreTechStack", () => {
  it("scores 15 for no technologies (needs everything)", () => {
    expect(scoreTechStack([]).score).toBe(15);
  });

  it("scores 10 for CRM only", () => {
    const result = scoreTechStack([{ name: "HubSpot", categories: ["CRM"] }]);
    expect(result.score).toBe(10);
    expect(result.has_crm).toBe(true);
    expect(result.has_engagement).toBe(false);
  });

  it("scores 5 for engagement tool without data tool", () => {
    const result = scoreTechStack([
      { name: "Outreach", categories: ["Sales Engagement"] },
      { name: "HubSpot", categories: ["CRM"] },
    ]);
    expect(result.score).toBe(5);
    expect(result.has_engagement).toBe(true);
    expect(result.has_data).toBe(false);
  });

  it("scores 0 for full outbound stack", () => {
    const result = scoreTechStack([
      { name: "Salesloft", categories: ["Sales Engagement"] },
      { name: "ZoomInfo", categories: ["Data"] },
      { name: "Salesforce", categories: ["CRM"] },
    ]);
    expect(result.score).toBe(0);
    expect(result.has_engagement).toBe(true);
    expect(result.has_data).toBe(true);
  });

  it("detects outbound tools", () => {
    const result = scoreTechStack([
      { name: "Apollo.io", categories: [] },
      { name: "Gong", categories: [] },
    ]);
    expect(result.outbound_tools.length).toBe(2);
  });
});

// ============================================================
// COMPOSITE TAM ICP
// ============================================================

describe("computeTamICP", () => {
  it("scores golden ICP correctly (K12 EdTech, 50 employees, 2 AEs, no SDRs, funded)", () => {
    const result = computeTamICP({
      sub_market: "K12 EdTech SaaS",
      employee_count: 50,
      annual_revenue: "$10M",
      funding_stage: "Series A",
      sales_team: team({ ae_count: 2 }),
      technologies: [],
    });

    expect(result.vertical_fit).toBe(35);
    expect(result.headcount).toBe(15);
    expect(result.company_stage).toBe(30);
    expect(result.outbound_need).toBe(50);
    expect(result.tech_stack).toBe(15);
    // funding varies by extraction but should be > 0
    expect(result.raw_total).toBeGreaterThan(140);
  });

  it("DQs companies with SDR teams", () => {
    const result = computeTamICP({
      sub_market: "K12 EdTech SaaS",
      employee_count: 50,
      sales_team: team({ sdr_count: 3, ae_count: 5 }),
    });
    expect(result.outbound_need).toBe(10);
    expect(result.outbound_pattern).toBe("has_sdr");
  });

  it("scores Higher Ed the same as K12 structurally", () => {
    const k12 = computeTamICP({
      sub_market: "K12 EdTech SaaS",
      employee_count: 50,
      sales_team: team({ ae_count: 2 }),
    });
    const higherEd = computeTamICP({
      sub_market: "Higher Ed",
      employee_count: 50,
      sales_team: team({ ae_count: 2 }),
    });

    // Same outbound need (50), headcount (15), tech stack (15)
    expect(k12.outbound_need).toBe(higherEd.outbound_need);
    expect(k12.headcount).toBe(higherEd.headcount);
    // Vertical fit differs: K12=35, Higher Ed=30
    expect(k12.vertical_fit).toBe(35);
    expect(higherEd.vertical_fit).toBe(30);
    // But both should be T1 with the right raw total
    expect(k12.raw_total).toBeGreaterThan(higherEd.raw_total);
  });
});

// ============================================================
// TIER ASSIGNMENT
// ============================================================

describe("tamTier", () => {
  it("T1 for raw >= 120", () => {
    expect(tamTier(120)).toBe("T1");
    expect(tamTier(175)).toBe("T1");
  });

  it("T2 for raw 80-119", () => {
    expect(tamTier(80)).toBe("T2");
    expect(tamTier(119)).toBe("T2");
  });

  it("T3 for raw 50-79", () => {
    expect(tamTier(50)).toBe("T3");
    expect(tamTier(79)).toBe("T3");
  });

  it("DQ for raw < 50", () => {
    expect(tamTier(49)).toBe("DQ");
    expect(tamTier(0)).toBe("DQ");
  });
});

// ============================================================
// SALES ORG SUMMARY
// ============================================================

describe("generateSalesOrgSummary", () => {
  it("generates summary for 2 AEs no SDRs", () => {
    const summary = generateSalesOrgSummary(team({
      ae_count: 2,
      sales_employees: [
        { name: "John Smith", title: "Account Executive" },
        { name: "Jane Doe", title: "Account Executive" },
      ],
    }));
    expect(summary).toContain("2 AEs");
    expect(summary).toContain("no SDRs");
    expect(summary).toContain("No active sales hiring");
  });

  it("generates summary for founder selling", () => {
    const summary = generateSalesOrgSummary(team({
      founder_selling: true,
      sales_employees: [{ name: "Bob CEO", title: "Founder & CEO" }],
    }));
    expect(summary).toContain("Founder selling");
    expect(summary).toContain("no SDRs");
  });

  it("includes hiring signals", () => {
    const summary = generateSalesOrgSummary(team({
      ae_count: 1,
      hiring_sdr: true,
      sales_employees: [{ name: "Single AE", title: "Account Executive" }],
    }));
    expect(summary).toContain("Hiring SDRs");
  });
});
