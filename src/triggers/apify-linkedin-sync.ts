import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { cleanDomain } from "../lib/gates.js";

// Apify LinkedIn Post Engagement Sync — runs weekly Monday 9am
//
// Scrapes RepC's LinkedIn posts via Apify (harvestapi/linkedin-profile-posts),
// captures commenters/reactors, matches against Supabase contacts/companies,
// writes as linkedin_post_engagement signals for intent scoring.
//
// Joe Rhew insight: signal capture is commoditized — the value is matching
// post-level engagement with CRM context (deals, lifecycle, outreach history).

const APIFY_BASE = "https://api.apify.com/v2";
const POSTS_ACTOR = "harvestapi~linkedin-profile-posts";

// RepC's LinkedIn profile — the inbound engine
const REP_C_LINKEDIN = "https://www.linkedin.com/in/rep_c-offterdinger/";

// Post funnel classification keywords
const BOFU_KEYWORDS = ["pricing", "case study", "results", "roi", "client", "closed", "deal", "revenue", "pipeline", "won"];
const MOFU_KEYWORDS = ["solution", "service", "platform", "product", "demo", "workflow", "automation", "gtm", "acme-gtm"];

function classifyPostFunnel(text: string): "bofu" | "mofu" | "tofu" {
  const lower = text.toLowerCase();
  if (BOFU_KEYWORDS.some(k => lower.includes(k))) return "bofu";
  if (MOFU_KEYWORDS.some(k => lower.includes(k))) return "mofu";
  return "tofu";
}

function getApiToken(): string | null {
  return process.env.APIFY_API_TOKEN || null;
}

interface ApifyPost {
  text?: string;
  url?: string;
  postUrl?: string;
  numLikes?: number;
  numComments?: number;
  numShares?: number;
  timeSincePosted?: string;
  comments?: ApifyComment[];
  reactions?: ApifyReaction[];
}

interface ApifyComment {
  text?: string;
  author?: {
    name?: string;
    headline?: string;
    profileUrl?: string;
    url?: string;
  };
  authorName?: string;
  authorHeadline?: string;
  authorProfileUrl?: string;
}

interface ApifyReaction {
  author?: {
    name?: string;
    headline?: string;
    profileUrl?: string;
    url?: string;
  };
  authorName?: string;
  authorHeadline?: string;
  authorProfileUrl?: string;
  reactionType?: string;
}

// Manual task — trigger weekly from Trigger.dev dashboard or from rep_c-digest
// Schedule limit hit (10/10). Convert to scheduled when plan upgraded.
export const apifyLinkedInSync = task({
  id: "apify-linkedin-sync",
  run: async () => {
    const token = getApiToken();
    if (!token) {
      console.error("[apify-linkedin-sync] APIFY_API_TOKEN not set");
      return { error: "APIFY_API_TOKEN not configured" };
    }

    console.log("[apify-linkedin-sync] Fetching RepC's recent posts...");

    // Run the Apify actor synchronously
    const res = await fetch(
      `${APIFY_BASE}/acts/${POSTS_ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=120`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileUrls: [REP_C_LINKEDIN],
          maxPosts: 20, // Last ~20 posts (covers ~1 month)
          scrapeComments: true,
          scrapeReactions: true,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[apify-linkedin-sync] Apify error (${res.status}): ${text.slice(0, 300)}`);
      return { error: `Apify ${res.status}` };
    }

    const posts = await res.json() as ApifyPost[];
    console.log(`[apify-linkedin-sync] Got ${posts.length} posts`);

    let signalsInserted = 0;
    let skipped = 0;
    let matched = 0;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    for (const post of posts) {
      const postUrl = post.url || post.postUrl || "";
      const postText = post.text || "";
      const funnelStage = classifyPostFunnel(postText);

      // Process commenters
      const commenters = (post.comments || []).map(c => ({
        name: c.author?.name || c.authorName || null,
        headline: c.author?.headline || c.authorHeadline || null,
        linkedinUrl: c.author?.profileUrl || c.author?.url || c.authorProfileUrl || null,
        engagementType: "comment" as const,
        commentText: c.text || null,
      }));

      // Process reactors
      const reactors = (post.reactions || []).map(r => ({
        name: r.author?.name || r.authorName || null,
        headline: r.author?.headline || r.authorHeadline || null,
        linkedinUrl: r.author?.profileUrl || r.author?.url || r.authorProfileUrl || null,
        engagementType: "reaction" as const,
        commentText: null,
      }));

      const engagers = [...commenters, ...reactors];

      for (const engager of engagers) {
        if (!engager.name && !engager.linkedinUrl) {
          skipped++;
          continue;
        }

        // Try to extract company domain from headline (e.g. "VP Sales at Acme Corp")
        // This is best-effort — headline format varies
        let domain: string | null = null;

        // Match against Supabase contacts by LinkedIn URL
        if (engager.linkedinUrl) {
          const { data: contact } = await supabase
            .from("contacts")
            .select("domain")
            .eq("linkedin_url", engager.linkedinUrl)
            .limit(1)
            .single();
          if (contact) {
            domain = contact.domain;
            matched++;
          }
        }

        // If no contact match, try companies by name from headline
        if (!domain && engager.headline) {
          const atMatch = engager.headline.match(/(?:at|@)\s+(.+?)(?:\s*[|·•—]|$)/i);
          if (atMatch) {
            const companyName = atMatch[1].trim();
            const { data: company } = await supabase
              .from("companies")
              .select("domain")
              .ilike("name", `%${companyName}%`)
              .limit(1)
              .single();
            if (company) {
              domain = company.domain;
              matched++;
            }
          }
        }

        // Dedup: skip if same person + same post already in signals (last 7 days)
        if (domain) {
          const { data: existing } = await supabase
            .from("signals")
            .select("id")
            .eq("domain", domain)
            .eq("source", "linkedin_post_engagement")
            .eq("session_pages_visited", postUrl) // repurposed for post URL
            .gte("created_at", sevenDaysAgo)
            .limit(1)
            .single();

          if (existing) {
            skipped++;
            continue;
          }
        }

        // Count this domain's post engagements in last 7 days (for velocity scoring)
        let engagements7d = 0;
        if (domain) {
          const { count } = await supabase
            .from("signals")
            .select("id", { count: "exact", head: true })
            .eq("domain", domain)
            .eq("source", "linkedin_post_engagement")
            .gte("created_at", sevenDaysAgo);
          engagements7d = count || 0;
        }

        // Look up company
        let companyId: string | null = null;
        if (domain) {
          const { data: company } = await supabase
            .from("companies")
            .select("id")
            .eq("domain", domain)
            .limit(1)
            .single();
          companyId = company?.id || null;
        }

        // Insert signal
        await supabase.from("signals").insert({
          domain: domain || "unknown",
          company_id: companyId,
          source: "linkedin_post_engagement",
          company_name: null,
          contact_name: engager.name,
          title: engager.headline,
          linkedin_url: engager.linkedinUrl,
          linkedin_action: engager.engagementType,
          session_pages_visited: postUrl, // repurposed for post URL
          page_intent_score: funnelStage === "bofu" ? 20 : funnelStage === "mofu" ? 10 : 5,
          intent_score: 0, // Will be computed by score-intent on next signal
          icp_score: 0,
          total_score: 0,
          lead_tier: "cold",
        });

        signalsInserted++;
        if (domain) {
          console.log(`[apify-linkedin-sync] ${engager.name} (${engager.engagementType}) on ${funnelStage} post → ${domain} (velocity: ${engagements7d})`);
        }
      }
    }

    console.log(`[apify-linkedin-sync] Done. Posts: ${posts.length}, Signals: ${signalsInserted}, Matched: ${matched}, Skipped: ${skipped}`);
    return { posts: posts.length, signals: signalsInserted, matched, skipped };
  },
});
