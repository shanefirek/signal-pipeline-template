#!/usr/bin/env npx tsx
/**
 * Pipeline Verification Script
 *
 * Implements pipeline-spec.md "How to verify" (lines 119-132).
 * Takes a signal ID or "latest" and checks every step of the pipeline.
 * Output: pass/fail per check with actual values.
 *
 * Usage:
 *   npx tsx scripts/verify-pipeline.mts              # verify last 5 signals
 *   npx tsx scripts/verify-pipeline.mts latest        # verify most recent signal
 *   npx tsx scripts/verify-pipeline.mts <signal-id>   # verify specific signal
 *   npx tsx scripts/verify-pipeline.mts --last 10     # verify last 10 signals
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Client } from "@hubspot/api-client";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const hubspot = new Client({ accessToken: process.env.HUBSPOT_API_KEY });

// ── Types ──────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  pass: boolean;
  value: string;
  expected?: string;
}

interface SignalReport {
  signalId: string;
  domain: string;
  contactName: string | null;
  status: string;
  createdAt: string;
  checks: CheckResult[];
  passCount: number;
  failCount: number;
  warnCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function check(name: string, pass: boolean, value: string, expected?: string): CheckResult {
  return { name, pass, value, expected };
}

function fmt(r: CheckResult): string {
  const icon = r.pass ? "PASS" : "FAIL";
  const exp = r.expected ? ` (expected: ${r.expected})` : "";
  return `  [${icon}] ${r.name}: ${r.value}${exp}`;
}

// ── Core verification ──────────────────────────────────────────────────

async function verifySignal(signalId: string): Promise<SignalReport> {
  const checks: CheckResult[] = [];

  // ── 1. Load signal from raw_signals ──
  const { data: signal, error: sigErr } = await supabase
    .from("raw_signals")
    .select("*")
    .eq("id", signalId)
    .single();

  if (sigErr || !signal) {
    return {
      signalId,
      domain: "unknown",
      contactName: null,
      status: "not_found",
      createdAt: "",
      checks: [check("Signal exists", false, `Not found: ${sigErr?.message || "no data"}`)],
      passCount: 0,
      failCount: 1,
      warnCount: 0,
    };
  }

  const domain = signal.domain || "unknown";
  const contactName = [signal.first_name, signal.last_name].filter(Boolean).join(" ") || null;

  // Check 1: Signal status
  checks.push(check(
    "Signal status",
    signal.status === "done" || signal.status === "filtered",
    signal.status,
    "done or filtered",
  ));

  // If filtered, that's valid — skip downstream checks
  if (signal.status === "filtered") {
    const passCount = checks.filter((c) => c.pass).length;
    return {
      signalId,
      domain,
      contactName,
      status: signal.status,
      createdAt: signal.created_at,
      checks,
      passCount,
      failCount: checks.length - passCount,
      warnCount: 0,
    };
  }

  // Check 2: Signal has contact_id linked (if contact was sent)
  const hadContact = signal.first_name || signal.email || signal.linkedin_url;
  if (hadContact) {
    checks.push(check(
      "Signal -> contact_id linked",
      !!signal.contact_id,
      signal.contact_id || "null",
      "uuid",
    ));
  }

  // Check 3: Signal has company_id linked
  checks.push(check(
    "Signal -> company_id linked",
    !!signal.company_id,
    signal.company_id || "null",
    "uuid",
  ));

  // Check: Syft contact data was extracted (if Syft sent a contact)
  if (signal.source?.startsWith("syft") && (signal.first_name || signal.last_name)) {
    // Title should have been extracted from lastSeenVisitorDetail
    checks.push(check(
      "Syft contact title extracted",
      !!signal.title,
      signal.title || "null",
      "non-null if Syft sent visitor detail",
    ));
  }

  // ── 2. Check company in Supabase ──
  let company: any = null;
  if (signal.company_id) {
    const { data } = await supabase
      .from("companies")
      .select("id, domain, name, city, state, country, description, icp_score, sub_market, linkedin_url, employee_count, hubspot_company_id, sales_team_data, lead_summary, sales_org_summary")
      .eq("id", signal.company_id)
      .single();
    company = data;
  } else if (domain !== "unknown") {
    const { data } = await supabase
      .from("companies")
      .select("id, domain, name, city, state, country, description, icp_score, sub_market, linkedin_url, employee_count, hubspot_company_id, sales_team_data, lead_summary, sales_org_summary")
      .eq("domain", domain)
      .single();
    company = data;
  }

  if (company) {
    checks.push(check("Company: city", !!company.city, company.city || "null"));
    checks.push(check("Company: state", !!company.state, company.state || "null"));
    checks.push(check("Company: country", !!company.country, company.country || "null"));
    checks.push(check("Company: description", !!company.description, company.description ? `${company.description.slice(0, 60)}...` : "null"));
    checks.push(check("Company: icp_score", company.icp_score != null && company.icp_score > 0, String(company.icp_score ?? "null"), "> 0"));
    checks.push(check("Company: sub_market", !!company.sub_market, company.sub_market || "null"));
  } else {
    checks.push(check("Company exists in Supabase", false, "not found"));
  }

  // ── 3. Check contact in Supabase ──
  let contact: any = null;
  if (signal.contact_id) {
    const { data } = await supabase
      .from("contacts")
      .select("id, email, title, tier, linkedin_url, phone, first_name, last_name, hubspot_contact_id, is_mql, mql_at, lead_summary, company_id, icp_score, intent_score, lead_type, ae_owner")
      .eq("id", signal.contact_id)
      .single();
    contact = data;
  }

  if (contact) {
    checks.push(check("Contact: email", !!contact.email, contact.email || "null"));
    checks.push(check("Contact: title", !!contact.title, contact.title || "null"));
    checks.push(check("Contact: tier", !!contact.tier, contact.tier || "null"));

    // LinkedIn: should be present if Syft sent it
    if (signal.linkedin_url) {
      checks.push(check(
        "Contact: linkedin_url (Syft sent one)",
        !!contact.linkedin_url,
        contact.linkedin_url || "null",
        "should match Syft",
      ));
    }

    // Name capitalization
    if (contact.first_name) {
      const properCase = contact.first_name[0] === contact.first_name[0].toUpperCase();
      checks.push(check("Contact: name capitalized", properCase, `${contact.first_name} ${contact.last_name}`));
    }

    // Company association
    if (company) {
      checks.push(check(
        "Contact: company_id matches signal company",
        contact.company_id === company.id,
        contact.company_id || "null",
        company.id,
      ));
    }
  } else if (hadContact) {
    checks.push(check("Contact exists in Supabase", false, "not found (Syft sent contact data)"));
  }

  // ── 4. Check HubSpot company ──
  if (company?.hubspot_company_id) {
    try {
      const hsCompany = await hubspot.crm.companies.basicApi.getById(
        company.hubspot_company_id,
        ["domain", "name", "city", "state", "country", "icp_score", "sub_market", "lead_summary"],
      );

      checks.push(check("HubSpot company exists", true, `ID ${company.hubspot_company_id}`));

      // Check for duplicates
      const searchRes = await hubspot.crm.companies.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: "domain",
            operator: "EQ" as any,
            value: domain,
          }],
        }],
        properties: ["domain", "name"],
        limit: 5,
      });

      checks.push(check(
        "HubSpot: no duplicate companies",
        searchRes.results.length <= 1,
        `${searchRes.results.length} companies with domain ${domain}`,
        "1",
      ));

      // Spot-check data match
      const hsProps = hsCompany.properties;
      if (company.sub_market) {
        checks.push(check(
          "HubSpot company: sub_market matches",
          hsProps.sub_market === company.sub_market,
          `HS=${hsProps.sub_market || "null"} SB=${company.sub_market}`,
        ));
      }
    } catch (err: any) {
      checks.push(check("HubSpot company exists", false, `Lookup failed: ${err.message}`));
    }
  } else if (company && company.sub_market && ["K-12 EdTech SaaS", "K12 EdTech SaaS", "Higher Ed", "Government & Public Sector"].includes(company.sub_market) && company.icp_score >= 50) {
    checks.push(check("HubSpot company: should be pushed (SLED + ICP >= 50)", false, "hubspot_company_id is null"));
  }

  // ── 5. Check HubSpot contact ──
  if (contact?.hubspot_contact_id) {
    try {
      const hsContact = await hubspot.crm.contacts.basicApi.getById(
        contact.hubspot_contact_id,
        ["email", "firstname", "lastname", "jobtitle", "lifecyclestage", "hs_linkedin_url", "icp_score", "intent_score"],
      );

      checks.push(check("HubSpot contact exists", true, `ID ${contact.hubspot_contact_id}`));

      // Check association with company
      if (company?.hubspot_company_id) {
        try {
          const assocRes = await hubspot.crm.contacts.associationsApi.getAll(
            contact.hubspot_contact_id,
            "companies",
          );
          const associatedCompanyIds = assocRes.results.map((a: any) => String(a.toObjectId));
          const isAssociated = associatedCompanyIds.includes(company.hubspot_company_id);
          checks.push(check(
            "HubSpot: contact associated with company",
            isAssociated,
            isAssociated ? `yes (${company.hubspot_company_id})` : `no — associated with [${associatedCompanyIds.join(", ")}]`,
            company.hubspot_company_id,
          ));
        } catch (err: any) {
          checks.push(check("HubSpot: contact-company association", false, `Lookup failed: ${err.message}`));
        }
      }

      // Check contact data
      const hsProps = hsContact.properties;
      if (contact.title) {
        checks.push(check(
          "HubSpot contact: title matches",
          hsProps.jobtitle === contact.title,
          `HS="${hsProps.jobtitle || "null"}" SB="${contact.title}"`,
        ));
      }

      // MQL lifecycle check
      if (contact.is_mql) {
        checks.push(check(
          "HubSpot: MQL lifecycle set",
          hsProps.lifecyclestage === "marketingqualifiedlead",
          hsProps.lifecyclestage || "null",
          "marketingqualifiedlead",
        ));
      }
    } catch (err: any) {
      checks.push(check("HubSpot contact exists", false, `Lookup failed: ${err.message}`));
    }
  }

  // ── 6. Check MQL + Slack if applicable ──
  if (contact?.is_mql) {
    // Check that Slack alert was logged in push_log
    const { data: slackLogs } = await supabase
      .from("push_log")
      .select("id, action, success, error, created_at")
      .eq("entity_type", "alert")
      .eq("entity_id", contact.id)
      .eq("destination", "slack")
      .order("created_at", { ascending: false })
      .limit(1);

    if (slackLogs && slackLogs.length > 0) {
      checks.push(check(
        "Slack MQL alert logged",
        slackLogs[0].success,
        slackLogs[0].success ? "sent" : `failed: ${slackLogs[0].error}`,
      ));
    } else {
      checks.push(check("Slack MQL alert logged", false, "no push_log entry for this contact"));
    }

    // Check summary quality
    if (contact.lead_summary) {
      const summaryLower = contact.lead_summary.toLowerCase();
      const saysNoSalesData = summaryLower.includes("no sales") || summaryLower.includes("no data");
      const hasSalesTeamData = company?.sales_team_data &&
        (company.sales_team_data.ae_count > 0 || company.sales_team_data.sdr_count > 0);

      if (hasSalesTeamData && saysNoSalesData) {
        checks.push(check(
          "Summary: does not say 'no sales data' when data exists",
          false,
          `Summary says no data but company has sales_team_data (AEs: ${company.sales_team_data.ae_count}, SDRs: ${company.sales_team_data.sdr_count})`,
        ));
      }
    }
  }

  // ── 7. Check push_log for gate rejections ──
  if (contact) {
    const { data: gateRejects } = await supabase
      .from("push_log")
      .select("action, payload, created_at")
      .eq("entity_id", contact.id)
      .eq("action", "gate_rejected")
      .order("created_at", { ascending: false })
      .limit(3);

    if (gateRejects && gateRejects.length > 0) {
      for (const gr of gateRejects) {
        const reason = (gr.payload as any)?.reason || "unknown";
        // Gate rejections are not failures — they're the system working correctly
        checks.push(check("Push gate rejection (info)", true, `Rejected: ${reason}`));
      }
    }
  }

  // ── 8. Check enrichment_log ──
  if (contact || company) {
    const entityId = contact?.id || company?.id;
    const entityType = contact ? "contact_id" : "company_id";

    const { data: enrichLogs, error: elErr } = await supabase
      .from("enrichment_log")
      .select("provider, operation, success, error, created_at")
      .eq(entityType, entityId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (enrichLogs && enrichLogs.length > 0) {
      const successCount = enrichLogs.filter((l) => l.success).length;
      const failCount = enrichLogs.filter((l) => !l.success).length;
      checks.push(check(
        "Enrichment logged",
        true,
        `${enrichLogs.length} ops (${successCount} ok, ${failCount} failed): ${[...new Set(enrichLogs.map((l) => l.operation))].join(", ")}`,
      ));

      // Flag any failures
      for (const log of enrichLogs.filter((l) => !l.success)) {
        checks.push(check(
          `Enrichment: ${log.provider}/${log.operation}`,
          false,
          `Failed: ${log.error || "unknown error"}`,
        ));
      }
    } else {
      // Only flag if this is a recent signal (older ones may predate logging)
      const signalAge = Date.now() - new Date(signal.created_at).getTime();
      const isRecent = signalAge < 7 * 24 * 60 * 60 * 1000; // 7 days
      if (isRecent) {
        checks.push(check("Enrichment logged", false, "no enrichment_log entries found"));
      }
    }
  }

  // ── Tally ──
  const passCount = checks.filter((c) => c.pass).length;
  const failCount = checks.filter((c) => !c.pass).length;

  return {
    signalId,
    domain,
    contactName,
    status: signal.status,
    createdAt: signal.created_at,
    checks,
    passCount,
    failCount,
    warnCount: 0,
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let signalIds: string[] = [];

  if (args.length === 0 || args[0] === "--last") {
    // Default: last N signals (status=done or error, skip filtered noise)
    const count = args[1] ? parseInt(args[1]) : 5;
    const { data } = await supabase
      .from("raw_signals")
      .select("id")
      .in("status", ["done", "error", "scoring", "enriching", "pushing"])
      .order("created_at", { ascending: false })
      .limit(count);

    signalIds = (data || []).map((s) => s.id);
    console.log(`\nVerifying last ${signalIds.length} non-filtered signals...\n`);
  } else if (args[0] === "latest") {
    const { data } = await supabase
      .from("raw_signals")
      .select("id")
      .in("status", ["done", "error", "scoring", "enriching", "pushing"])
      .order("created_at", { ascending: false })
      .limit(1);

    signalIds = (data || []).map((s) => s.id);
  } else if (args[0] === "stuck") {
    // Find signals stuck in non-terminal states for >30 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("raw_signals")
      .select("id, domain, status, created_at")
      .in("status", ["scoring", "enriching", "pushing", "pending"])
      .lt("created_at", thirtyMinAgo)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!data || data.length === 0) {
      console.log("\nNo stuck signals found (good).\n");
      return;
    }

    console.log(`\n${data.length} STUCK SIGNALS (>30 min in non-terminal state):\n`);
    for (const s of data) {
      const age = Math.round((Date.now() - new Date(s.created_at).getTime()) / 60000);
      console.log(`  ${s.id}  ${s.domain}  status=${s.status}  age=${age}min`);
    }
    console.log();
    signalIds = data.map((s) => s.id);
  } else {
    // Specific signal ID
    signalIds = [args[0]];
  }

  if (signalIds.length === 0) {
    console.log("No signals found to verify.\n");
    return;
  }

  // ── Run verification ──
  let totalPass = 0;
  let totalFail = 0;

  for (const id of signalIds) {
    const report = await verifySignal(id);
    totalPass += report.passCount;
    totalFail += report.failCount;

    // Header
    const statusIcon = report.failCount === 0 ? "OK" : "ISSUES";
    console.log(`--- [${statusIcon}] ${report.domain} ${report.contactName ? `(${report.contactName})` : ""} ---`);
    console.log(`    signal=${report.signalId.slice(0, 8)}  status=${report.status}  created=${report.createdAt}`);

    // Checks
    for (const c of report.checks) {
      console.log(fmt(c));
    }

    console.log(`    ${report.passCount} passed, ${report.failCount} failed\n`);
  }

  // ── Summary ──
  console.log("=".repeat(60));
  console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed across ${signalIds.length} signals`);
  if (totalFail > 0) {
    console.log(`\nPipeline has issues. Review FAIL items above.`);
    process.exit(1);
  } else {
    console.log(`\nPipeline looks healthy.`);
  }
}

main().catch((err) => {
  console.error("Verification script failed:", err);
  process.exit(2);
});
