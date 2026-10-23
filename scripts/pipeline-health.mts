// Pipeline health check — is the pipeline actually working end-to-end?
// Traces: signals → companies → contacts → HubSpot pushes → MQLs
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const days = parseInt(process.argv[2] || "7", 10);
const since = new Date(Date.now() - days * 86400000).toISOString();

console.log(`=== Pipeline Health — last ${days} days ===\n`);

// 1. Signals in
const { data: signals, count: signalCount } = await sb
  .from("raw_signals")
  .select("id, source, status, domain, created_at", { count: "exact" })
  .gte("created_at", since);

const byStatus: Record<string, number> = {};
const bySource: Record<string, number> = {};
const byDay: Record<string, number> = {};
for (const s of (signals || [])) {
  byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  bySource[s.source] = (bySource[s.source] || 0) + 1;
  const day = s.created_at?.substring(0, 10) || "?";
  byDay[day] = (byDay[day] || 0) + 1;
}

console.log(`1. SIGNALS IN: ${signalCount}`);
console.log(`   By status: ${JSON.stringify(byStatus)}`);
console.log(`   By source: ${JSON.stringify(bySource)}`);
console.log(`   By day: ${JSON.stringify(byDay)}`);

// Stuck signals
const { data: stuck } = await sb
  .from("raw_signals")
  .select("id, domain, status, created_at")
  .in("status", ["pending", "enriching", "scoring", "error"])
  .lt("created_at", new Date(Date.now() - 2 * 3600000).toISOString());
if (stuck?.length) {
  console.log(`   ⚠️ STUCK: ${stuck.length} signals older than 2h in non-terminal status`);
  for (const s of stuck.slice(0, 5)) {
    console.log(`      ${s.domain} — ${s.status} since ${s.created_at?.substring(0, 16)}`);
  }
} else {
  console.log(`   ✅ No stuck signals`);
}

// 2. Companies enriched
const { count: companiesEnriched } = await sb
  .from("companies")
  .select("id", { count: "exact", head: true })
  .gte("enriched_at", since);

const { data: recentCompanies } = await sb
  .from("companies")
  .select("name, domain, icp_score, lead_temp, sub_market, enriched_at")
  .gte("enriched_at", since)
  .order("enriched_at", { ascending: false })
  .limit(5);

console.log(`\n2. COMPANIES ENRICHED: ${companiesEnriched}`);
for (const c of (recentCompanies || [])) {
  console.log(`   ${c.name} (${c.domain}) ICP:${c.icp_score} ${c.lead_temp} ${c.sub_market} — ${c.enriched_at?.substring(0, 10)}`);
}

// 3. Contacts created
const { count: contactsCreated } = await sb
  .from("contacts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);

const { data: recentContacts } = await sb
  .from("contacts")
  .select("first_name, last_name, email, title, tier, domain, created_at, hubspot_contact_id")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(10);

console.log(`\n3. CONTACTS CREATED: ${contactsCreated}`);
for (const c of (recentContacts || [])) {
  const name = `${c.first_name || ""} ${c.last_name || ""}`.trim();
  const hs = c.hubspot_contact_id ? "→ HubSpot" : "local only";
  console.log(`   ${name} (${c.title || "no title"}) @ ${c.domain} — ${c.tier} — ${hs}`);
}

// 4. HubSpot pushes
const { data: pushes } = await sb
  .from("push_log")
  .select("entity_type, action, success, created_at")
  .gte("created_at", since);

const pushSummary: Record<string, { ok: number; fail: number }> = {};
for (const p of (pushes || [])) {
  const key = `${p.entity_type}/${p.action}`;
  if (!pushSummary[key]) pushSummary[key] = { ok: 0, fail: 0 };
  if (p.success) pushSummary[key].ok++;
  else pushSummary[key].fail++;
}

console.log(`\n4. HUBSPOT PUSHES: ${pushes?.length || 0}`);
for (const [key, s] of Object.entries(pushSummary)) {
  console.log(`   ${key}: ${s.ok} ok, ${s.fail} failed`);
}
if (!pushes?.length) console.log("   ⚠️ ZERO pushes in ${days} days");

// 5. MQLs
const { data: mqls } = await sb
  .from("contacts")
  .select("first_name, last_name, email, title, domain, tier, is_mql, created_at")
  .eq("is_mql", true)
  .gte("created_at", since);

console.log(`\n5. MQLs: ${mqls?.length || 0}`);
for (const m of (mqls || [])) {
  const name = `${m.first_name || ""} ${m.last_name || ""}`.trim();
  console.log(`   ✅ ${name} (${m.title}) @ ${m.domain} — ${m.created_at?.substring(0, 10)}`);
}
if (!mqls?.length) console.log("   ⚠️ ZERO MQLs in last ${days} days");

// 6. Enrichment log — are LeadMagic calls happening?
const { data: enrichLogs } = await sb
  .from("enrichment_log")
  .select("provider, operation, success, created_at")
  .gte("created_at", since);

const enrichSummary: Record<string, { ok: number; fail: number }> = {};
for (const e of (enrichLogs || [])) {
  const key = `${e.provider}/${e.operation}`;
  if (!enrichSummary[key]) enrichSummary[key] = { ok: 0, fail: 0 };
  if (e.success) enrichSummary[key].ok++;
  else enrichSummary[key].fail++;
}

console.log(`\n6. ENRICHMENT CALLS: ${enrichLogs?.length || 0}`);
for (const [key, s] of Object.entries(enrichSummary).sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))) {
  console.log(`   ${key}: ${s.ok} ok, ${s.fail} failed`);
}

// 7. Last successful pipeline run (signal → done)
const { data: lastDone } = await sb
  .from("raw_signals")
  .select("domain, company_name, created_at, status")
  .eq("status", "done")
  .order("created_at", { ascending: false })
  .limit(1);

console.log(`\n7. LAST COMPLETED SIGNAL:`);
if (lastDone?.[0]) {
  console.log(`   ${lastDone[0].company_name || lastDone[0].domain} — ${lastDone[0].created_at}`);
} else {
  console.log("   ⚠️ No signals with status=done found");
}

console.log("\n=== Done ===");
