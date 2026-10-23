import { describe, it, expect } from "vitest";
import { domainsMatch } from "../enrichment/providers/cargo.js";

describe("domainsMatch", () => {
  describe("exact matches", () => {
    it("matches identical domains", () => {
      expect(domainsMatch("zearn.org", "zearn.org")).toBe(true);
    });

    it("matches with different case", () => {
      expect(domainsMatch("Zearn.org", "zearn.ORG")).toBe(true);
    });
  });

  describe("subdomain stripping", () => {
    it("matches www prefix", () => {
      expect(domainsMatch("www.zearn.org", "zearn.org")).toBe(true);
    });

    it("matches about prefix", () => {
      expect(domainsMatch("about.zearn.org", "zearn.org")).toBe(true);
    });

    it("matches get prefix", () => {
      expect(domainsMatch("get.vitalsource.com", "vitalsource.com")).toBe(true);
    });

    it("matches my prefix", () => {
      expect(domainsMatch("my.company.com", "company.com")).toBe(true);
    });

    it("matches app prefix", () => {
      expect(domainsMatch("app.company.com", "company.com")).toBe(true);
    });

    it("matches go prefix", () => {
      expect(domainsMatch("go.company.com", "company.com")).toBe(true);
    });

    it("matches hi prefix", () => {
      expect(domainsMatch("hi.fiveable.me", "fiveable.me")).toBe(true);
    });

    it("matches learn prefix", () => {
      expect(domainsMatch("learn.company.com", "company.com")).toBe(true);
    });

    it("matches jobs prefix", () => {
      expect(domainsMatch("jobs.company.com", "company.com")).toBe(true);
    });

    it("matches partners prefix", () => {
      expect(domainsMatch("partners.company.com", "company.com")).toBe(true);
    });

    it("matches link prefix", () => {
      expect(domainsMatch("link.company.com", "company.com")).toBe(true);
    });
  });

  describe("TLD variations", () => {
    it("matches .com vs .org", () => {
      expect(domainsMatch("zearn.com", "zearn.org")).toBe(true);
    });

    it("matches .com vs .io", () => {
      expect(domainsMatch("company.com", "company.io")).toBe(true);
    });

    it("matches .com vs .co", () => {
      expect(domainsMatch("company.com", "company.co")).toBe(true);
    });

    it("matches .com vs .ai", () => {
      expect(domainsMatch("company.com", "company.ai")).toBe(true);
    });

    it("matches .com vs .app", () => {
      expect(domainsMatch("company.com", "company.app")).toBe(true);
    });
  });

  describe("known rebrands", () => {
    it("matches n2y.com to everway.com", () => {
      expect(domainsMatch("n2y.com", "everway.com")).toBe(true);
    });

    it("matches n2y.com to everway.link", () => {
      expect(domainsMatch("n2y.com", "everway.link")).toBe(true);
    });

    it("matches serosoft.com to academiaerp.com", () => {
      expect(domainsMatch("serosoft.com", "academiaerp.com")).toBe(true);
    });

    it("matches geniussis.com to geniuslearning.com", () => {
      expect(domainsMatch("geniussis.com", "geniuslearning.com")).toBe(true);
    });

    it("matches cengage.com to cengagegroup.com", () => {
      expect(domainsMatch("cengage.com", "cengagegroup.com")).toBe(true);
    });

    it("matches tophat.com to toph.at", () => {
      expect(domainsMatch("tophat.com", "toph.at")).toBe(true);
    });

    it("matches vitalsource.com to get.vitalsource.com", () => {
      expect(domainsMatch("vitalsource.com", "get.vitalsource.com")).toBe(true);
    });

    it("matches fiveable.me to hi.fiveable.me", () => {
      expect(domainsMatch("fiveable.me", "hi.fiveable.me")).toBe(true);
    });

    it("matches hardhatvr.com to hhimmersive.com", () => {
      expect(domainsMatch("hardhatvr.com", "hhimmersive.com")).toBe(true);
    });

    it("matches alegralearning.com to joyschoolenglish.com", () => {
      expect(domainsMatch("alegralearning.com", "joyschoolenglish.com")).toBe(true);
    });

    it("matches alludolearning.com to alpenspruce.com", () => {
      expect(domainsMatch("alludolearning.com", "alpenspruce.com")).toBe(true);
    });
  });

  describe("non-matches (real departures)", () => {
    it("different companies don't match", () => {
      expect(domainsMatch("zearn.org", "google.com")).toBe(false);
    });

    it("similar but different companies don't match", () => {
      expect(domainsMatch("apple.com", "applebees.com")).toBe(false);
    });

    it("null inputs return false", () => {
      expect(domainsMatch(null, "zearn.org")).toBe(false);
      expect(domainsMatch("zearn.org", null)).toBe(false);
      expect(domainsMatch(null, null)).toBe(false);
    });

    it("empty strings return false", () => {
      expect(domainsMatch("", "zearn.org")).toBe(false);
      expect(domainsMatch("zearn.org", "")).toBe(false);
    });
  });
});
