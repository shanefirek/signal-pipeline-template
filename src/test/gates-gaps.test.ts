import { describe, it, expect, vi } from "vitest";

// Mock supabase before importing gates (gates.ts imports supabase.ts at top level)
vi.mock("../lib/supabase.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  },
}));

import {
  passesContactPushGate,
  passesCompanyPushGate,
  cleanDomain,
  cleanEmail,
  validateDomain,
} from "../lib/gates.js";

// Tests specific to gap fixes (existing gates + edge cases found during V2 audit)

describe("passesContactPushGate — tier handling", () => {
  const baseContact = {
    email: "john@acme.com",
    has_existing_hubspot_contact: false,
    domain: "acme.com",
    title: "VP Sales",
    icp_score: 80,
    vertical_fit_score: 7,
    lead_source: "syft_website",
    sub_market: "K12 EdTech SaaS",  // SLED sub_market required
  };

  it("Hot tier passes", () => {
    expect(passesContactPushGate({ ...baseContact, lead_tier: "Hot" })).toBe(true);
    expect(passesContactPushGate({ ...baseContact, lead_tier: "hot" })).toBe(true);
  });

  it("Warm tier passes", () => {
    expect(passesContactPushGate({ ...baseContact, lead_tier: "Warm" })).toBe(true);
    expect(passesContactPushGate({ ...baseContact, lead_tier: "warm" })).toBe(true);
  });

  it("Cool tier blocks (unless company_discovery)", () => {
    expect(passesContactPushGate({ ...baseContact, lead_tier: "Cool" })).toBe(false);
    expect(passesContactPushGate({ ...baseContact, lead_tier: "cool" })).toBe(false);
  });

  it("Cold tier blocks", () => {
    expect(passesContactPushGate({ ...baseContact, lead_tier: "Cold" })).toBe(false);
  });

  it("company_discovery + vertical_fit > 0 passes even for cool", () => {
    expect(passesContactPushGate({
      ...baseContact,
      lead_tier: "cool",
      lead_source: "company_discovery",
      vertical_fit_score: 5,
    })).toBe(true);
  });

  it("blocks existing HubSpot contacts (create-only)", () => {
    expect(passesContactPushGate({
      ...baseContact,
      lead_tier: "Hot",
      has_existing_hubspot_contact: true,
    })).toBe(false);
  });

  it("blocks contacts without email", () => {
    expect(passesContactPushGate({
      ...baseContact,
      lead_tier: "Hot",
      email: null,
    })).toBe(false);
    expect(passesContactPushGate({
      ...baseContact,
      lead_tier: "Hot",
      email: "",
    })).toBe(false);
  });

  it("blocks low ICP even if Hot", () => {
    expect(passesContactPushGate({
      ...baseContact,
      lead_tier: "Hot",
      icp_score: 40,
    })).toBe(false);
  });
});

describe("cleanEmail — Syft null handling", () => {
  it("converts literal 'null' string to empty", () => {
    expect(cleanEmail("null")).toBe("");
    expect(cleanEmail("NULL")).toBe("");
  });

  it("trims and lowercases", () => {
    expect(cleanEmail("  John@Acme.COM  ")).toBe("john@acme.com");
  });

  it("handles actual null/undefined", () => {
    expect(cleanEmail(null)).toBe("");
    expect(cleanEmail(undefined)).toBe("");
  });
});

describe("cleanDomain", () => {
  it("strips protocol and www", () => {
    expect(cleanDomain("https://www.acme.com")).toBe("acme.com");
    expect(cleanDomain("http://acme.com")).toBe("acme.com");
  });

  it("strips paths and query params", () => {
    expect(cleanDomain("acme.com/about?ref=google")).toBe("acme.com");
    expect(cleanDomain("acme.com/path/to/page#section")).toBe("acme.com");
  });

  it("lowercases", () => {
    expect(cleanDomain("ACME.COM")).toBe("acme.com");
  });
});

describe("validateDomain — blocked patterns", () => {
  it("blocks .edu domains", () => {
    expect(validateDomain("harvard.edu").valid).toBe(false);
    expect(validateDomain("harvard.edu").reason).toBe("edu_domain");
  });

  it("blocks .gov domains", () => {
    expect(validateDomain("whitehouse.gov").valid).toBe(false);
  });

  it("blocks .k12 domains", () => {
    expect(validateDomain("mesa.k12.co.us").valid).toBe(false);
  });

  it("blocks internal domain", () => {
    expect(validateDomain("acmegtm.com").valid).toBe(false);
  });

  it("passes valid B2B domains", () => {
    expect(validateDomain("acme.com").valid).toBe(true);
    expect(validateDomain("brightbee.io").valid).toBe(true);
  });
});

describe("passesCompanyPushGate", () => {
  const baseCompany = {
    domain: "acme.com",
    sub_market: "K-12 EdTech SaaS",
    icp_score: 80,
    vertical_fit_score: 7,
    employee_count: 50,
  };

  it("passes for good ICP company", () => {
    expect(passesCompanyPushGate(baseCompany)).toBe(true);
  });

  it("blocks Not B2B", () => {
    expect(passesCompanyPushGate({ ...baseCompany, sub_market: "Not B2B" })).toBe(false);
  });

  it("blocks low ICP", () => {
    expect(passesCompanyPushGate({ ...baseCompany, icp_score: 30 })).toBe(false);
  });

  it("blocks 500+ employees", () => {
    expect(passesCompanyPushGate({ ...baseCompany, employee_count: 500 })).toBe(false);
  });

  it("hubspot_deal_created always passes", () => {
    expect(passesCompanyPushGate({
      ...baseCompany,
      icp_score: 0,
      sub_market: "Not B2B",
      lead_source: "hubspot_deal_created",
    })).toBe(true);
  });
});
