// One-shot script: triggers backfill-contacts for the 103 unscored Red Rows contacts
// Run via: npx tsx scripts/trigger-backfill-red-rows.ts
//
// Reads the unscored contacts JSON, batches them into groups of 10,
// and triggers the backfill-contacts task for each batch.

import { tasks } from "@trigger.dev/sdk/v3";

const API_KEY = "pat-na2-b2cd3510-c8c1-47f8-90d4-801850f2e177";
const BASE = "https://api.hubapi.com";

interface HubSpotContact {
  hubspot_contact_id: string;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  domain: string;
}

async function fetchRedRowsContacts(): Promise<HubSpotContact[]> {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  // Get all member IDs from list 219
  const allIds: string[] = [];
  let url = `${BASE}/crm/v3/lists/219/memberships?limit=100`;

  while (url) {
    const res = await fetch(url, { headers });
    const data = await res.json();
    allIds.push(...data.results.map((r: any) => r.recordId));
    url = data.paging?.next?.link || "";
  }

  console.log(`Found ${allIds.length} contacts in Red Rows list`);

  // Batch read contact properties
  const props = [
    "firstname", "lastname", "email", "company", "jobtitle",
    "lead_origin", "hs_object_id",
  ];

  const unscored: HubSpotContact[] = [];

  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    const res = await fetch(`${BASE}/crm/v3/objects/contacts/batch/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: chunk.map(id => ({ id })),
        properties: props,
      }),
    });
    const data = await res.json();

    for (const r of data.results || []) {
      const p = r.properties;
      const origin = p.lead_origin || "";

      // Skip contacts that already have Clay attribution
      if (origin) continue;

      const email = p.email || "";
      if (!email || !email.includes("@")) continue;

      const domain = email.split("@")[1].toLowerCase();

      unscored.push({
        hubspot_contact_id: p.hs_object_id,
        email,
        first_name: p.firstname || "",
        last_name: p.lastname || "",
        title: p.jobtitle || "",
        company: p.company || "",
        domain,
      });
    }
  }

  console.log(`${unscored.length} contacts need backfill (no lead_origin)`);
  return unscored;
}

async function main() {
  const contacts = await fetchRedRowsContacts();

  if (contacts.length === 0) {
    console.log("No contacts to backfill");
    return;
  }

  // Batch into groups of 10 (each batch = 1 trigger run)
  const BATCH_SIZE = 10;
  const batches: HubSpotContact[][] = [];

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    batches.push(contacts.slice(i, i + BATCH_SIZE));
  }

  console.log(`\nTriggering ${batches.length} batches of up to ${BATCH_SIZE} contacts each`);
  console.log(`Total Octave credits estimate: ~${new Set(contacts.map(c => c.domain)).size * 4}-${new Set(contacts.map(c => c.domain)).size * 5}`);
  console.log("");

  // Print domain summary
  const domainCounts = new Map<string, number>();
  for (const c of contacts) {
    domainCounts.set(c.domain, (domainCounts.get(c.domain) || 0) + 1);
  }
  console.log(`Unique domains: ${domainCounts.size}`);
  console.log("Domains:", [...domainCounts.entries()].map(([d, n]) => `${d}(${n})`).join(", "));
  console.log("");

  // Trigger each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const domains = [...new Set(batch.map(c => c.domain))];
    console.log(`Batch ${i + 1}/${batches.length}: ${batch.length} contacts across ${domains.length} domains`);

    const handle = await tasks.trigger("backfill-contacts", {
      contacts: batch,
    });

    console.log(`  → Triggered run: ${handle.id}`);
  }

  console.log(`\nAll ${batches.length} batches triggered. Monitor in Trigger.dev dashboard.`);
}

main().catch(console.error);
