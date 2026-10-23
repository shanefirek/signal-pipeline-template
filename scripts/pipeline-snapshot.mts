import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const REP_A = "162280197";
const REP_B = "163458119";

function ownerLabel(id: string | null): string {
  if (id === REP_A || id === "rep_a") return "RepA";
  if (id === REP_B || id === "rep_b") return "RepB";
  if (!id) return "Unassigned";
  return id;
}

async function main() {
  const now = new Date();
  console.log(`\n  Signal Pipeline Pipeline Snapshot — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })} ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}\n`);
  console.log("═".repeat(65));

  // ── AE Company Routing ──────────────────────────────────────────
  console.log("\n  AE COMPANY ROUTING\n");

  // Paginate — PostgREST caps at 1000 per request
  const tamCompanies: any[] = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from("companies")
      .select("ae_owner, tam_list, sub_market, tam_tier, icp_score, hubspot_company_id")
      .not("tam_list", "is", null)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    tamCompanies.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  const aeMap = new Map<string, { total: number; higher_ed: number; k12: number; other: number; t1: number; t2: number; t3: number; dq: number; in_hubspot: number }>();

  for (const c of tamCompanies || []) {
    const owner = ownerLabel(c.ae_owner);
    if (!aeMap.has(owner)) aeMap.set(owner, { total: 0, higher_ed: 0, k12: 0, other: 0, t1: 0, t2: 0, t3: 0, dq: 0, in_hubspot: 0 });
    const entry = aeMap.get(owner)!;
    entry.total++;
    if (c.sub_market === "Higher Ed") entry.higher_ed++;
    else if (c.sub_market === "K12 EdTech SaaS") entry.k12++;
    else entry.other++;
    if (c.tam_tier === "T1") entry.t1++;
    else if (c.tam_tier === "T2") entry.t2++;
    else if (c.tam_tier === "T3") entry.t3++;
    else entry.dq++;
    if (c.hubspot_company_id) entry.in_hubspot++;
  }

  for (const [owner, stats] of [...aeMap.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${owner}`);
    console.log(`    Companies: ${stats.total} (${stats.higher_ed} Higher Ed, ${stats.k12} K-12, ${stats.other} other)`);
    console.log(`    Tiers: ${stats.t1} T1, ${stats.t2} T2, ${stats.t3} T3, ${stats.dq} DQ`);
    console.log(`    In HubSpot: ${stats.in_hubspot} of ${stats.total} (${Math.round(stats.in_hubspot / stats.total * 100)}%)`);
    console.log("");
  }

  // ── AE Contact Routing ──────────────────────────────────────────
  console.log("─".repeat(65));
  console.log("\n  AE CONTACT ROUTING\n");

  const contacts: any[] = [];
  offset = 0;
  while (true) {
    const { data } = await supabase
      .from("contacts")
      .select("ae_owner, lead_source, tier, email, linkedin_url, phone, hubspot_contact_id, icp_score, company_id")
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    contacts.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // TAM contacts (have ae_owner or lead_source = tam_import)
  const tamContacts = (contacts || []).filter(c =>
    c.lead_source === "tam_import" || c.ae_owner
  );
  const signalContacts = (contacts || []).filter(c =>
    c.lead_source !== "tam_import" && !c.ae_owner
  );

  const contactAeMap = new Map<string, { total: number; with_email: number; with_phone: number; with_linkedin: number; in_hubspot: number; by_tier: Record<string, number> }>();

  for (const c of tamContacts) {
    const owner = ownerLabel(c.ae_owner);
    if (!contactAeMap.has(owner)) contactAeMap.set(owner, { total: 0, with_email: 0, with_phone: 0, with_linkedin: 0, in_hubspot: 0, by_tier: {} });
    const entry = contactAeMap.get(owner)!;
    entry.total++;
    if (c.email) entry.with_email++;
    if (c.phone) entry.with_phone++;
    if (c.linkedin_url) entry.with_linkedin++;
    if (c.hubspot_contact_id) entry.in_hubspot++;
    const tier = c.tier || "unscored";
    entry.by_tier[tier] = (entry.by_tier[tier] || 0) + 1;
  }

  for (const [owner, stats] of [...contactAeMap.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${owner} — TAM Contacts`);
    console.log(`    Total: ${stats.total}`);
    console.log(`    With email: ${stats.with_email} (${Math.round(stats.with_email / stats.total * 100)}%)`);
    console.log(`    With LinkedIn: ${stats.with_linkedin} (${Math.round(stats.with_linkedin / stats.total * 100)}%)`);
    console.log(`    With phone: ${stats.with_phone} (${Math.round(stats.with_phone / stats.total * 100)}%)`);
    console.log(`    In HubSpot: ${stats.in_hubspot} of ${stats.total}`);
    const tiers = Object.entries(stats.by_tier).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${n}`).join(", ");
    console.log(`    Tiers: ${tiers}`);
    console.log("");
  }

  // ── Signal Pipeline (inbound) ───────────────────────────────────
  console.log("─".repeat(65));
  console.log("\n  SIGNAL PIPELINE (inbound)\n");

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { count: signals24h } = await supabase
    .from("raw_signals")
    .select("*", { count: "exact", head: true })
    .gte("created_at", twentyFourHoursAgo);

  const { count: signals7d } = await supabase
    .from("raw_signals")
    .select("*", { count: "exact", head: true })
    .gte("created_at", sevenDaysAgo);

  const { data: recentSignals } = await supabase
    .from("raw_signals")
    .select("source, status, validation_gate")
    .gte("created_at", sevenDaysAgo)
    .range(0, 9999);

  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let passedGate = 0;
  for (const s of recentSignals || []) {
    bySource.set(s.source || "unknown", (bySource.get(s.source || "unknown") || 0) + 1);
    byStatus.set(s.status || "unknown", (byStatus.get(s.status || "unknown") || 0) + 1);
    if (s.validation_gate) passedGate++;
  }

  console.log(`  Last 24h: ${signals24h || 0} signals`);
  console.log(`  Last 7d: ${signals7d || 0} signals (${passedGate} passed gate)`);
  console.log(`  By source: ${[...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  console.log(`  By status: ${[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ")}`);

  // Signal contacts (MQLs)
  console.log("\n  MQL contacts (signal-driven, not TAM):");
  const mqlByTier = new Map<string, number>();
  let mqlInHubspot = 0;
  let mqlTotal = signalContacts.length;
  for (const c of signalContacts) {
    const tier = c.tier || "unscored";
    mqlByTier.set(tier, (mqlByTier.get(tier) || 0) + 1);
    if (c.hubspot_contact_id) mqlInHubspot++;
  }
  console.log(`    Total: ${mqlTotal}`);
  console.log(`    In HubSpot: ${mqlInHubspot}`);
  console.log(`    Tiers: ${[...mqlByTier.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ")}`);

  // ── Cold / Backlog ──────────────────────────────────────────────
  console.log("\n" + "─".repeat(65));
  console.log("\n  COLD / BACKLOG\n");

  const { count: coldCompanies } = await supabase
    .from("companies")
    .select("*", { count: "exact", head: true })
    .is("tam_list", null)
    .is("hubspot_company_id", null)
    .not("enriched_at", "is", null);

  const { count: orphanedContacts } = await supabase
    .from("contacts")
    .select("*", { count: "exact", head: true })
    .is("hubspot_contact_id", null)
    .is("email", null);

  const { count: pendingSignals } = await supabase
    .from("raw_signals")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "enriching"]);

  console.log(`  Enriched companies not in HubSpot and not TAM: ${coldCompanies || 0}`);
  console.log(`  Contacts with no email and not in HubSpot: ${orphanedContacts || 0}`);
  console.log(`  Signals stuck pending/enriching: ${pendingSignals || 0}`);

  // ── HubSpot Push State ──────────────────────────────────────────
  console.log("\n" + "─".repeat(65));
  console.log("\n  HUBSPOT PUSH STATE\n");

  const { count: hsCompanies } = await supabase
    .from("companies")
    .select("*", { count: "exact", head: true })
    .not("hubspot_company_id", "is", null);

  const { count: hsContacts } = await supabase
    .from("contacts")
    .select("*", { count: "exact", head: true })
    .not("hubspot_contact_id", "is", null);

  const hubspotEnabled = process.env.HUBSPOT_PUSH_ENABLED === "true";

  console.log(`  HUBSPOT_PUSH_ENABLED: ${hubspotEnabled ? "ON" : "OFF"}`);
  console.log(`  Companies in HubSpot: ${hsCompanies || 0}`);
  console.log(`  Contacts in HubSpot: ${hsContacts || 0}`);
  if (!hubspotEnabled) {
    console.log(`  ⚠ Push is OFF — enrichment runs but nothing writes to HubSpot`);
  }

  console.log("\n" + "═".repeat(65));
  console.log(`  Snapshot complete.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
