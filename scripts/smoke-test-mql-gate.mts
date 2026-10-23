#!/usr/bin/env npx tsx
// Smoke test: run the NEW isMql() gate against real Supabase data
// Proves the fix works against actual contacts that fired bad alerts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { isMql, isMqlBuyerTitle, passesContactDiscoveryGate } from "../src/lib/gates.ts";
import { deriveLeadType } from "../src/lib/constants.ts";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function main() {
  // 1. All contacts marked is_mql=true in the last 48h
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: recentMqls } = await supabase
    .from("contacts")
    .select("first_name, last_name, title, email, domain, tier, lead_source, lead_type, is_mql, hubspot_contact_id, created_at")
    .eq("is_mql", true)
    .gte("created_at", twoDaysAgo)
    .order("created_at", { ascending: false });

  const domains = [...new Set((recentMqls || []).map((c) => c.domain))];
  const { data: companies } = await supabase
    .from("companies")
    .select("domain, sub_market, sales_team_data")
    .in("domain", domains);
  const companyMap = new Map((companies || []).map((c) => [c.domain, c]));

  console.log("=== RECENT MQLs (48h) — NEW isMql() gate verdict ===\n");

  let wouldPass = 0;
  let wouldBlock = 0;

  for (const c of recentMqls || []) {
    const company = companyMap.get(c.domain);
    const newResult = isMql({
      lead_type: c.lead_type || deriveLeadType(c.lead_source),
      lead_tier: c.tier,
      title: c.title,
      sub_market: company?.sub_market || null,
    });
    const buyerTitle = isMqlBuyerTitle(c.title);
    const verdict = newResult ? "✅ PASS" : "🚫 BLOCK";
    if (newResult) wouldPass++;
    else wouldBlock++;

    console.log(`${verdict}  ${c.first_name || ""} ${c.last_name || ""} — "${c.title}" @ ${c.domain}`);
    console.log(`         tier=${c.tier} sub_market=${company?.sub_market || "null"} buyer_title=${buyerTitle} hubspot=${c.hubspot_contact_id ? "yes" : "no"}`);
  }

  console.log(`\n--- ${wouldPass} PASS, ${wouldBlock} BLOCKED ---\n`);

  // 2. Carnegie discovery gate
  console.log("=== CARNEGIE DISCOVERY GATE ===");
  const { data: carnegie } = await supabase
    .from("companies")
    .select("icp_score, employee_count, vertical_fit_score, sales_team_data")
    .eq("domain", "carnegiehighered.com")
    .single();

  if (carnegie) {
    const std = carnegie.sales_team_data as any;
    const hasSalesTeam = std
      ? std.ae_count > 0 || std.sdr_count > 0 || std.hiring_sales || std.hiring_ae || std.hiring_sdr
      : undefined;
    const gateResult = passesContactDiscoveryGate({
      icp_score: carnegie.icp_score,
      vertical_fit_score: carnegie.vertical_fit_score || 0,
      employee_count: carnegie.employee_count,
      has_sales_team: hasSalesTeam,
    });
    console.log(`ae=${std?.ae_count} sdr=${std?.sdr_count} hiring=${std?.hiring_sales}/${std?.hiring_ae}/${std?.hiring_sdr}`);
    console.log(`has_sales_team=${hasSalesTeam}`);
    console.log(`discovery gate: ${gateResult ? "PASS (would discover)" : "BLOCKED (saves credits)"}\n`);
  }

  // 3. Sanity check: known good MQL titles against the allowlist
  console.log("=== BUYER TITLE ALLOWLIST SANITY ===");
  const goodTitles = ["CEO", "Founder", "Co-Founder & CEO", "VP Sales", "CRO", "Head of Sales", "Director of Sales", "President"];
  const badTitles = ["Program Manager", "Chief Development Officer", "AVP Marketing", "Director of Mathematics", "Software Engineer", "Account Executive"];
  for (const t of goodTitles) {
    const result = isMqlBuyerTitle(t);
    console.log(`${result ? "✅" : "❌ WRONG"} ${t} → ${result}`);
  }
  for (const t of badTitles) {
    const result = isMqlBuyerTitle(t);
    console.log(`${result ? "❌ WRONG" : "🚫"} ${t} → ${result}`);
  }
}

main().catch(console.error);
