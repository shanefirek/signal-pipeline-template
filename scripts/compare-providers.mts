#!/usr/bin/env npx tsx
// Compare LeadMagic vs Cargo for company + contact data
// Usage: npx tsx scripts/compare-providers.mts

import "dotenv/config";

const CARGO_KEY = process.env.CARGO_API_KEY || "";
const LEADMAGIC_KEY = process.env.LEADMAGIC_API_KEY || "";

const CARGO_BASE = "https://api.getcargo.io/v1";
const LEADMAGIC_BASE = "https://api.leadmagic.io/v1";

// Cargo workflow UUIDs
const CARGO_ENRICH_COMPANY = "e540a04a-d45a-4fb3-819d-e41b9a858ec1";
const CARGO_FIND_STAKEHOLDERS = "943e8a18-3b9c-42a6-adf1-5f88aea6d341";

// Test domains - mix of company sizes
const TEST_DOMAINS = [
  "schoolmint.com",     // EdTech, known
  "instructure.com",    // Canvas, large
  "exampleco.com",        // EdTech mid-size
];

// --- Cargo helpers ---

async function cargoRun(workflowUuid: string, data: Record<string, unknown>): Promise<any> {
  const headers = {
    Authorization: `Bearer ${CARGO_KEY}`,
    "Content-Type": "application/json",
  };

  // Submit
  const submitRes = await fetch(`${CARGO_BASE}/orchestration/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workflowUuid, data }),
  });
  const submitData = await submitRes.json() as any;
  const runId = submitData.run?.uuid;
  if (!runId) return { error: "Failed to submit", raw: submitData };

  // Poll
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`${CARGO_BASE}/orchestration/runs/${runId}`, { headers });
    const pollData = await pollRes.json() as any;
    if (pollData.run?.status === "success" || pollData.run?.status === "error") {
      if (pollData.run.status === "error") return { error: "Run failed", raw: pollData };
      break;
    }
  }

  // Get output
  const outputRes = await fetch(`${CARGO_BASE}/orchestration/runs/download-outputs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workflowUuid,
      outputNodeSlug: "end",
      format: "json",
      recordId: runId,
      statuses: ["success"],
    }),
  });
  const outputData = await outputRes.json() as any;
  if (outputData.url) {
    const r2 = await fetch(outputData.url);
    const results = await r2.json() as any[];
    return results?.[0]?.output || { error: "No output" };
  }
  return { error: "No URL", raw: outputData };
}

async function cargoEnrichCompany(domain: string) {
  console.log(`  [Cargo] Enriching company: ${domain}`);
  const start = Date.now();
  const result = await cargoRun(CARGO_ENRICH_COMPANY, { companyDomain: domain });
  return { ...result, _ms: Date.now() - start };
}

async function cargoFindStakeholders(domain: string) {
  console.log(`  [Cargo] Finding stakeholders: ${domain}`);
  const start = Date.now();
  const result = await cargoRun(CARGO_FIND_STAKEHOLDERS, { companyDomain: domain });
  return { ...result, _ms: Date.now() - start };
}

// --- LeadMagic helpers ---

async function leadmagicPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${LEADMAGIC_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-API-Key": LEADMAGIC_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

async function leadmagicCompany(domain: string) {
  console.log(`  [LeadMagic] Company search: ${domain}`);
  const start = Date.now();
  const result = await leadmagicPost("/companies/company-search", { company_domain: domain });
  return { ...result, _ms: Date.now() - start };
}

async function leadmagicEmployees(domain: string, limit = 30) {
  console.log(`  [LeadMagic] Employee finder: ${domain}`);
  const start = Date.now();
  const result = await leadmagicPost("/people/employee-finder", { company_domain: domain, limit });
  return { ...result, _ms: Date.now() - start };
}

// --- Main ---

async function compareDomain(domain: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DOMAIN: ${domain}`);
  console.log("=".repeat(60));

  // Run in parallel
  const [cargoCompany, cargoStakeholders, lmCompany, lmEmployees] = await Promise.all([
    cargoEnrichCompany(domain),
    cargoFindStakeholders(domain),
    leadmagicCompany(domain),
    leadmagicEmployees(domain),
  ]);

  console.log("\n--- CARGO COMPANY ---");
  console.log(JSON.stringify(cargoCompany, null, 2));

  console.log("\n--- CARGO STAKEHOLDERS ---");
  console.log(JSON.stringify(cargoStakeholders, null, 2));

  console.log("\n--- LEADMAGIC COMPANY ---");
  console.log(JSON.stringify(lmCompany, null, 2));

  console.log("\n--- LEADMAGIC EMPLOYEES ---");
  const empData = lmEmployees as any;
  if (empData.data || empData.employees || Array.isArray(empData)) {
    const list = empData.data || empData.employees || empData;
    console.log(`Found ${list.length} employees:`);
    list.slice(0, 10).forEach((e: any) => {
      console.log(`  - ${e.full_name || e.name}: ${e.title || e.job_title}`);
    });
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
  } else {
    console.log(JSON.stringify(lmEmployees, null, 2));
  }

  return { domain, cargoCompany, cargoStakeholders, lmCompany, lmEmployees };
}

async function main() {
  if (!CARGO_KEY) {
    console.error("CARGO_API_KEY not set");
    process.exit(1);
  }
  if (!LEADMAGIC_KEY) {
    console.error("LEADMAGIC_API_KEY not set");
    process.exit(1);
  }

  console.log("Comparing LeadMagic vs Cargo on test domains...\n");
  console.log(`Cargo credits: ~2,845 remaining`);
  console.log(`Test domains: ${TEST_DOMAINS.join(", ")}`);

  const results = [];
  for (const domain of TEST_DOMAINS) {
    const r = await compareDomain(domain);
    results.push(r);
  }

  // Summary
  console.log("\n\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  for (const r of results) {
    const cc = r.cargoCompany as any;
    const lc = r.lmCompany as any;
    console.log(`\n${r.domain}:`);
    console.log(`  Cargo:     ${cc.companyName || cc.name || "?"} | ${cc.employeeCount || cc.employees || "?"} emp | ${cc._ms}ms`);
    console.log(`  LeadMagic: ${lc.companyName || lc.name || "?"} | ${lc.employeeCount || "?"} emp | ${lc._ms}ms`);
  }
}

main().catch(console.error);
