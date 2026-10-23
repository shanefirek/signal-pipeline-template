#!/usr/bin/env npx tsx
/**
 * Pipeline Simulation — Local dry run
 *
 * Takes a raw_signal ID and simulates the full pipeline locally.
 * Shows exactly what would be pushed to HubSpot and Slack.
 * No API calls. No prod writes. Just the payloads.
 *
 * Usage:
 *   npx tsx scripts/simulate-pipeline.mts <signal-id>
 *   npx tsx scripts/simulate-pipeline.mts latest
 *   npx tsx scripts/simulate-pipeline.mts --domain exampleco.io
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { isMql, isMqlBuyerTitle, isSledSubMarket, passesContactPushGateWithReason } from "../src/lib/gates.ts";
import { computeTier } from "../src/scoring/intent.ts";
import { deriveLeadType, deriveLeadOrigin, deriveAeOwner } from "../src/lib/constants.ts";

const OWNER_IDS: Record<string, string> = { rep_a: "162280197", rep_b: "163458119" };

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

function section(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function field(label: string, value: any, flag?: string) {
  const val = value === null || value === undefined ? "null" : String(value);
  const flagStr = flag ? ` << ${flag}` : "";
  console.log(`  ${label.padEnd(28)} ${val}${flagStr}`);
}

async function main() {
  const args = process.argv.slice(2);

  // Find the signal
  let signalQuery = sb.from("raw_signals").select("*");
  if (args[0] === "--domain") {
    signalQuery = signalQuery.eq("domain", args[1]);
  } else if (args[0] === "latest") {
    signalQuery = signalQuery.in("status", ["done", "scoring", "enriching"]);
  } else if (args[0]) {
    signalQuery = signalQuery.eq("id", args[0]);
  } else {
    console.log("Usage: npx tsx scripts/simulate-pipeline.mts <signal-id|latest|--domain example.com>");
    return;
  }

  const { data: signals } = await signalQuery.order("created_at", { ascending: false }).limit(1);
  if (!signals || signals.length === 0) { console.log("No signal found."); return; }
  const signal = signals[0];
  const payload = signal.raw_payload as any;

  // ── Step 1: Re-extract with FIXED logic ──
  section("STEP 1: SYFT EXTRACTION (with fix applied)");

  const contacts = payload.contacts || [];
  const lead = contacts[0] || {};
  const leadProps = lead.properties || {};
  const lastSeen = payload.lastSeenVisitorDetail || {};

  // Old extraction (what's in DB now)
  const oldTitle = signal.title;
  const oldLinkedin = signal.linkedin_url;

  // Fixed extraction
  const fixedTitle = lastSeen.title || leadProps.title || null;
  const linkedinSource = lead.linkedin || leadProps.linkedin;
  const fixedLinkedin = linkedinSource ? `https://linkedin.com/${linkedinSource}` : null;
  const fixedEmail = signal.email; // email extraction unchanged

  field("Domain", signal.domain);
  field("Contact", `${signal.first_name} ${signal.last_name}`);
  field("Title (OLD/broken)", oldTitle, oldTitle ? "" : "WAS NULL - DROPPED");
  field("Title (FIXED)", fixedTitle, fixedTitle && !oldTitle ? "RECOVERED" : "");
  field("LinkedIn (OLD/broken)", oldLinkedin, oldLinkedin ? "" : "WAS NULL - DROPPED");
  field("LinkedIn (FIXED)", fixedLinkedin, fixedLinkedin && !oldLinkedin ? "RECOVERED" : "");
  field("Email", fixedEmail);
  field("Source", signal.source);

  const hasIdentifier = fixedLinkedin || (fixedEmail && fixedEmail.trim() !== "");
  field("hasIdentifier", hasIdentifier, !hasIdentifier ? "WOULD BE DROPPED BY NORMALIZE" : "WOULD PROCEED");

  // ── Step 2: Company data ──
  section("STEP 2: COMPANY (from Supabase)");

  const { data: company } = await sb
    .from("companies")
    .select("*")
    .eq("domain", signal.domain)
    .single();

  if (!company) {
    console.log("  Company not found in Supabase — would trigger enrich-company");
    return;
  }

  field("Name", company.name);
  field("Domain", company.domain);
  field("City", company.city);
  field("State", company.state);
  field("Country", company.country);
  field("Employee count", company.employee_count);
  field("Sub-market", company.sub_market);
  field("ICP score", company.icp_score);
  field("Intent score", company.intent_score);
  field("Total score", company.total_score);
  field("Lead tier", company.lead_tier);
  field("Description", company.description?.slice(0, 80) + "...");
  field("LinkedIn", company.linkedin_url);
  field("Sales team data", company.sales_team_data ? `AEs: ${company.sales_team_data.ae_count}, SDRs: ${company.sales_team_data.sdr_count}` : "null");
  field("Sales org summary", company.sales_org_summary?.slice(0, 80));
  field("Lead summary", company.lead_summary?.slice(0, 80) + "...");
  field("HubSpot company ID", company.hubspot_company_id);
  field("Is SLED", isSledSubMarket(company.sub_market));

  // ── Step 3: What HubSpot company push looks like ──
  section("STEP 3: HUBSPOT COMPANY PAYLOAD");

  if (company.hubspot_company_id) {
    console.log("  Company already in HubSpot — would UPDATE, not create.");
  }

  const companyPayload: Record<string, any> = {
    domain: company.domain,
    name: company.name,
    linkedin_company_page: company.linkedin_url,
    numberofemployees: company.employee_count ? String(company.employee_count) : undefined,
    sub_market: company.sub_market,
    icp_score: company.icp_score != null ? String(company.icp_score) : undefined,
    intent_score: company.intent_score != null ? String(company.intent_score) : undefined,
    lead_tier: company.lead_tier,
    lead_temp: company.lead_tier, // same mapping
    lead_origin: "Clay",
    total_score: company.total_score != null ? String(company.total_score) : undefined,
    lead_summary: company.lead_summary,
    sales_org_summary: company.sales_org_summary,
    description: company.description,
    city: company.city,
    state: company.state,
    country: company.country,
  };

  // Show non-null fields
  for (const [k, v] of Object.entries(companyPayload)) {
    if (v != null) field(k, typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "..." : v);
  }

  // ── Step 4: Contact enrichment simulation ──
  section("STEP 4: CONTACT ENRICHMENT");

  // Check existing contact
  let existingContact: any = null;
  if (fixedEmail) {
    const { data } = await sb.from("contacts").select("*").eq("email", fixedEmail).single();
    existingContact = data;
  }
  if (!existingContact && fixedLinkedin) {
    const { data } = await sb.from("contacts").select("*").eq("linkedin_url", fixedLinkedin).single();
    existingContact = data;
  }

  const title = existingContact?.title || fixedTitle;
  const email = existingContact?.email || fixedEmail;
  const linkedin_url = existingContact?.linkedin_url || fixedLinkedin;
  const phone = existingContact?.phone || null;
  const first_name = existingContact?.first_name || signal.first_name;
  const last_name = existingContact?.last_name || signal.last_name;
  const lead_source = existingContact?.lead_source || signal.source;
  const icp_score = company.icp_score || 0;

  // Get max intent from signals table
  const { data: intentSignals } = await sb
    .from("signals")
    .select("intent_score")
    .eq("domain", signal.domain)
    .order("intent_score", { ascending: false })
    .limit(1);
  const intent_score = intentSignals?.[0]?.intent_score || existingContact?.intent_score || 0;
  const total_score = icp_score + intent_score;
  const tier = computeTier(total_score);
  const tier_display = tier.charAt(0).toUpperCase() + tier.slice(1);

  field("Contact", `${first_name} ${last_name}`);
  field("Title", title);
  field("Email", email);
  field("LinkedIn", linkedin_url);
  field("Phone", phone);
  field("ICP score", icp_score);
  field("Intent score", intent_score);
  field("Total score", total_score);
  field("Tier", tier_display);
  field("Existing in Supabase", existingContact ? `yes (id: ${existingContact.id})` : "no — would create new");
  field("Existing in HubSpot", existingContact?.hubspot_contact_id || "no");

  // MQL check
  const lead_type = existingContact?.lead_type || deriveLeadType(lead_source);
  const contactIsMQL = isMql({
    lead_type,
    lead_tier: tier,
    title,
    sub_market: company.sub_market,
  }) && intent_score > 0;

  const buyerTitle = isMqlBuyerTitle(title);

  field("Lead type", lead_type);
  field("Buyer title match", buyerTitle);
  field("SLED sub-market", isSledSubMarket(company.sub_market));
  field("MQL verdict", contactIsMQL, contactIsMQL ? "WOULD FIRE SLACK ALERT" : "would NOT fire alert");

  // Push gate
  const pushGateInput = {
    email: email || null,
    has_existing_hubspot_contact: !!existingContact?.hubspot_contact_id,
    domain: signal.domain,
    title,
    icp_score,
    lead_tier: tier,
    lead_source,
    vertical_fit_score: company.vertical_fit_score || 0,
    sub_market: company.sub_market,
    country: company.country,
  };
  const pushGateResultObj = passesContactPushGateWithReason(pushGateInput);
  field("Push gate", pushGateResultObj.passes ? "PASS — would push to HubSpot" : `BLOCKED: ${pushGateResultObj.reason}`);

  // ── Step 5: HubSpot contact payload ──
  if (pushGateResultObj.passes && email) {
    section("STEP 5: HUBSPOT CONTACT PAYLOAD");

    const aeOwner = deriveAeOwner(company.sub_market);
    const ownerHsId = OWNER_IDS[aeOwner] || undefined;

    const contactPayload: Record<string, any> = {
      email,
      firstname: first_name,
      lastname: last_name,
      jobtitle: title,
      company: company.name,
      hs_linkedin_url: linkedin_url,
      lead_tier: tier_display === "Cold" ? "" : tier_display,
      lead_temp: tier_display === "Cool" ? "Cold" : (tier_display || "Cold"),
      lead_origin: deriveLeadOrigin(lead_source),
      lead_type,
      clay_lead_source: lead_source,
      total_score: String(total_score),
      icp_score: String(icp_score),
      intent_score: String(intent_score),
      lead_summary: existingContact?.lead_summary || "(would generate AI summary)",
      sales_org_summary: company.sales_org_summary,
      sub_market: company.sub_market,
      city: company.city,
      state: company.state,
      phone,
      hubspot_owner_id: ownerHsId,
      lifecyclestage: contactIsMQL ? "marketingqualifiedlead" : undefined,
    };

    for (const [k, v] of Object.entries(contactPayload)) {
      if (v != null) field(k, typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : v);
    }

    // Association
    if (company.hubspot_company_id) {
      console.log(`\n  Would ASSOCIATE contact with company ${company.hubspot_company_id}`);
    }
  }

  // ── Step 6: Slack MQL alert ──
  if (contactIsMQL) {
    section("STEP 6: SLACK MQL ALERT (what AE would see)");

    const aeOwner = deriveAeOwner(company.sub_market);
    const aeMention = aeOwner === "rep_a" ? "@RepA" : aeOwner === "rep_b" ? "@RepB" : "";
    const tierEmoji = tier === "hot" ? "🔥" : "🟡";
    const tierLabel = tier === "hot" ? "Hot MQL" : "Warm MQL";

    // Build what the Slack message would look like (plain text version)
    const signalSource = signal.source === "syft_linkedin" ? "LinkedIn" : "Website";
    const pagesVisited = signal.pages_viewed || signal.session_pages_visited || "";
    const pageHint = pagesVisited ? ` → ${pagesVisited.split(",")[0]?.trim()}` : "";

    console.log(`  ${tierEmoji} ${tierLabel} · ${signalSource}${pageHint}  —  ${aeMention}`);
    console.log(`  ${first_name} ${last_name} — ${title} @ ${company.name}`);
    if (email) console.log(`  📧 ${email}${linkedin_url ? `  |  LinkedIn: ${linkedin_url}` : ""}`);
    console.log(`  📊 Total ${total_score}  |  ICP ${icp_score}  |  Intent ${intent_score}`);
    if (company.employee_count || company.city) {
      const parts = [];
      if (company.employee_count) parts.push(`👥 ${company.employee_count} employees`);
      if (company.city) parts.push(`📍 ${company.city}, ${company.state}`);
      console.log(`  ${parts.join("  |  ")}`);
    }
    if (company.sales_team_data) {
      const std = company.sales_team_data as any;
      const parts = [];
      if (std.ae_count > 0) parts.push(`${std.ae_count} AEs`);
      else parts.push("0 AEs");
      if (std.sdr_count > 0) parts.push(`${std.sdr_count} SDRs`);
      else parts.push("no SDRs");
      if (std.hiring_ae || std.hiring_sdr || std.hiring_sales) parts.push("hiring");
      console.log(`  🧑‍💼 ${parts.join(", ")}`);
    }
    if (existingContact?.lead_summary) {
      console.log(`  \n  Why this matters:`);
      console.log(`  ${existingContact.lead_summary}`);
    } else {
      console.log(`  \n  Why this matters:`);
      console.log(`  (AI summary would be generated by Claude at enrichment time)`);
    }
    console.log(`  \n  HubSpot: https://app.hubspot.com/contacts/244264386/contact/${existingContact?.hubspot_contact_id || "NEW"}`);
  }

  // ── Summary ──
  section("PIPELINE VERDICT");
  if (!hasIdentifier) {
    console.log("  BLOCKED: No email or LinkedIn. Contact would be dropped by normalize.");
    console.log("  This is the bug the fix addresses.");
  } else if (!pushGateResultObj.passes) {
    console.log("  BLOCKED: Push gate rejected. Contact would not reach HubSpot.");
  } else if (contactIsMQL) {
    console.log("  FULL FLOW: Signal → Company → Contact → HubSpot → Slack MQL alert");
    console.log("  AE would see this alert in Slack.");
  } else {
    console.log("  PARTIAL: Signal → Company → Contact → HubSpot (no Slack alert — not MQL)");
    console.log("  Contact would be in HubSpot but no alert fires.");
  }
}

main().catch(console.error);
