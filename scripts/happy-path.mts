#!/usr/bin/env npx tsx
/**
 * Happy Path Simulation — full end-to-end with real AI summary
 *
 * Shows exactly what an AE would see for a given signal.
 * Calls Claude for the summary. Does NOT write to HubSpot or Slack.
 *
 * Usage: npx tsx scripts/happy-path.mts --domain everydayspeech.com
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { isMql, isMqlBuyerTitle, isSledSubMarket, passesContactPushGateWithReason } from "../src/lib/gates.ts";
import { computeTier } from "../src/scoring/intent.ts";
import { deriveLeadType, deriveLeadOrigin, deriveAeOwner } from "../src/lib/constants.ts";
import { generateLeadSummary, formatSalesAnalysisForPrompt } from "../src/lib/summaries.ts";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const OWNER_IDS: Record<string, string> = { rep_a: "162280197", rep_b: "163458119" };

function hr(title: string) {
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("━".repeat(60));
}

async function main() {
  const args = process.argv.slice(2);
  const domain = args.includes("--domain") ? args[args.indexOf("--domain") + 1] : null;
  if (!domain) { console.log("Usage: npx tsx scripts/happy-path.mts --domain example.com"); return; }

  // Load signal
  const { data: signals } = await sb
    .from("raw_signals")
    .select("*")
    .eq("domain", domain)
    .not("first_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!signals?.length) { console.log(`No signals with contact data for ${domain}`); return; }
  const signal = signals[0];
  const p = signal.raw_payload as any;

  // Fixed extraction
  const lastSeen = p.lastSeenVisitorDetail || {};
  const lead = (p.contacts || [])[0] || {};
  const leadProps = lead.properties || {};
  const title = lastSeen.title || leadProps.title || null;
  const linkedinSrc = lead.linkedin || leadProps.linkedin;
  const linkedin = linkedinSrc ? `https://linkedin.com/${linkedinSrc}` : null;
  const email = signal.email;
  const firstName = signal.first_name;
  const lastName = signal.last_name;

  // Load company
  const { data: company } = await sb.from("companies").select("*").eq("domain", domain).single();
  if (!company) { console.log(`No company found for ${domain}`); return; }

  // Load existing contact (if any)
  let contact: any = null;
  if (email) {
    const { data } = await sb.from("contacts").select("*").eq("email", email).single();
    contact = data;
  }
  if (!contact && linkedin) {
    const { data } = await sb.from("contacts").select("*").eq("linkedin_url", linkedin).single();
    contact = data;
  }

  // Scores
  const { data: intentSignals } = await sb
    .from("signals")
    .select("intent_score, page_views, sessions, active_time_seconds, session_pages_visited, linkedin_action, created_at")
    .eq("domain", domain)
    .order("intent_score", { ascending: false })
    .limit(1);
  const latestSignal = intentSignals?.[0];

  const icp = company.icp_score || 0;
  const intent = latestSignal?.intent_score || contact?.intent_score || 0;
  const total = icp + intent;
  const tier = computeTier(total);
  const leadType = contact?.lead_type || deriveLeadType(signal.source);
  const aeOwner = deriveAeOwner(company.sub_market);

  // ═══ STEP 1: WHAT SYFT SENT ═══
  hr("1. SYFT SIGNAL");
  console.log(`  ${firstName} ${lastName} visited ${domain}`);
  console.log(`  Title:     ${title}`);
  console.log(`  Email:     ${email || "(none — would get from Cargo/LeadMagic)"}`);
  console.log(`  LinkedIn:  ${linkedin || "(none)"}`);
  console.log(`  Activity:  ${signal.page_views} pageviews, ${signal.sessions} sessions`);
  console.log(`  Intent:    ${signal.syft_purchase_intent || "unknown"}`);
  if (signal.pages_viewed) console.log(`  Pages:     ${signal.pages_viewed}`);
  if (signal.linkedin_action) console.log(`  LinkedIn:  ${signal.linkedin_action}`);

  // ═══ STEP 2: COMPANY ═══
  hr("2. COMPANY DATA");
  console.log(`  ${company.name} (${domain})`);
  console.log(`  ${company.employee_count || "?"} employees · ${company.city}, ${company.state}`);
  console.log(`  Sub-market: ${company.sub_market}`);
  console.log(`  ICP Score:  ${icp}`);
  const std = company.sales_team_data as any;
  if (std?.llm_summary) {
    console.log(`  Sales Org:  ${std.llm_summary}`);
  } else if (std) {
    console.log(`  Sales Org:  ${std.ae_count ?? 0} AEs, ${std.sdr_count ?? 0} SDRs`);
  }
  if (company.description) console.log(`  About:      ${company.description.slice(0, 120)}...`);

  // ═══ STEP 3: ENRICHMENT ═══
  hr("3. CONTACT ENRICHMENT");
  const contactEmail = contact?.email || email;
  const contactLinkedin = contact?.linkedin_url || linkedin;
  const contactTitle = contact?.title || title;
  const contactPhone = contact?.phone || null;
  console.log(`  ${firstName} ${lastName}`);
  console.log(`  Title:     ${contactTitle}`);
  console.log(`  Email:     ${contactEmail || "(would find via Cargo findEmail)"}`);
  console.log(`  LinkedIn:  ${contactLinkedin}`);
  console.log(`  Phone:     ${contactPhone || "(would find via LeadMagic mobile-finder)"}`);
  console.log(`  ICP:       ${icp}  Intent: ${intent}  Total: ${total}  Tier: ${tier}`);

  // ═══ STEP 4: GATES ═══
  hr("4. GATE CHECKS");
  const buyerTitle = isMqlBuyerTitle(contactTitle);
  const sled = isSledSubMarket(company.sub_market);
  const mql = isMql({ lead_type: leadType, lead_tier: tier, title: contactTitle, sub_market: company.sub_market }) && intent > 0;

  console.log(`  Buyer title:  ${buyerTitle ? "YES" : "NO"} ("${contactTitle}")`);
  console.log(`  SLED:         ${sled ? "YES" : "NO"} (${company.sub_market})`);
  console.log(`  Tier:         ${tier} (total=${total})`);
  console.log(`  Intent > 0:   ${intent > 0 ? "YES" : "NO"} (${intent})`);
  console.log(`  Lead type:    ${leadType}`);
  console.log(`  ─────────────`);
  console.log(`  MQL:          ${mql ? ">>> YES — FIRES SLACK ALERT <<<" : "NO — no alert"}`);

  const pushResult = passesContactPushGateWithReason({
    email: contactEmail || null,
    has_existing_hubspot_contact: !!contact?.hubspot_contact_id,
    domain,
    title: contactTitle,
    icp_score: icp,
    lead_tier: tier,
    lead_source: signal.source,
    vertical_fit_score: company.vertical_fit_score || 0,
    sub_market: company.sub_market,
    country: company.country,
  });
  console.log(`  Push gate:    ${pushResult.passes ? "PASS — goes to HubSpot" : `BLOCKED (${pushResult.reason})`}`);

  // ═══ STEP 5: AI SUMMARY ═══
  hr("5. AI SUMMARY (calling Claude now...)");
  const salesDataForPrompt = std ? formatSalesAnalysisForPrompt(std) : null;

  try {
    const summary = await generateLeadSummary({
      contact_name: `${firstName} ${lastName}`,
      title: contactTitle,
      email: contactEmail,
      company_name: company.name,
      domain,
      description: company.description,
      employee_count: company.employee_count,
      industry: company.industry,
      sub_market: company.sub_market,
      sales_team_data: salesDataForPrompt,
      funding_stage: company.funding_stage,
      funding_total: company.funding_total,
      page_views: signal.page_views,
      sessions: signal.sessions,
      active_time_seconds: signal.active_time_seconds,
      pages_visited: signal.pages_viewed,
      linkedin_action: signal.linkedin_action,
      syft_purchase_intent: signal.syft_purchase_intent,
      lead_source: signal.source,
      signal_date: signal.created_at,
    });
    console.log(`\n  ${summary}\n`);
  } catch (err: any) {
    console.log(`  ERROR generating summary: ${err.message}`);
  }

  // ═══ STEP 6: HUBSPOT CONTACT ═══
  hr("6. HUBSPOT CONTACT PAYLOAD");
  const ownerHsId = OWNER_IDS[aeOwner];
  const fields: [string, any][] = [
    ["email", contactEmail],
    ["firstname", firstName],
    ["lastname", lastName],
    ["jobtitle", contactTitle],
    ["company", company.name],
    ["hs_linkedin_url", contactLinkedin],
    ["lead_tier", tier === "cold" ? "" : tier.charAt(0).toUpperCase() + tier.slice(1)],
    ["lead_temp", tier === "cool" ? "Cold" : (tier.charAt(0).toUpperCase() + tier.slice(1) || "Cold")],
    ["lead_origin", deriveLeadOrigin(signal.source)],
    ["lead_type", leadType],
    ["total_score", total],
    ["icp_score", icp],
    ["intent_score", intent],
    ["sub_market", company.sub_market],
    ["city", company.city],
    ["state", company.state],
    ["phone", contactPhone],
    ["hubspot_owner_id", `${ownerHsId} (${aeOwner})`],
    ["lifecyclestage", mql ? "marketingqualifiedlead" : "lead"],
  ];
  for (const [k, v] of fields) {
    if (v != null && v !== "") console.log(`  ${k.padEnd(24)} ${v}`);
  }
  if (company.hubspot_company_id) {
    console.log(`\n  >> Associated with company ${company.hubspot_company_id}`);
  }

  // ═══ STEP 7: SLACK ALERT ═══
  if (mql) {
    hr("7. SLACK ALERT (what the AE sees)");
    const tierEmoji = tier === "hot" ? "🔥" : "🟡";
    const tierLabel = tier === "hot" ? "Hot MQL" : "Warm MQL";
    const mention = aeOwner === "rep_a" ? "@RepA" : "@RepB";
    const source = signal.source === "syft_linkedin" ? "LinkedIn" : "Website";
    const pageHint = signal.pages_viewed ? ` → ${signal.pages_viewed.split(",")[0]?.trim()}` : "";

    console.log();
    console.log(`  ┌─────────────────────────────────────────────────────┐`);
    console.log(`  │ ${tierEmoji} ${tierLabel} · ${source}${pageHint}  —  ${mention}`);
    console.log(`  │`);
    console.log(`  │ ${firstName} ${lastName} — ${contactTitle} @ ${company.name}`);
    if (contactEmail) console.log(`  │ 📧 ${contactEmail}${contactLinkedin ? `  |  LinkedIn` : ""}`);
    console.log(`  │ 📊 Total ${total}  |  ICP ${icp}  |  Intent ${intent}`);
    if (company.employee_count || company.city) {
      const parts = [];
      if (company.employee_count) parts.push(`👥 ${company.employee_count}`);
      if (company.city) parts.push(`📍 ${company.city}, ${company.state}`);
      console.log(`  │ ${parts.join("  |  ")}`);
    }
    if (std?.llm_summary) {
      console.log(`  │ 🧑‍💼 ${std.llm_summary.length > 70 ? std.llm_summary.slice(0, 70) + "..." : std.llm_summary}`);
    }
    console.log(`  │`);
    console.log(`  │ Why this matters:`);
    console.log(`  │ (AI summary shown above)`);
    console.log(`  │`);
    console.log(`  │ 🔗 HubSpot: app.hubspot.com/contacts/244264386/contact/NEW`);
    console.log(`  └─────────────────────────────────────────────────────┘`);
  } else {
    hr("7. SLACK ALERT");
    console.log(`  No alert — contact is not MQL.`);
    if (!buyerTitle) console.log(`  Reason: "${contactTitle}" is not a buyer title.`);
    if (intent === 0) console.log(`  Reason: Intent score is 0.`);
    if (!sled) console.log(`  Reason: Not SLED (${company.sub_market}).`);
  }

  // ═══ VERDICT ═══
  hr("VERDICT");
  if (mql) {
    console.log(`  FULL MQL FLOW: Signal → Enrich → HubSpot → Slack Alert → AE acts`);
  } else if (pushResult.passes) {
    console.log(`  HUBSPOT ONLY: Signal → Enrich → HubSpot (no Slack alert)`);
  } else {
    console.log(`  SUPABASE ONLY: Signal → Enrich → stored but not pushed`);
    console.log(`  Push gate: ${pushResult.reason}`);
  }
}

main().catch(console.error);
