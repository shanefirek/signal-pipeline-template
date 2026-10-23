import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decayMultiplier,
  scoreIntentWithDecay,
  scoreFibblerEngagement,
  scoreIntent,
  computeTier,
} from "../scoring/intent.js";

// Decay multiplier tests (G6 fix)
describe("decayMultiplier", () => {
  it("returns 1.0 for signal within 7 days", () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(twoDaysAgo)).toBe(1.0);
  });

  it("returns 1.0 for signal exactly today", () => {
    expect(decayMultiplier(new Date())).toBe(1.0);
  });

  it("returns 0.8 for signal 8-14 days old", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(tenDaysAgo)).toBe(0.8);
  });

  it("returns 0.5 for signal 15-30 days old", () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(twentyDaysAgo)).toBe(0.5);
  });

  it("returns 0.25 for signal 31-60 days old", () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(fortyDaysAgo)).toBe(0.25);
  });

  it("returns 0 for signal older than 60 days", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(ninetyDaysAgo)).toBe(0);
  });

  it("accepts ISO string dates", () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(decayMultiplier(recent)).toBe(1.0);
  });

  it("30-day signal scores lower than 1-day signal", () => {
    const oneDay = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(decayMultiplier(oneDay)).toBeGreaterThan(decayMultiplier(thirtyDays));
  });
});

// Intent scoring with decay applied
describe("scoreIntentWithDecay", () => {
  const highIntentSignal = {
    syft_purchase_intent: "Very High",
    page_views: 5,
    sessions: 3,
    active_time_seconds: 600,
    linkedin_action: "comment",
    session_pages_visited: "/pricing,/about",
  };

  it("returns full score for fresh signal", () => {
    const now = new Date();
    const raw = scoreIntent(highIntentSignal);
    const decayed = scoreIntentWithDecay(highIntentSignal, now);
    expect(decayed.total).toBe(raw.total);
  });

  it("returns reduced score for 10-day-old signal", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const raw = scoreIntent(highIntentSignal);
    const decayed = scoreIntentWithDecay(highIntentSignal, tenDaysAgo);
    expect(decayed.total).toBeLessThan(raw.total);
    expect(decayed.total).toBe(Math.round(raw.total * 0.8));
  });

  it("returns zero for expired signal (90 days)", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const decayed = scoreIntentWithDecay(highIntentSignal, ninetyDaysAgo);
    expect(decayed.total).toBe(0);
  });

  it("all components decay proportionally", () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const raw = scoreIntent(highIntentSignal);
    const decayed = scoreIntentWithDecay(highIntentSignal, twentyDaysAgo);
    expect(decayed.purchase_intent).toBe(Math.round(raw.purchase_intent * 0.5));
    expect(decayed.engagement_depth).toBe(Math.round(raw.engagement_depth * 0.5));
    expect(decayed.direct_action).toBe(Math.round(raw.direct_action * 0.5));
  });
});

// Fibbler engagement scoring — DISABLED (awareness != intent)
// Data still syncs for attribution, but doesn't affect scoring
describe("scoreFibblerEngagement", () => {
  it("always returns 0 (Fibbler disabled from scoring)", () => {
    expect(scoreFibblerEngagement({})).toBe(0);
    expect(scoreFibblerEngagement({ fibbler_clicks: 5 })).toBe(0);
    expect(scoreFibblerEngagement({ fibbler_leads: 2 })).toBe(0);
    expect(scoreFibblerEngagement({ fibbler_impressions: 150 })).toBe(0);
    expect(scoreFibblerEngagement({
      fibbler_clicks: 10,
      fibbler_leads: 3,
      fibbler_impressions: 200,
      fibbler_engagement_level: "VERY_HIGH",
    })).toBe(0);
  });
});

// Tier computation
describe("computeTier", () => {
  it("Hot >= 100", () => {
    expect(computeTier(100)).toBe("hot");
    expect(computeTier(150)).toBe("hot");
  });

  it("Warm 60-99", () => {
    expect(computeTier(60)).toBe("warm");
    expect(computeTier(99)).toBe("warm");
  });

  it("Cool 30-59", () => {
    expect(computeTier(30)).toBe("cool");
    expect(computeTier(59)).toBe("cool");
  });

  it("Cold < 30", () => {
    expect(computeTier(0)).toBe("cold");
    expect(computeTier(29)).toBe("cold");
  });
});
