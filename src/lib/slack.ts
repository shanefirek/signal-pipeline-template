// Slack alerts — rich MQL alerts with attribution, narrative, and AE routing.
//
// Hot lead format (Apr 7 rewrite):
//   - Contact + company line (scan)
//   - Score + attribution + signal detail (quick decide)
//   - lead_summary narrative (why this matters)
//   - HubSpot deep link button
//   - @-mention the right AE based on sub_market (K-12 → RepA, Higher Ed → RepB)
//
// Routing: single SLACK_WEBHOOK_URL channel. AE routing is via @-mention,
// not separate channels. Set SLACK_USER_REP_A / SLACK_USER_REP_B env vars to
// the Slack user IDs (e.g. U01234ABCD) to enable real @-mentions; otherwise
// falls back to plain text names.
//
// HubSpot deep link: set HUBSPOT_PORTAL_ID env var to enable the "Open in
// HubSpot" button. If unset, button is omitted.

type SlackAlertData =
  | {
      type: "hot_lead";
      contact_name: string;
      title: string;
      domain: string;
      company_name?: string | null;
      email: string;
      linkedin_url?: string | null;
      icp_score: number;
      intent_score: number;
      total_score: number;
      tier: "hot" | "warm";
      lead_source: string;
      lead_origin: string;
      signal_type?: string | null;
      sub_market?: string | null;
      lead_summary?: string | null;
      page_views?: number | null;
      sessions?: number | null;
      last_seen?: string | null;
      hubspot_contact_id?: string | null;
      // Firmographics — render as a dense one-line fact row
      employee_count?: number | null;
      city?: string | null;
      state?: string | null;
      funding_stage?: string | null;
      funding_total?: number | null;
      // Sales org composition — THE hero line, tells AE at a glance whether
      // ACME can sell to them. Accepts either a SalesTeamAnalysis object (what
      // tam-enrich / enrich-company write) or a pre-formatted string.
      sales_team_data?: unknown;
      // Source visibility — used to derive the header source tag
      pages_visited?: string | null;       // comma-separated list of page paths
      utm_channel?: string | null;         // e.g. "google_ads", "linkedin", "direct"
    }
  | {
      type: "tier_upgrade";
      domain: string;
      company_name?: string;
      previous_tier: string;
      new_tier: string;
      icp_score: number;
      intent_score: number;
      total_score: number;
      lead_source?: string;
      hubspot_company_id?: string | null;
      ae_owner?: string | null;
    }
  | {
      type: "contact_departed";
      domain: string;
      company_name?: string;
      old_contact_name: string;
      old_title: string;
      new_contact_name: string;
      new_title: string;
    };

// Route @-mention to the right AE based on sub_market.
// Uses real Slack user IDs (<@Uxxx>) when env vars are set, falls back to
// plain-text names otherwise (no notification, but still readable).
function getAeMention(subMarket: string | null | undefined): string {
  const rep_aId = process.env.SLACK_USER_REP_A;
  const repBId = process.env.SLACK_USER_REP_B;
  const s = (subMarket || "").toLowerCase();

  if (s.includes("k12") || s.includes("k-12")) {
    return rep_aId ? `<@${rep_aId}>` : "RepA";
  }
  if (s.includes("higher ed") || s.includes("higher education") || s.includes("gov")) {
    return repBId ? `<@${repBId}>` : "RepB";
  }
  return ""; // no mention — unknown vertical, don't spam
}

// Route @-mention from ae_owner name (stored on contacts: "rep_a" | "rep_b").
function getAeMentionByOwner(aeOwner: string | null | undefined): string {
  const rep_aId = process.env.SLACK_USER_REP_A;
  const repBId = process.env.SLACK_USER_REP_B;
  const o = (aeOwner || "").toLowerCase();
  if (o === "rep_a") return rep_aId ? `<@${rep_aId}>` : "RepA";
  if (o === "rep_b") return repBId ? `<@${repBId}>` : "RepB";
  return "";
}

// Build a deep link to the HubSpot contact record. Requires HUBSPOT_PORTAL_ID
// env var to be set. Returns null if unavailable so callers can omit the button.
function getHubSpotContactLink(contactId: string | null | undefined): string | null {
  if (!contactId) return null;
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  if (!portalId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`;
}

// Format a relative time like "2h ago" or "Apr 6" from an ISO timestamp.
function formatLastSeen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const now = Date.now();
  const diffMs = now - then;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getHubSpotCompanyLink(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  if (!portalId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;
}

// Truncate a long lead_summary to keep Slack blocks readable. Cuts at a word
// boundary where possible and adds an ellipsis.
function truncateSummary(text: string | null | undefined, maxChars = 1400): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

// Convert standard markdown bold (**X**) to Slack mrkdwn bold (*X*).
// Claude generates lead_summary in standard markdown format; Slack uses its
// own mrkdwn dialect where *X* is bold. Without this transform, Slack renders
// the double asterisks as literal characters instead of bold.
// Only converts **bold**, leaves other formatting alone.
function markdownBoldToSlackMrkdwn(text: string): string {
  return text.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
}

// Extract the first meaningful page path from a comma-separated list.
// Input: "/pricing,/features,/about"  → "/pricing"
// Input: "https://example.com/pricing" → "/pricing"
// Returns null if nothing useful.
function firstPagePath(pagesVisited: string | null | undefined): string | null {
  if (!pagesVisited) return null;
  const first = pagesVisited.split(",")[0]?.trim();
  if (!first) return null;
  // Strip protocol + domain if present, keep the path
  const match = first.match(/^(?:https?:\/\/[^/]+)?(\/[^\s?#]*)/);
  if (match && match[1] && match[1] !== "/") return match[1];
  if (first.startsWith("/")) return first;
  return null;
}

// Normalize a raw utm_channel value ("google_ads", "linkedin", "direct") into
// a human-readable label for display.
function prettyUtmChannel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  const c = channel.toLowerCase().trim();
  if (!c || c === "direct" || c === "none" || c === "null") return null;
  if (c.includes("google")) return c.includes("ad") ? "Google Ads" : "Google";
  if (c.includes("linkedin")) return c.includes("ad") ? "LinkedIn Ad" : "LinkedIn";
  if (c.includes("facebook") || c.includes("meta")) return "Meta";
  if (c.includes("bing")) return "Bing";
  if (c.includes("organic")) return "Organic Search";
  if (c.includes("referral")) return "Referral";
  // Fall back: title-case the raw value, replace underscores
  return channel.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Build the source tag that appears in the header. Shows RepA where the lead
// came from at a glance ("I don't know where these are coming from" was his
// #1 complaint in the Apr 7 1:1). Priority: specific page > channel type.
function buildSourceTag(data: Extract<SlackAlertData, { type: "hot_lead" }>): string {
  const page = firstPagePath(data.pages_visited);
  const source = (data.lead_source || "").toLowerCase();
  const utm = prettyUtmChannel(data.utm_channel);

  // Website + page → most specific
  if (page && (source.includes("syft") || source.includes("website") || source.includes("direct"))) {
    const channel = utm || "Website";
    return `${channel} → ${page}`;
  }
  // LinkedIn engagement (organic)
  if (source.includes("linkedin") && !source.includes("ad")) {
    return "LinkedIn engagement";
  }
  // LinkedIn paid (Fibbler)
  if (source.includes("fibbler") || source.includes("linkedin_ad")) {
    return "LinkedIn ad";
  }
  // UTM-only fallback
  if (utm) return utm;
  // Page without a known channel
  if (page) return `Website → ${page}`;
  // Last resort
  return data.lead_origin || "Unknown source";
}

// Render the attribution line. Factual — shows the UTM channel when present,
// "Direct traffic" when not. No editorializing.
function buildAttributionLine(data: Extract<SlackAlertData, { type: "hot_lead" }>): string {
  const parts: string[] = [];
  if (data.sub_market) parts.push(`:dart: ${data.sub_market}`);

  const utm = prettyUtmChannel(data.utm_channel);
  let sourceLabel: string;
  if (utm) {
    sourceLabel = utm;
  } else if (data.lead_source && /syft|website|direct/i.test(data.lead_source)) {
    sourceLabel = "Direct traffic";
  } else {
    sourceLabel = data.signal_type
      ? `${data.lead_origin} → ${data.signal_type}`
      : data.lead_origin;
  }
  parts.push(sourceLabel);
  return parts.join("  |  ");
}

// Firmographics line: size | location | funding. Any part missing → skip that
// part. All parts missing → return null so the whole line is dropped.
function buildFirmographicsLine(data: Extract<SlackAlertData, { type: "hot_lead" }>): string | null {
  const parts: string[] = [];
  if (data.employee_count && data.employee_count > 0) {
    parts.push(`:factory: ${data.employee_count} employees`);
  }
  const loc = [data.city, data.state].filter(Boolean).join(", ");
  if (loc) parts.push(`:round_pushpin: ${loc}`);
  if (data.funding_stage) {
    const amount = data.funding_total && data.funding_total > 0
      ? ` · $${(data.funding_total / 1_000_000).toFixed(1)}M`
      : "";
    parts.push(`:moneybag: ${data.funding_stage}${amount}`);
  }
  return parts.length ? parts.join("  |  ") : null;
}

// Sales org hero line — THE signal that tells the AE whether ACME can sell to
// them. Accepts either a pre-formatted string or
// a SalesTeamAnalysis object (modern LeadMagic path). Returns null when we
// have nothing useful — that line just gets skipped.
function buildSalesOrgHeroLine(data: Extract<SlackAlertData, { type: "hot_lead" }>): string | null {
  const raw = data.sales_team_data;
  if (!raw) return null;

  // Case 1: already a string (pre-formatted by summaries.ts or stored as text)
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Truncate to keep the line scannable
    const short = trimmed.length > 180
      ? trimmed.substring(0, 180).replace(/\s+\S*$/, "") + "…"
      : trimmed;
    return `:office_worker: ${short}`;
  }

  // Case 2: SalesTeamAnalysis object shape → format inline (mirrors
  // formatSalesAnalysisForPrompt without importing it, to keep slack.ts
  // self-contained and avoid circular dep risk).
  if (typeof raw === "object" && raw !== null) {
    const a = raw as Record<string, any>;
    // Guard: only handle objects that look like SalesTeamAnalysis
    if (typeof a.ae_count !== "number" && typeof a.sdr_count !== "number") {
      return null;
    }
    const parts: string[] = [];
    if (a.ae_count > 0) {
      parts.push(`${a.ae_count} AE${a.ae_count === 1 ? "" : "s"}`);
    } else if (!a.founder_selling) {
      parts.push("0 AEs");
    }
    if (a.sdr_count > 0) {
      parts.push(`${a.sdr_count} SDR${a.sdr_count === 1 ? "" : "s"}`);
    } else {
      parts.push("no SDRs");
    }
    if (a.has_vp_sales) parts.push("VP Sales");
    else if (a.has_sales_director) parts.push("Sales Director");
    else if (a.has_sales_manager) parts.push("Sales Manager");
    if (a.founder_selling && (!a.ae_count || a.ae_count === 0)) {
      parts.push("founder selling");
    }
    const hiring: string[] = [];
    if (a.hiring_sdr) hiring.push("SDR");
    if (a.hiring_ae) hiring.push("AE");
    if (a.hiring_sales && !a.hiring_sdr && !a.hiring_ae) hiring.push("sales");
    if (hiring.length) parts.push(`hiring ${hiring.join(" + ")}`);
    if (!parts.length) return null;
    return `:office_worker: ${parts.join(", ")}`;
  }

  return null;
}

export async function sendSlackAlert(data: SlackAlertData) {
  // Global blocklist — no alerts for blocked domains, period.
  if (data.domain) {
    const { isDomainBlocked } = await import("./gates.js");
    if (await isDomainBlocked(data.domain)) {
      console.log(`[slack] Blocked domain ${data.domain}, skipping alert`);
      return;
    }
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  // Dry-run mode: build the payload and print JSON instead of posting.
  // Useful for previewing Slack block format in Block Kit Builder without
  // touching a real channel. Enable with SLACK_DRY_RUN=true.
  const dryRun = process.env.SLACK_DRY_RUN === "true";

  if (!webhookUrl && !dryRun) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set, skipping alert");
    return;
  }

  let message: Record<string, any>;

  if (data.type === "hot_lead") {
    const tierEmoji = data.tier === "hot" ? ":fire:" : ":large_yellow_circle:";
    const tierLabel = data.tier === "hot" ? "Hot MQL" : "Warm MQL";
    const mention = getAeMention(data.sub_market);
    const companyDisplay = data.company_name || data.domain;
    const hubspotLink = getHubSpotContactLink(data.hubspot_contact_id);
    const lastSeenDisplay = formatLastSeen(data.last_seen);

    // Header line: "🔥 Hot MQL · Website → /pricing — @RepA"
    // Source tag in header is RepA's #1 ask from the Apr 7 1:1 — he literally
    // said "I don't know where these are coming from" 3x in two minutes.
    const sourceTag = buildSourceTag(data);
    const headerCore = `${tierEmoji} ${tierLabel} · ${sourceTag}`;
    const headerText = mention ? `${headerCore}  —  ${mention}` : headerCore;

    // Contact line: "*Jane Doe* — VP of Sales @ *Acme Learning*"
    const contactLine = `*${data.contact_name}* — ${data.title} @ *${companyDisplay}*`;

    // Contact info line (email + LinkedIn)
    const contactInfoParts: string[] = [];
    if (data.email && data.email !== "No email" && data.email !== "Unknown") {
      contactInfoParts.push(`:envelope: ${data.email}`);
    }
    if (data.linkedin_url) {
      contactInfoParts.push(`<${data.linkedin_url}|LinkedIn>`);
    }
    const contactInfoLine = contactInfoParts.join("  |  ");

    const scoreLine = [
      `:bar_chart: *Total ${data.total_score}*`,
      `ICP ${data.icp_score}`,
      `Intent ${data.intent_score}`,
    ].join("  |  ");

    // Attribution + signal detail
    const attributionLine = buildAttributionLine(data);
    const signalDetailParts: string[] = [];
    if (data.sessions != null && data.sessions > 0) {
      signalDetailParts.push(`${data.sessions} session${data.sessions === 1 ? "" : "s"}`);
    }
    if (data.page_views != null && data.page_views > 0) {
      signalDetailParts.push(`${data.page_views} pageview${data.page_views === 1 ? "" : "s"}`);
    }
    if (lastSeenDisplay) {
      signalDetailParts.push(`last seen ${lastSeenDisplay}`);
    }
    const signalDetailLine = signalDetailParts.length
      ? `:chart_with_upwards_trend: ${signalDetailParts.join(" · ")}`
      : null;

    // Firmographics + sales org hero line — the qualification context that
    // makes this alert do its job. Sales org line is THE point of the pipe.
    const firmographicsLine = buildFirmographicsLine(data);
    const salesOrgHeroLine = buildSalesOrgHeroLine(data);

    // Compose the top block
    const topBlockText = [
      `*${headerText}*`,
      contactLine,
      contactInfoLine || null,
    ]
      .filter(Boolean)
      .join("\n");

    const statsBlockText = [
      scoreLine,
      attributionLine,
      signalDetailLine,
    ]
      .filter(Boolean)
      .join("\n");

    const contextBlockText = [firmographicsLine, salesOrgHeroLine]
      .filter(Boolean)
      .join("\n");

    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: topBlockText },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: statsBlockText },
      },
    ];

    // Qualification context block — only render if we have at least one line
    // of firmographics or sales org data. Skips cleanly on sparse records.
    if (contextBlockText) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: contextBlockText },
      });
    }

    // Lead summary narrative (the killer field)
    // Convert **Bold** → *Bold* because Claude writes markdown but Slack wants mrkdwn
    if (data.lead_summary) {
      const summaryText = markdownBoldToSlackMrkdwn(truncateSummary(data.lead_summary));
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Why this matters:*\n${summaryText}`,
        },
      });
    }

    // HubSpot deep link button — only if portal ID is set
    if (hubspotLink) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in HubSpot" },
            url: hubspotLink,
            style: "primary",
          },
        ],
      });
    }

    message = {
      // Fallback text for notifications + Slack clients that don't render blocks
      text: `${tierLabel}: ${data.contact_name} at ${companyDisplay} (Score ${data.total_score})`,
      blocks,
    };
  } else if (data.type === "tier_upgrade") {
    const tierEmoji = data.new_tier === "hot" ? ":fire:" : ":chart_with_upwards_trend:";
    const name = data.company_name || data.domain;
    const mention = getAeMentionByOwner(data.ae_owner);
    const hubspotCompanyLink = getHubSpotCompanyLink(data.hubspot_company_id);

    const headerText = mention
      ? `${tierEmoji} Tier Upgrade: ${name}  —  ${mention}`
      : `${tierEmoji} Tier Upgrade: ${name}`;

    const fields: any[] = [
      { type: "mrkdwn", text: `*Company:* ${data.domain}` },
      { type: "mrkdwn", text: `*Tier:* ${data.previous_tier} → *${data.new_tier}*` },
      { type: "mrkdwn", text: `*Score:* ${data.total_score} (ICP: ${data.icp_score} + Intent: ${data.intent_score})` },
      { type: "mrkdwn", text: `*Source:* ${data.lead_source || "return visit"}` },
    ];

    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${headerText}*` },
      },
      { type: "section", fields },
    ];

    if (hubspotCompanyLink) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in HubSpot" },
            url: hubspotCompanyLink,
            style: "primary",
          },
        ],
      });
    }

    message = {
      text: `${tierEmoji} Tier Upgrade: ${name} moved ${data.previous_tier} → ${data.new_tier} (Score: ${data.total_score})`,
      blocks,
    };
  } else {
    // contact_departed
    const name = data.company_name || data.domain;
    message = {
      text: `Contact Departed: ${data.old_contact_name} at ${name}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: `Contact Departed: ${name}` } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Left:* ${data.old_contact_name} (${data.old_title})` },
            { type: "mrkdwn", text: `*Replaced by:* ${data.new_contact_name} (${data.new_title})` },
            { type: "mrkdwn", text: `*Domain:* ${data.domain}` },
          ],
        },
      ],
    };
  }

  if (dryRun) {
    console.log("[slack dry-run] Would post this payload:");
    console.log(JSON.stringify(message, null, 2));
    // Also emit a Block Kit Builder preview URL so you can paste the blocks
    // into https://app.slack.com/block-kit-builder and see the rendered view.
    const blocksOnly = JSON.stringify({ blocks: message.blocks });
    console.log("\n[slack dry-run] Block Kit Builder preview:");
    console.log(`https://app.slack.com/block-kit-builder#${encodeURIComponent(blocksOnly)}`);
    return;
  }

  const res = await fetch(webhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
