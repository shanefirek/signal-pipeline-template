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
  validateDomain,
  cleanDomain,
  cleanEmail,
  passesValidationGate,
  isEnterpriseDomain,
  isNotCustomer,
  passesSubMarketGate,
  passesCompanyPushGate,
  passesContactDiscoveryGate,
  isTitleBlocked,
  isInternalDomain,
  passesContactPushGate,
  passesContactUpdateGate,
  isMqlBuyerTitle,
  isMql,
} from "../lib/gates.js";

// ============================================================
// NORMALIZATION GATES
// ============================================================

describe("validateDomain", () => {
  it("rejects empty domains", () => {
    expect(validateDomain(null).valid).toBe(false);
    expect(validateDomain("").valid).toBe(false);
    expect(validateDomain("  ").valid).toBe(false);
  });

  it("rejects internal domains (all entries in INTERNAL_DOMAINS set)", () => {
    expect(validateDomain("acmegtm.com").valid).toBe(false);
    expect(validateDomain("acmegtm.com").reason).toBe("internal");
    expect(validateDomain("starbridge.ai").valid).toBe(false);
    expect(validateDomain("digital-made.com").valid).toBe(false);
    expect(validateDomain("octave.is").valid).toBe(false);
  });

  it("rejects .edu/.gov/.k12 domains", () => {
    expect(validateDomain("harvard.edu").valid).toBe(false);
    expect(validateDomain("whitehouse.gov").valid).toBe(false);
    expect(validateDomain("district.k12.tx.us").valid).toBe(false);
  });

  it("accepts valid B2B domains", () => {
    expect(validateDomain("exampleco.com").valid).toBe(true);
    expect(validateDomain("newsela.com").valid).toBe(true);
  });
});

describe("cleanDomain", () => {
  it("strips protocol and www", () => {
    expect(cleanDomain("https://www.exampleco.com")).toBe("exampleco.com");
    expect(cleanDomain("http://exampleco.com/")).toBe("exampleco.com");
  });

  it("strips paths, query params, fragments", () => {
    expect(cleanDomain("exampleco.com/pricing?ref=google#top")).toBe("exampleco.com");
  });

  it("handles null/undefined", () => {
    expect(cleanDomain(null)).toBe("");
    expect(cleanDomain(undefined)).toBe("");
  });
});

describe("cleanEmail", () => {
  it("handles Syft literal 'null' string", () => {
    expect(cleanEmail("null")).toBe("");
    expect(cleanEmail("NULL")).toBe("");
  });

  it("lowercases and trims", () => {
    expect(cleanEmail(" user@example.com ")).toBe("shane@acme.com");
  });

  it("handles null/undefined", () => {
    expect(cleanEmail(null)).toBe("");
  });
});

describe("passesValidationGate", () => {
  it("passes with page views > 0", () => {
    expect(passesValidationGate({ domain: "exampleco.com", page_views: 3 })).toBe(true);
  });

  it("passes with LinkedIn action", () => {
    expect(passesValidationGate({ domain: "exampleco.com", linkedin_action: "comment" })).toBe(true);
  });

  it("fails with 0 page views and no LinkedIn action", () => {
    expect(passesValidationGate({ domain: "exampleco.com", page_views: 0 })).toBe(false);
  });

  it("fails for invalid domain even with engagement", () => {
    expect(passesValidationGate({ domain: "acmegtm.com", page_views: 10 })).toBe(false);
    expect(passesValidationGate({ domain: "harvard.edu", page_views: 5 })).toBe(false);
  });
});

describe("isEnterpriseDomain", () => {
  it("blocks enterprise companies", () => {
    expect(isEnterpriseDomain("google.com")).toBe(true);
    expect(isEnterpriseDomain("salesforce.com")).toBe(true);
    expect(isEnterpriseDomain("microsoft.com")).toBe(true);
  });

  it("passes non-enterprise", () => {
    expect(isEnterpriseDomain("exampleco.com")).toBe(false);
  });
});

describe("isNotCustomer", () => {
  it("blocks customers", () => {
    expect(isNotCustomer("customer", false)).toBe(false);
  });

  it("blocks blocked domains", () => {
    expect(isNotCustomer(null, true)).toBe(false);
  });

  it("bypasses for deal-created source", () => {
    expect(isNotCustomer("customer", true, "hubspot_deal_created")).toBe(true);
  });

  it("passes for unknown lifecycle", () => {
    expect(isNotCustomer(null, false)).toBe(true);
    expect(isNotCustomer("lead", false)).toBe(true);
  });
});

// ============================================================
// COMPANY PROFILES GATES
// ============================================================

describe("passesSubMarketGate", () => {
  it("blocks Not B2B", () => {
    expect(passesSubMarketGate("Not B2B")).toBe(false);
    expect(passesSubMarketGate("Other B2B")).toBe(false);
  });

  it("blocks empty", () => {
    expect(passesSubMarketGate(null)).toBe(false);
    expect(passesSubMarketGate("")).toBe(false);
  });

  it("passes valid sub-markets", () => {
    expect(passesSubMarketGate("K12 EdTech SaaS")).toBe(true);
    expect(passesSubMarketGate("Higher Ed SaaS")).toBe(true);
  });
});

describe("passesCompanyPushGate", () => {
  const base = {
    domain: "exampleco.com",
    sub_market: "K12 EdTech SaaS",
    icp_score: 80,
    vertical_fit_score: 35,
    employee_count: 50,
  };

  it("passes for good K12 company", () => {
    expect(passesCompanyPushGate(base)).toBe(true);
  });

  it("fails for ICP < 50", () => {
    expect(passesCompanyPushGate({ ...base, icp_score: 40 })).toBe(false);
  });

  it("fails for 500+ employees", () => {
    expect(passesCompanyPushGate({ ...base, employee_count: 500 })).toBe(false);
  });

  it("fails for enterprise domain", () => {
    expect(passesCompanyPushGate({ ...base, domain: "google.com" })).toBe(false);
  });

  it("fails for Not B2B", () => {
    expect(passesCompanyPushGate({ ...base, sub_market: "Not B2B" })).toBe(false);
  });

  it("bypasses all gates for deal-created", () => {
    expect(passesCompanyPushGate({
      domain: "google.com", sub_market: null, icp_score: 0,
      vertical_fit_score: 0, employee_count: 100000, lead_source: "hubspot_deal_created",
    })).toBe(true);
  });
});

describe("passesContactDiscoveryGate", () => {
  it("passes for ICP >= 50 + vertical > 0 + < 500", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 50, vertical_fit_score: 35, employee_count: 50,
    })).toBe(true);
  });

  it("fails for ICP < 50", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 49, vertical_fit_score: 35, employee_count: 50,
    })).toBe(false);
  });

  it("fails for 500+ employees", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 80, vertical_fit_score: 35, employee_count: 500,
    })).toBe(false);
  });

  it("fails when has_sales_team is false (Carnegie pattern — 0 AEs, 0 SDRs, no hiring)", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 54, vertical_fit_score: 35, employee_count: 365, has_sales_team: false,
    })).toBe(false);
  });

  it("passes when has_sales_team is true", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 54, vertical_fit_score: 35, employee_count: 365, has_sales_team: true,
    })).toBe(true);
  });

  it("passes when has_sales_team is undefined (no data yet)", () => {
    expect(passesContactDiscoveryGate({
      icp_score: 54, vertical_fit_score: 35, employee_count: 365,
    })).toBe(true);
  });
});

// ============================================================
// CONTACT PROFILES GATES
// ============================================================

describe("isTitleBlocked", () => {
  it("blocks HR titles", () => {
    expect(isTitleBlocked("Chief Human Resources Officer")).toBe(true);
    expect(isTitleBlocked("CHRO")).toBe(true);
  });

  it("blocks marketing titles", () => {
    expect(isTitleBlocked("Chief Marketing Officer")).toBe(true);
    expect(isTitleBlocked("VP Marketing")).toBe(true);
  });

  it("blocks product titles", () => {
    expect(isTitleBlocked("Director of Product Management")).toBe(true);
    expect(isTitleBlocked("Chief Product Officer")).toBe(true);
    expect(isTitleBlocked("VP Product")).toBe(true);
    expect(isTitleBlocked("Product Manager")).toBe(true);
    expect(isTitleBlocked("Head of Product")).toBe(true);
  });

  it("blocks engineering titles", () => {
    expect(isTitleBlocked("CTO")).toBe(true);
    expect(isTitleBlocked("VP Engineering")).toBe(true);
    expect(isTitleBlocked("Director of Engineering")).toBe(true);
    expect(isTitleBlocked("Software Engineer")).toBe(true);
  });

  it("blocks ops/non-buyer titles", () => {
    expect(isTitleBlocked("Chief Operating Officer")).toBe(true);
    expect(isTitleBlocked("Chief Information Officer")).toBe(true);
    expect(isTitleBlocked("General Counsel")).toBe(true);
    expect(isTitleBlocked("Customer Success Manager")).toBe(true);
  });

  it("blocks SDR/BDR titles", () => {
    expect(isTitleBlocked("SDR Manager")).toBe(true);
    expect(isTitleBlocked("Business Development Representative")).toBe(true);
  });

  it("passes sales decision maker titles", () => {
    expect(isTitleBlocked("VP Sales")).toBe(false);
    expect(isTitleBlocked("CEO")).toBe(false);
    expect(isTitleBlocked("CRO")).toBe(false);
    expect(isTitleBlocked("Founder")).toBe(false);
    expect(isTitleBlocked("Co-Founder & CEO")).toBe(false);
    expect(isTitleBlocked("Head of Sales")).toBe(false);
    expect(isTitleBlocked("Chief Revenue Officer")).toBe(false);
    expect(isTitleBlocked("President")).toBe(false);
  });

  it("does NOT false-positive on director titles (cto substring bug)", () => {
    expect(isTitleBlocked("Director of Sales")).toBe(false);
    expect(isTitleBlocked("Sales Director")).toBe(false);
    expect(isTitleBlocked("Regional Director of Sales")).toBe(false);
    expect(isTitleBlocked("Senior Director of Sales")).toBe(false);
    expect(isTitleBlocked("K-12 Sales Director")).toBe(false);
    expect(isTitleBlocked("Managing Director")).toBe(false);
  });

  // Apr 15: New patterns added to close blocklist gaps
  describe("blocks developer titles (Apr 15 fix)", () => {
    it("Lead Developer → blocked", () => {
      expect(isTitleBlocked("Lead Developer")).toBe(true);
    });
    it("Software Developer → blocked", () => {
      expect(isTitleBlocked("Software Developer")).toBe(true);
    });
    it("Senior Developer → blocked", () => {
      expect(isTitleBlocked("Senior Developer")).toBe(true);
    });
    it("Full Stack Developer → blocked", () => {
      expect(isTitleBlocked("Full Stack Developer")).toBe(true);
    });
  });

  describe("blocks marketing director titles (Apr 15 fix)", () => {
    it("Director of Marketing → blocked", () => {
      expect(isTitleBlocked("Director of Marketing")).toBe(true);
    });
    it("Marketing Director → blocked", () => {
      expect(isTitleBlocked("Marketing Director")).toBe(true);
    });
    it("Senior Director of Marketing → blocked", () => {
      expect(isTitleBlocked("Senior Director of Marketing")).toBe(true);
    });
    it("Vice President Marketing → blocked", () => {
      expect(isTitleBlocked("Vice President Marketing")).toBe(true);
    });
  });

  describe("blocks creative titles (Apr 15 fix)", () => {
    it("Art Director → blocked", () => {
      expect(isTitleBlocked("Art Director")).toBe(true);
    });
    it("Creative Director → blocked", () => {
      expect(isTitleBlocked("Creative Director")).toBe(true);
    });
    it("Design Director → blocked", () => {
      expect(isTitleBlocked("Design Director")).toBe(true);
    });
  });

  describe("blocks curriculum/academic titles (Apr 15 fix)", () => {
    it("Senior Director of Mathematics → blocked", () => {
      expect(isTitleBlocked("Senior Director of Mathematics and Professional Development")).toBe(true);
    });
    it("Director of Curriculum → blocked", () => {
      expect(isTitleBlocked("Director of Curriculum")).toBe(true);
    });
    it("VP of Professional Development → blocked", () => {
      expect(isTitleBlocked("VP of Professional Development")).toBe(true);
    });
    it("Dean of Students → blocked", () => {
      expect(isTitleBlocked("Dean of Students")).toBe(true);
    });
    it("Provost → blocked", () => {
      expect(isTitleBlocked("Provost")).toBe(true);
    });
    it("Registrar → blocked", () => {
      expect(isTitleBlocked("University Registrar")).toBe(true);
    });
  });

  it("handles null", () => {
    expect(isTitleBlocked(null)).toBe(false);
  });
});

describe("isInternalDomain", () => {
  it("blocks internal domains", () => {
    expect(isInternalDomain("acmegtm.com")).toBe(true);
    expect(isInternalDomain("starbridge.ai")).toBe(true);
    expect(isInternalDomain("digital-made.com")).toBe(true);
    expect(isInternalDomain("octave.is")).toBe(true);
  });

  it("passes external domains", () => {
    expect(isInternalDomain("exampleco.com")).toBe(false);
    expect(isInternalDomain("fuzemee.com")).toBe(false); // RepB's former domain — blocked by employee check, not domain
  });
});

describe("passesContactPushGate", () => {
  const base = {
    email: "user@example.com",
    has_existing_hubspot_contact: false,
    domain: "exampleco.com",
    title: "CEO",
    icp_score: 80,
    lead_tier: "hot" as string,
    lead_source: "syft_website" as string,
    vertical_fit_score: 35,
    sub_market: "K12 EdTech SaaS" as string,  // SLED sub_market required
  };

  it("passes for hot lead with email and SLED sub_market", () => {
    expect(passesContactPushGate(base)).toBe(true);
  });

  it("fails without email", () => {
    expect(passesContactPushGate({ ...base, email: null })).toBe(false);
  });

  it("fails if already in HubSpot", () => {
    expect(passesContactPushGate({ ...base, has_existing_hubspot_contact: true })).toBe(false);
  });

  it("fails for blocked title", () => {
    expect(passesContactPushGate({ ...base, title: "CHRO" })).toBe(false);
  });

  it("fails for ICP < 50", () => {
    expect(passesContactPushGate({ ...base, icp_score: 40 })).toBe(false);
  });

  it("passes company_discovery with vertical fit > 0", () => {
    expect(passesContactPushGate({
      ...base, lead_tier: "cool", lead_source: "company_discovery",
    })).toBe(true);
  });

  it("fails cold lead without company_discovery", () => {
    expect(passesContactPushGate({
      ...base, lead_tier: "cold", lead_source: "syft_website",
    })).toBe(false);
  });

  // Apr 15: SLED-only gate (K12, Higher Ed, Government)
  describe("SLED sub_market gate (Apr 15 fix)", () => {
    it("passes K12 EdTech SaaS", () => {
      expect(passesContactPushGate({ ...base, sub_market: "K12 EdTech SaaS" })).toBe(true);
    });
    it("passes Higher Ed", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Higher Ed" })).toBe(true);
    });
    it("passes Higher Ed SaaS", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Higher Ed SaaS" })).toBe(true);
    });
    it("passes Government & Public Sector", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Government & Public Sector" })).toBe(true);
    });
    it("blocks Financial Services", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Financial Services" })).toBe(false);
    });
    it("blocks Non-profit", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Non-profit" })).toBe(false);
    });
    it("blocks Other B2B", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Other B2B" })).toBe(false);
    });
    it("blocks Not B2B", () => {
      expect(passesContactPushGate({ ...base, sub_market: "Not B2B" })).toBe(false);
    });
    it("blocks null sub_market", () => {
      expect(passesContactPushGate({ ...base, sub_market: null })).toBe(false);
    });
    it("blocks undefined sub_market", () => {
      expect(passesContactPushGate({ ...base, sub_market: undefined })).toBe(false);
    });
  });

  // Apr 15: Geo gate tests (US/CA only)
  describe("geo gate (Apr 15 fix)", () => {
    it("passes US country", () => {
      expect(passesContactPushGate({ ...base, country: "US" })).toBe(true);
    });
    it("passes USA country", () => {
      expect(passesContactPushGate({ ...base, country: "USA" })).toBe(true);
    });
    it("passes United States country", () => {
      expect(passesContactPushGate({ ...base, country: "United States" })).toBe(true);
    });
    it("passes CA (Canada) country", () => {
      expect(passesContactPushGate({ ...base, country: "CA" })).toBe(true);
    });
    it("passes Canada country", () => {
      expect(passesContactPushGate({ ...base, country: "Canada" })).toBe(true);
    });
    it("blocks UK country", () => {
      expect(passesContactPushGate({ ...base, country: "GB" })).toBe(false);
    });
    it("blocks India country", () => {
      expect(passesContactPushGate({ ...base, country: "IN" })).toBe(false);
    });
    it("blocks Hong Kong country", () => {
      expect(passesContactPushGate({ ...base, country: "HK" })).toBe(false);
    });
    it("passes null country (backwards compat)", () => {
      expect(passesContactPushGate({ ...base, country: null })).toBe(true);
    });
    it("passes undefined country (backwards compat)", () => {
      expect(passesContactPushGate({ ...base })).toBe(true);  // country not specified
    });
  });
});

describe("passesContactUpdateGate", () => {
  const base = {
    hubspot_contact_id: "12345",
    domain: "exampleco.com",
    title: "CEO",
    icp_score: 80,
    lead_tier: "hot" as string,
    lead_source: "syft_website" as string,
    vertical_fit_score: 35,
    needs_refresh: false,
  };

  it("passes for hot lead with HubSpot ID", () => {
    expect(passesContactUpdateGate(base)).toBe(true);
  });

  it("fails without HubSpot ID", () => {
    expect(passesContactUpdateGate({ ...base, hubspot_contact_id: null })).toBe(false);
  });

  it("always passes if needs_refresh + has ID", () => {
    expect(passesContactUpdateGate({
      ...base, needs_refresh: true, lead_tier: "cold", icp_score: 10,
    })).toBe(true);
  });
});

// ============================================================
// MQL BUYER TITLE ALLOWLIST (Apr 15)
// ============================================================

describe("isMqlBuyerTitle", () => {
  describe("allows executive leadership", () => {
    it("CEO → allowed", () => expect(isMqlBuyerTitle("CEO")).toBe(true));
    it("Chief Executive Officer → allowed", () => expect(isMqlBuyerTitle("Chief Executive Officer")).toBe(true));
    it("Founder → allowed", () => expect(isMqlBuyerTitle("Founder")).toBe(true));
    it("Co-Founder & CEO → allowed", () => expect(isMqlBuyerTitle("Co-Founder & CEO")).toBe(true));
    it("President → allowed", () => expect(isMqlBuyerTitle("President")).toBe(true));
    it("Owner → allowed", () => expect(isMqlBuyerTitle("Owner")).toBe(true));
    it("COO → allowed", () => expect(isMqlBuyerTitle("COO")).toBe(true));
    it("CRO → allowed", () => expect(isMqlBuyerTitle("CRO")).toBe(true));
    it("Chief Revenue Officer → allowed", () => expect(isMqlBuyerTitle("Chief Revenue Officer")).toBe(true));
  });

  describe("allows sales leadership", () => {
    it("VP Sales → allowed", () => expect(isMqlBuyerTitle("VP Sales")).toBe(true));
    it("VP of Sales → allowed", () => expect(isMqlBuyerTitle("VP of Sales")).toBe(true));
    it("Vice President of Sales → allowed", () => expect(isMqlBuyerTitle("Vice President of Sales")).toBe(true));
    it("Head of Sales → allowed", () => expect(isMqlBuyerTitle("Head of Sales")).toBe(true));
    it("Sales Director → allowed", () => expect(isMqlBuyerTitle("Sales Director")).toBe(true));
    it("Director of Sales → allowed", () => expect(isMqlBuyerTitle("Director of Sales")).toBe(true));
    it("SVP Sales → allowed", () => expect(isMqlBuyerTitle("SVP Sales")).toBe(true));
    it("Managing Director → allowed", () => expect(isMqlBuyerTitle("Managing Director")).toBe(true));
    it("General Manager → allowed", () => expect(isMqlBuyerTitle("General Manager")).toBe(true));
  });

  describe("blocks non-buyer titles", () => {
    it("CTO → blocked", () => expect(isMqlBuyerTitle("CTO")).toBe(false));
    it("CFO → blocked", () => expect(isMqlBuyerTitle("CFO")).toBe(false));
    it("CMO → blocked", () => expect(isMqlBuyerTitle("CMO")).toBe(false));
    it("VP Marketing → blocked", () => expect(isMqlBuyerTitle("VP Marketing")).toBe(false));
    it("VP Engineering → blocked", () => expect(isMqlBuyerTitle("VP Engineering")).toBe(false));
    it("Director of Marketing → blocked", () => expect(isMqlBuyerTitle("Director of Marketing")).toBe(false));
    it("Director of Mathematics → blocked", () => expect(isMqlBuyerTitle("Senior Director of Mathematics")).toBe(false));
    it("Software Engineer → blocked", () => expect(isMqlBuyerTitle("Software Engineer")).toBe(false));
    it("SDR Manager → blocked", () => expect(isMqlBuyerTitle("SDR Manager")).toBe(false));
    it("Account Executive → blocked", () => expect(isMqlBuyerTitle("Account Executive")).toBe(false));
  });

  it("handles null", () => expect(isMqlBuyerTitle(null)).toBe(false));
});

describe("isMql", () => {
  const base = {
    lead_type: "inbound" as string,
    lead_tier: "hot" as string,
    title: "CEO" as string,
    sub_market: "K12 EdTech SaaS" as string,
  };

  it("passes for inbound + hot + CEO + SLED", () => {
    expect(isMql(base)).toBe(true);
  });

  it("passes for inbound + warm + VP Sales + SLED", () => {
    expect(isMql({ ...base, lead_tier: "warm", title: "VP Sales" })).toBe(true);
  });

  it("fails for outbound", () => {
    expect(isMql({ ...base, lead_type: "outbound" })).toBe(false);
  });

  it("fails for cold tier", () => {
    expect(isMql({ ...base, lead_tier: "cold" })).toBe(false);
  });

  it("fails for non-buyer title", () => {
    expect(isMql({ ...base, title: "Senior Director of Mathematics" })).toBe(false);
  });

  it("fails for non-SLED sub_market", () => {
    expect(isMql({ ...base, sub_market: "Financial Services" })).toBe(false);
  });

  it("passes without sub_market (backwards compat)", () => {
    expect(isMql({ ...base, sub_market: null })).toBe(true);
  });
});
