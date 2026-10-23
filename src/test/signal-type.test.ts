// Tests for getSignalType + deriveLeadOrigin
//
// Rule: signal_type holds a real signal event name when the source is signal-
// driven, or NULL otherwise. Never "Unknown" — that placeholder destroyed
// attribution for RepA's MQL queue (see Apr 7 handoff + memory/feedback_mql_tam_distinction.md).

import { describe, it, expect } from "vitest";
import { getSignalType, deriveLeadOrigin, deriveLeadType, deriveAeOwner, isMQL, MQL_LIFECYCLE_STAGE } from "../lib/constants.js";

describe("getSignalType", () => {
  describe("signal-driven sources return real signal type", () => {
    it("syft_website → Company Intent", () => {
      expect(getSignalType("syft_website")).toBe("Company Intent");
    });
    it("syft_linkedin → LinkedIn Engagement", () => {
      expect(getSignalType("syft_linkedin")).toBe("LinkedIn Engagement");
    });
    it("hubspot_deal_created → Deal Created", () => {
      expect(getSignalType("hubspot_deal_created")).toBe("Deal Created");
    });
    it("company_discovery → Company Intent", () => {
      expect(getSignalType("company_discovery")).toBe("Company Intent");
    });
    it("fibbler_engagement → LinkedIn Engagement", () => {
      expect(getSignalType("fibbler_engagement")).toBe("LinkedIn Engagement");
    });
  });

  describe("non-signal sources return null (never 'Unknown')", () => {
    it("tam_import → null", () => {
      expect(getSignalType("tam_import")).toBeNull();
    });
    it("hubspot_backfill → null", () => {
      expect(getSignalType("hubspot_backfill")).toBeNull();
    });
    it("null input → null", () => {
      expect(getSignalType(null)).toBeNull();
    });
    it("undefined input → null", () => {
      expect(getSignalType(undefined)).toBeNull();
    });
    it("unknown future source → null (never 'Unknown')", () => {
      expect(getSignalType("some_future_source")).toBeNull();
      expect(getSignalType("starbridge_referral")).toBeNull();
      expect(getSignalType("salesnav_import")).toBeNull();
    });
  });

  it("NEVER returns the string 'Unknown' for any input", () => {
    const inputs = [
      null,
      undefined,
      "",
      "tam_import",
      "hubspot_backfill",
      "starbridge_referral",
      "salesnav_import",
      "garbage",
      "random_123",
    ];
    for (const input of inputs) {
      expect(getSignalType(input)).not.toBe("Unknown");
    }
  });
});

describe("deriveLeadOrigin (regression — should not change)", () => {
  it("tam_import → TAM Outbound", () => {
    expect(deriveLeadOrigin("tam_import")).toBe("TAM Outbound");
  });
  it("syft_website → Website Visitor", () => {
    expect(deriveLeadOrigin("syft_website")).toBe("Website Visitor");
  });
  it("hubspot_backfill → HubSpot Backfill", () => {
    expect(deriveLeadOrigin("hubspot_backfill")).toBe("HubSpot Backfill");
  });
  it("unknown default → V2 Enriched", () => {
    expect(deriveLeadOrigin("garbage")).toBe("V2 Enriched");
    expect(deriveLeadOrigin(null)).toBe("V2 Enriched");
  });
});

describe("contract pairing — getSignalType + deriveLeadOrigin together", () => {
  it("tam_import: signal_type=null AND lead_origin=TAM Outbound (attribution via lead_origin)", () => {
    expect(getSignalType("tam_import")).toBeNull();
    expect(deriveLeadOrigin("tam_import")).toBe("TAM Outbound");
  });
  it("syft_website: both fields populated (signal-driven, full attribution)", () => {
    expect(getSignalType("syft_website")).toBe("Company Intent");
    expect(deriveLeadOrigin("syft_website")).toBe("Website Visitor");
  });
  it("hubspot_backfill: signal_type=null AND lead_origin=HubSpot Backfill", () => {
    expect(getSignalType("hubspot_backfill")).toBeNull();
    expect(deriveLeadOrigin("hubspot_backfill")).toBe("HubSpot Backfill");
  });
});

describe("deriveLeadType", () => {
  describe("inbound sources", () => {
    it("syft_website → inbound", () => {
      expect(deriveLeadType("syft_website")).toBe("inbound");
    });
    it("syft_linkedin → inbound", () => {
      expect(deriveLeadType("syft_linkedin")).toBe("inbound");
    });
    it("fibbler_engagement → inbound", () => {
      expect(deriveLeadType("fibbler_engagement")).toBe("inbound");
    });
    it("company_discovery → inbound", () => {
      expect(deriveLeadType("company_discovery")).toBe("inbound");
    });
    it("posthog_identify → inbound", () => {
      expect(deriveLeadType("posthog_identify")).toBe("inbound");
    });
  });

  describe("outbound sources", () => {
    it("tam_import → outbound", () => {
      expect(deriveLeadType("tam_import")).toBe("outbound");
    });
  });

  describe("referral sources", () => {
    it("salesnav_import → referral", () => {
      expect(deriveLeadType("salesnav_import")).toBe("referral");
    });
    it("starbridge_referral → referral", () => {
      expect(deriveLeadType("starbridge_referral")).toBe("referral");
    });
  });

  describe("unknown sources", () => {
    it("null → unknown", () => {
      expect(deriveLeadType(null)).toBe("unknown");
    });
    it("undefined → unknown", () => {
      expect(deriveLeadType(undefined)).toBe("unknown");
    });
    it("hubspot_backfill → unknown", () => {
      expect(deriveLeadType("hubspot_backfill")).toBe("unknown");
    });
    it("random string → unknown", () => {
      expect(deriveLeadType("garbage")).toBe("unknown");
    });
  });
});

describe("deriveAeOwner", () => {
  describe("RepA gets K12 EdTech (canonical values)", () => {
    it("K12 EdTech SaaS (canonical) → rep_a", () => {
      expect(deriveAeOwner("K12 EdTech SaaS")).toBe("rep_a");
    });
    it("K-12 legacy value → rep_a (fallback)", () => {
      expect(deriveAeOwner("K-12 Education")).toBe("rep_a");
    });
    it("k12 lowercase → rep_a (fallback)", () => {
      expect(deriveAeOwner("k12 schools")).toBe("rep_a");
    });
  });

  describe("RepB gets Higher Ed (canonical values)", () => {
    it("Higher Ed (canonical) → rep_b", () => {
      expect(deriveAeOwner("Higher Ed")).toBe("rep_b");
    });
    it("Higher Education legacy → rep_b (fallback)", () => {
      expect(deriveAeOwner("Higher Education")).toBe("rep_b");
    });
  });

  describe("RepB gets Government (canonical values)", () => {
    it("Government & Public Sector (canonical) → rep_b", () => {
      expect(deriveAeOwner("Government & Public Sector")).toBe("rep_b");
    });
  });

  describe("null for non-SLED or unknown", () => {
    it("null input → null", () => {
      expect(deriveAeOwner(null)).toBeNull();
    });
    it("undefined input → null", () => {
      expect(deriveAeOwner(undefined)).toBeNull();
    });
    it("B2B SaaS → null", () => {
      expect(deriveAeOwner("B2B SaaS")).toBeNull();
    });
    it("Healthcare → null", () => {
      expect(deriveAeOwner("Healthcare")).toBeNull();
    });
    it("Cannot Determine → null", () => {
      expect(deriveAeOwner("Cannot Determine")).toBeNull();
    });
    it("Local Business SaaS → null (no false positive on 'local')", () => {
      expect(deriveAeOwner("Local Business SaaS")).toBeNull();
    });
    it("State-Regulated Financial → null (no false positive on 'state')", () => {
      expect(deriveAeOwner("State-Regulated Financial")).toBeNull();
    });
  });
});

describe("isMQL", () => {
  describe("inbound + qualified tier + intent = MQL", () => {
    it("syft_website + hot + intent → true", () => {
      expect(isMQL("syft_website", "hot", 40)).toBe(true);
    });
    it("syft_website + warm + intent → true", () => {
      expect(isMQL("syft_website", "warm", 15)).toBe(true);
    });
    it("syft_linkedin + hot + intent → true", () => {
      expect(isMQL("syft_linkedin", "hot", 30)).toBe(true);
    });
    it("company_discovery + hot + intent → true", () => {
      expect(isMQL("company_discovery", "hot", 20)).toBe(true);
    });
  });

  describe("inbound + qualified tier + NO intent = NOT MQL", () => {
    it("syft_website + hot + zero intent → false", () => {
      expect(isMQL("syft_website", "hot", 0)).toBe(false);
    });
    it("syft_website + warm + null intent → false", () => {
      expect(isMQL("syft_website", "warm", null)).toBe(false);
    });
    it("syft_website + hot + undefined intent → false", () => {
      expect(isMQL("syft_website", "hot", undefined)).toBe(false);
    });
    it("syft_linkedin + warm + zero intent → false (ICP-only warm)", () => {
      expect(isMQL("syft_linkedin", "warm", 0)).toBe(false);
    });
  });

  describe("inbound + unqualified tier = NOT MQL", () => {
    it("syft_website + cool → false", () => {
      expect(isMQL("syft_website", "cool", 40)).toBe(false);
    });
    it("syft_website + cold → false", () => {
      expect(isMQL("syft_website", "cold", 40)).toBe(false);
    });
  });

  describe("outbound = NEVER MQL (regardless of tier or intent)", () => {
    it("tam_import + hot + intent → false", () => {
      expect(isMQL("tam_import", "hot", 40)).toBe(false);
    });
    it("tam_import + warm + intent → false", () => {
      expect(isMQL("tam_import", "warm", 30)).toBe(false);
    });
    it("departed_follow + hot + intent → false", () => {
      expect(isMQL("departed_follow", "hot", 40)).toBe(false);
    });
  });

  describe("backfill/unknown = NOT MQL", () => {
    it("hubspot_backfill + hot + intent → false", () => {
      expect(isMQL("hubspot_backfill", "hot", 40)).toBe(false);
    });
    it("null source + hot → false", () => {
      expect(isMQL(null, "hot", 40)).toBe(false);
    });
    it("undefined source + warm → false", () => {
      expect(isMQL(undefined, "warm", 30)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("null tier → false", () => {
      expect(isMQL("syft_website", null, 40)).toBe(false);
    });
    it("undefined tier → false", () => {
      expect(isMQL("syft_website", undefined, 40)).toBe(false);
    });
    it("both null → false", () => {
      expect(isMQL(null, null, null)).toBe(false);
    });
  });
});

describe("MQL_LIFECYCLE_STAGE", () => {
  it("is marketingqualifiedlead", () => {
    expect(MQL_LIFECYCLE_STAGE).toBe("marketingqualifiedlead");
  });
});
