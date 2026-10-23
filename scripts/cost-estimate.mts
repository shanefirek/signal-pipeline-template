import { Client } from "@hubspot/api-client";
const hubspot = new Client({ accessToken: "pat-na2-b2cd3510-c8c1-47f8-90d4-801850f2e177" });
const REP_A = "162280197";

async function main() {
  // RepA's open deals only
  const search = await hubspot.crm.deals.searchApi.doSearch({
    filterGroups: [{
      filters: [
        { propertyName: "hubspot_owner_id", operator: "EQ" as any, value: REP_A },
        { propertyName: "dealstage", operator: "NEQ" as any, value: "closedwon" },
        { propertyName: "dealstage", operator: "NEQ" as any, value: "closedlost" },
      ],
    }],
    properties: ["dealname", "dealstage", "amount"],
    limit: 100,
  });
  
  console.log(`=== RepA's open deals: ${search.results.length} ===\n`);
  
  const contactIds = new Set<string>();
  for (const deal of search.results) {
    const r = await hubspot.apiRequest({
      method: "GET",
      path: `/crm/v4/objects/deals/${deal.id}/associations/contacts?limit=20`,
    });
    const d = await r.json() as any;
    const dealContacts = d.results?.map((c: any) => c.toObjectId) || [];
    dealContacts.forEach((id: string) => contactIds.add(id));
    console.log(`  ${deal.properties.dealname} (${deal.properties.dealstage}, $${deal.properties.amount}) — ${dealContacts.length} contacts`);
  }
  
  console.log(`\nUnique contacts across RepA's open deals: ${contactIds.size}`);
  
  // Check phone coverage
  const arr = Array.from(contactIds);
  const res = await hubspot.crm.contacts.batchApi.read({
    inputs: arr.map(id => ({ id })),
    properties: ["firstname", "lastname", "email", "phone", "mobilephone"],
    propertiesWithHistory: [],
  });
  
  let withPhone = 0, withoutPhone = 0;
  const missing: any[] = [];
  for (const c of res.results) {
    const has = !!(c.properties.phone || c.properties.mobilephone);
    if (has) withPhone++;
    else {
      withoutPhone++;
      missing.push(c);
    }
  }
  
  console.log(`\n=== PHONE COVERAGE (RepA's open deals) ===`);
  console.log(`Has phone: ${withPhone}`);
  console.log(`Missing phone: ${withoutPhone}`);
  
  if (missing.length) {
    console.log(`\nMissing phone:`);
    for (const c of missing) {
      console.log(`  ${c.properties.firstname} ${c.properties.lastname} (${c.properties.email})`);
    }
    console.log(`\nCost to enrich: ${missing.length * 5} credits avg (${missing.length * 3}-${missing.length * 7} range)`);
  } else {
    console.log("\n✓ Zero credits needed — all of RepA's active deal contacts have phones.");
  }
}
main().catch(console.error);
