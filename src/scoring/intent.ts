// Intent Scoring (0-120) — matches Clay Signal Scoring formulas exactly
// Source of truth: scoring-spec-v2.md + ~/projects/acme-clay/tables/signal-scoring.md
//
// Five components:
//   Purchase Intent (0-20) — from Syft purchase_intent field
//   Engagement Depth (0-25, capped) — page views + sessions + active time + visitor count
//   Direct Action (0-35) — LinkedIn action type
//   Referral Source (0-10) — UTM channel
//   Page Intent (0-30) — page URL patterns

export interface SignalData {
  syft_purchase_intent?: string | null;  // "Very High", "High", "Medium", "Low"
  syft_intent_level?: string | null;     // Syft's own intent classification
  high_intent_sessions?: number | null;
  page_views?: number | null;
  sessions?: number | null;
  active_time_seconds?: number | null;
  visitor_count?: number | null;
  linkedin_action?: string | null;       // "comment", "like", "reaction", "profile_view", "form", "message", "dm"
  utm_channel?: string | null;           // "LinkedIn", "Paid", "Google", "Direct", "Organic", "Referral"
  session_pages_visited?: string | null; // Comma-separated page URLs
}

export interface IntentBreakdown {
  total: number;
  purchase_intent: number;
  engagement_depth: number;
  direct_action: number;
  referral_source: number;
  page_intent: number;
}

// Purchase Intent Score (0-20)
// Matches Clay formula f_0taqh62rzxsQY5ychPc
// Syft field: Very High/High = 20, Medium = 10, else = 0
// Also adds bonus for high_intent_sessions > 2 (capped at 20 total)
export function scorePurchaseIntent(
  syftPurchaseIntent?: string | null,
  highIntentSessions?: number | null,
): number {
  const intentStr = (syftPurchaseIntent || "").toLowerCase();

  let score = 0;
  if (intentStr === "high" || intentStr === "very high") {
    score = 20;
  } else if (intentStr === "medium") {
    score = 10;
  }

  // Bonus for high intent sessions (from Clay formula)
  const hiSessions = highIntentSessions || 0;
  if (hiSessions > 2) score += 5;
  else if (hiSessions > 0) score += 2;

  return Math.min(score, 20);
}

// Engagement Depth Score (0-25, capped)
// Matches Clay formula f_0taqh64yM4Pu7wEFgoa
export function scoreEngagementDepth(
  pageViews?: number | null,
  sessions?: number | null,
  activeTimeSeconds?: number | null,
  visitorCount?: number | null,
): number {
  let score = 0;

  if ((pageViews || 0) >= 3) score += 15;
  if ((sessions || 0) >= 2) score += 10;
  if ((activeTimeSeconds || 0) >= 300) score += 10;

  // Visitor count bonus
  const vc = visitorCount || 0;
  if (vc > 3) score += 5;
  else if (vc > 1) score += 2;

  return Math.min(score, 25);
}

// Direct Action Score (0-35)
// Matches Clay formula f_0taqh68i8uzuexbgKbT
// LinkedIn action: form/message/dm = 35, comment = 15, like/reaction/profile_view = 5
export function scoreDirectAction(linkedinAction?: string | null): number {
  if (!linkedinAction) return 0;
  const action = linkedinAction.toLowerCase();

  if (action.includes("form") || action.includes("message") || action.includes("dm")) return 35;
  if (action.includes("comment")) return 15;
  if (action.includes("like") || action.includes("reaction") || action.includes("profile_view")) return 5;

  return 0;
}

// Referral Source Score (0-10)
// Matches Clay formula f_0taqh6a5iZojTiDc7Pk
export function scoreReferralSource(utmChannel?: string | null): number {
  if (!utmChannel) return 5; // No UTM data = 5 (benefit of doubt)

  const ch = utmChannel.toLowerCase();

  if (ch.includes("linkedin")) return 10;
  if (ch.includes("paid")) return 5;
  if (ch.includes("google")) return 5;
  if (ch.includes("direct")) return 5;
  if (ch.includes("organic")) return 5;
  if (ch.includes("referral")) return 5;

  return 0;
}

// Page Intent Score (0-30)
// Keyword list verified Apr 8 2026 against actual ACME site URLs
// (from 30 days of production session_pages_visited data).
//
// Tiers:
//   30 — BOFU / high-intent: pricing, results, case studies, benchmarks,
//        lead-gen funnel content, category comparisons, product pages
//   15 — Mid-funnel: main service page, industries hub, vertical solution
//        pages (K-12, Higher Ed, Adult Ed, Corporate L&D), about
//    5 — Any other page (homepage, blog, etc.)
//    0 — No pages at all AND no page_views (truly zero visibility)
//
// The pageViews fallback fixes a bug where signals with engagement metrics
// but no session_pages_visited (e.g., LinkedIn-identified visitors that
// don't include URL details) were scoring 0 even though they clearly
// visited SOMETHING.
export function scorePageIntent(
  sessionPagesVisited?: string | null,
  pageViews?: number | null,
): number {
  // Null URL list: fall back to the 5-point floor when page_views proves
  // they visited pages we can't identify. Otherwise 0.
  if (!sessionPagesVisited) {
    return (pageViews || 0) > 0 ? 5 : 0;
  }
  const pages = sessionPagesVisited.toLowerCase();

  // 30 — BOFU / high-intent ACME pages
  if (
    pages.includes("/pricing") ||
    pages.includes("/results") ||
    pages.includes("/case-stud") ||
    pages.includes("/sdr-meeting-benchmarks") ||
    pages.includes("lead-generation-funnel") ||
    pages.includes("lead-generation-companies") ||
    pages.includes("/go-to-market-systems")
  ) {
    return 30;
  }

  // 15 — Mid-funnel / vertical solution pages
  if (
    pages.includes("/sales-development") ||
    pages.includes("/industries") ||
    pages.includes("/k-12-") ||
    pages.includes("/k12-") ||
    pages.includes("/higher-ed") ||
    pages.includes("/adult-education") ||
    pages.includes("/corporate-learning") ||
    pages.includes("/about") ||
    pages.includes("/services") ||
    pages.includes("/solutions") ||
    pages.includes("market-intelligence")
  ) {
    return 15;
  }

  // 5 — Any other page (homepage, blog, etc.)
  if (pages.length > 0) return 5;

  return 0;
}

// Full Intent Score = Purchase + Engagement + Direct + Referral + Page Intent (effective max ~120)
// Matches Clay formula f_0taqhbvHfBaa8ZjUf6C
export function scoreIntent(data: SignalData): IntentBreakdown {
  const purchase_intent = scorePurchaseIntent(data.syft_purchase_intent, data.high_intent_sessions);
  const engagement_depth = scoreEngagementDepth(data.page_views, data.sessions, data.active_time_seconds, data.visitor_count);
  const direct_action = scoreDirectAction(data.linkedin_action);
  const referral_source = scoreReferralSource(data.utm_channel);
  const page_intent = scorePageIntent(data.session_pages_visited, data.page_views);

  return {
    total: purchase_intent + engagement_depth + direct_action + referral_source + page_intent,
    purchase_intent,
    engagement_depth,
    direct_action,
    referral_source,
    page_intent,
  };
}

// Decay multiplier based on signal age (G6 fix)
// Signals lose weight over time so leads can cool from Hot → Cold
export function decayMultiplier(signalCreatedAt: string | Date): number {
  const ageMs = Date.now() - new Date(signalCreatedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays <= 7) return 1.0;
  if (ageDays <= 14) return 0.8;
  if (ageDays <= 30) return 0.5;
  if (ageDays <= 60) return 0.25;
  return 0; // Signal expired
}

// Score intent WITH decay applied
export function scoreIntentWithDecay(data: SignalData, signalCreatedAt: string | Date): IntentBreakdown {
  const raw = scoreIntent(data);
  const multiplier = decayMultiplier(signalCreatedAt);

  return {
    total: Math.round(raw.total * multiplier),
    purchase_intent: Math.round(raw.purchase_intent * multiplier),
    engagement_depth: Math.round(raw.engagement_depth * multiplier),
    direct_action: Math.round(raw.direct_action * multiplier),
    referral_source: Math.round(raw.referral_source * multiplier),
    page_intent: Math.round(raw.page_intent * multiplier),
  };
}

// Fibbler engagement scoring — DISABLED
// Fibbler measures ad awareness, not buying intent. Impressions/clicks don't indicate
// purchase readiness — they indicate "we showed up in their feed."
// Data still syncs for attribution visibility, but doesn't affect scoring.
// See: https://martech.org/the-false-allure-of-b2b-intent-data/
export function scoreFibblerEngagement(data: {
  fibbler_clicks?: number | null;
  fibbler_leads?: number | null;
  fibbler_impressions?: number | null;
  fibbler_organic_engagements?: number | null;
  fibbler_organic_impressions?: number | null;
  fibbler_engagement_level?: string | null;
}): number {
  // Zeroed out — Fibbler data preserved for attribution, not scoring
  return 0;
}

// LinkedIn Post Engagement scoring — Apify-sourced post-level data
// Scores based on WHAT content they engaged with (BOFU > MOFU > TOFU)
// and engagement velocity (multiple posts in 7 days)
export function scoreLinkedInPostEngagement(data: {
  post_funnel_stage?: string | null;  // "bofu", "mofu", "tofu"
  engagement_type?: string | null;    // "comment", "reaction", "share"
  engagements_7d?: number | null;     // count of post engagements in last 7 days
}): number {
  let score = 0;

  const stage = (data.post_funnel_stage || "").toLowerCase();
  if (stage === "bofu") score += 20;
  else if (stage === "mofu") score += 10;
  else if (stage === "tofu") score += 5;

  // Comments are higher intent than reactions
  const type = (data.engagement_type || "").toLowerCase();
  if (type === "comment") score += 5;

  // Velocity bonus — engaging with multiple posts = strong signal
  const velocity = data.engagements_7d || 0;
  if (velocity >= 3) score += 10;
  else if (velocity >= 2) score += 5;

  return Math.min(score, 25);
}

// Lead Tier from Total Score (ICP + Intent)
// Matches Clay formula f_0taqi29Hf57C5Htoimv
export function computeTier(totalScore: number): "hot" | "warm" | "cool" | "cold" {
  if (totalScore >= 100) return "hot";
  if (totalScore >= 60) return "warm";
  if (totalScore >= 30) return "cool";
  return "cold";
}
