import { describe, it, expect } from "vitest";
import { extractFunding, normalizeFundingStage, scoreFunding, toHubSpotFundingStage, type FundingRound } from "../lib/funding.js";

// Real crunchBaseFunding responses (verified Mar 14)
const NEARPOD_FUNDING: FundingRound[] = [
  {
    roundName: "Series B",
    roundAmount: 21000000,
    roundDate: "2017-08-14",
    investorNames: ["Insight Partners"],
    investorCount: 1,
    fundingRoundCount: 3,
  },
  {
    roundName: "Series A",
    roundAmount: 9200000,
    roundDate: "2015-11-17",
    investorNames: [],
    investorCount: 0,
    fundingRoundCount: 3,
  },
  {
    roundName: "Seed",
    roundAmount: 1000000,
    roundDate: "2014-01-01",
    investorNames: [],
    investorCount: 0,
    fundingRoundCount: 3,
  },
];

const NEWSELA_FUNDING: FundingRound[] = [
  {
    roundName: "Series D",
    roundAmount: 100000000,
    roundDate: "2021-02-18",
    investorNames: ["TCV", "Franklin Templeton"],
    investorCount: 2,
    fundingRoundCount: 5,
  },
  {
    roundName: "Series C",
    roundAmount: 50000000,
    roundDate: "2019-09-18",
    investorNames: ["TCV"],
    investorCount: 1,
    fundingRoundCount: 5,
  },
];

const SECURLY_FUNDING: FundingRound[] = [
  {
    roundName: "Series B",
    roundAmount: 16000000,
    roundDate: "2019-05-28",
    investorNames: ["Defy.vc"],
    investorCount: 1,
    fundingRoundCount: 2,
  },
];

describe("extractFunding", () => {
  it("extracts latest round from exampleco (Series B)", () => {
    const result = extractFunding(NEARPOD_FUNDING);
    expect(result.funding_stage).toBe("Series B");
    expect(result.funding_total).toBe(21000000);
    expect(result.funding_date).toBe("2017-08-14");
    expect(result.investors).toEqual(["Insight Partners"]);
    expect(result.funding_round_count).toBe(3);
  });

  it("extracts latest round from Newsela (Series D)", () => {
    const result = extractFunding(NEWSELA_FUNDING);
    expect(result.funding_stage).toBe("Series D");
    expect(result.funding_total).toBe(100000000);
    expect(result.investors).toEqual(["TCV", "Franklin Templeton"]);
  });

  it("extracts latest round from Securly (Series B)", () => {
    const result = extractFunding(SECURLY_FUNDING);
    expect(result.funding_stage).toBe("Series B");
    expect(result.funding_total).toBe(16000000);
    expect(result.investors).toEqual(["Defy.vc"]);
  });

  it("returns empty for null/undefined/empty", () => {
    expect(extractFunding(null)).toEqual({
      funding_stage: null, funding_total: null, funding_date: null,
      investors: [], funding_round_count: 0,
    });
    expect(extractFunding(undefined)).toEqual({
      funding_stage: null, funding_total: null, funding_date: null,
      investors: [], funding_round_count: 0,
    });
    expect(extractFunding([])).toEqual({
      funding_stage: null, funding_total: null, funding_date: null,
      investors: [], funding_round_count: 0,
    });
  });

  it("handles rounds with missing dates", () => {
    const rounds: FundingRound[] = [
      { roundName: "Seed", roundAmount: 500000, roundDate: null, investorNames: [], investorCount: 0, fundingRoundCount: 2 },
      { roundName: "Series A", roundAmount: 5000000, roundDate: "2023-01-15", investorNames: ["Acme VC"], investorCount: 1, fundingRoundCount: 2 },
    ];
    const result = extractFunding(rounds);
    // Series A has a date so it sorts first
    expect(result.funding_stage).toBe("Series A");
    expect(result.funding_total).toBe(5000000);
  });

  it("handles single round with null amount", () => {
    const rounds: FundingRound[] = [
      { roundName: "Angel", roundAmount: null, roundDate: "2024-06-01", investorNames: ["Jane Doe"], investorCount: 1, fundingRoundCount: 1 },
    ];
    const result = extractFunding(rounds);
    expect(result.funding_stage).toBe("Angel");
    expect(result.funding_total).toBeNull();
    expect(result.investors).toEqual(["Jane Doe"]);
  });
});

describe("normalizeFundingStage", () => {
  it("normalizes standard round names", () => {
    expect(normalizeFundingStage("Series A")).toBe("Series A");
    expect(normalizeFundingStage("Series B")).toBe("Series B");
    expect(normalizeFundingStage("Seed")).toBe("Seed");
    expect(normalizeFundingStage("Angel")).toBe("Angel");
  });

  it("normalizes variants", () => {
    expect(normalizeFundingStage("Pre-Seed")).toBe("Pre-Seed");
    expect(normalizeFundingStage("pre seed round")).toBe("Pre-Seed");
    expect(normalizeFundingStage("seed round")).toBe("Seed");
    expect(normalizeFundingStage("series a - extension")).toBe("Series A");
  });

  it("handles null/undefined", () => {
    expect(normalizeFundingStage(null)).toBeNull();
    expect(normalizeFundingStage(undefined)).toBeNull();
  });

  it("passes through unknown stages", () => {
    expect(normalizeFundingStage("Convertible Note")).toBe("Convertible Note");
  });
});

describe("scoreFunding", () => {
  it("scores Series A highest (sweet spot)", () => {
    expect(scoreFunding("Series A")).toBe(30);
  });

  it("scores Series B high", () => {
    expect(scoreFunding("Series B")).toBe(25);
  });

  it("scores Seed moderate", () => {
    expect(scoreFunding("Seed")).toBe(15);
  });

  it("scores late stage low", () => {
    expect(scoreFunding("Series C")).toBe(10);
    expect(scoreFunding("Series D")).toBe(10);
  });

  it("gives benefit of doubt for no data", () => {
    expect(scoreFunding(null)).toBe(5);
    expect(scoreFunding(undefined)).toBe(5);
  });

  it("scores IPO/PE low", () => {
    expect(scoreFunding("IPO")).toBe(5);
    expect(scoreFunding("Private Equity")).toBe(5);
  });
});

describe("toHubSpotFundingStage", () => {
  it("maps all canonical stages to HubSpot enums", () => {
    expect(toHubSpotFundingStage("Seed")).toBe("seed");
    expect(toHubSpotFundingStage("Pre-Seed")).toBe("seed");
    expect(toHubSpotFundingStage("Angel")).toBe("angel");
    expect(toHubSpotFundingStage("Series A")).toBe("series_a");
    expect(toHubSpotFundingStage("Series B")).toBe("series_b");
    expect(toHubSpotFundingStage("Series C")).toBe("series_c");
    expect(toHubSpotFundingStage("Series D")).toBe("series_d+");
    expect(toHubSpotFundingStage("Series E")).toBe("series_d+");
    expect(toHubSpotFundingStage("Series F")).toBe("series_d+");
    expect(toHubSpotFundingStage("Private Equity")).toBe("pe_backed");
    expect(toHubSpotFundingStage("PE")).toBe("pe_backed");
    expect(toHubSpotFundingStage("Bootstrapped")).toBe("bootstrapped");
  });

  it("is case insensitive", () => {
    expect(toHubSpotFundingStage("series a")).toBe("series_a");
    expect(toHubSpotFundingStage("SEED")).toBe("seed");
    expect(toHubSpotFundingStage("private equity")).toBe("pe_backed");
  });

  it("returns undefined for unmapped stages", () => {
    expect(toHubSpotFundingStage("IPO")).toBeUndefined();
    expect(toHubSpotFundingStage("Debt")).toBeUndefined();
    expect(toHubSpotFundingStage("Grant")).toBeUndefined();
    expect(toHubSpotFundingStage("Corporate Round")).toBeUndefined();
    expect(toHubSpotFundingStage("Venture Round")).toBeUndefined();
  });

  it("returns undefined for null/undefined", () => {
    expect(toHubSpotFundingStage(null)).toBeUndefined();
    expect(toHubSpotFundingStage(undefined)).toBeUndefined();
  });
});
