import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { hubspot, isHubSpotPushEnabled } from "../lib/hubspot.js";

// MQL Summary Backfill — one-shot manual task
//
// Finds MQL contacts in HubSpot with missing or old-format lead_summary.
// Rebuilds summary from lead_summary (Supabase) or HubSpot company description.
// No Claude calls — structured template only.
//
// Replaces: refresh-mql-summaries.py (manual script)

const OLD_FORMAT_MARKERS = [
  "key decision-maker",
  "key contact for",
  "partnership opportunities",
  "could benefit from",
];

export const mqlSummaryBackfill = task({
  id: "mql-summary-backfill",
  run: async () => {
    let after: string | undefined;
    let updated = 0;
    let skipped = 0;

    for (let page = 0; page < 20; page++) {
      const searchRes = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [
            {
              propertyName: "lifecyclestage",
              operator: "EQ" as any,
              value: "marketingqualifiedlead",
            },
            {
              propertyName: "hs_lead_status",
              operator: "NEQ" as any,
              value: "UNQUALIFIED",
            },
          ],
        }],
        properties: [
          "email", "firstname", "lastname", "jobtitle", "company",
          "lead_summary", "icp_score", "sub_market",
        ],
        limit: 100,
        ...(after ? { after } : {}),
      });

      for (const contact of searchRes.results) {
        const summary = contact.properties.lead_summary || "";
        const needsUpdate = !summary ||
          OLD_FORMAT_MARKERS.some((marker) => summary.toLowerCase().includes(marker));

        if (!needsUpdate) {
          skipped++;
          continue;
        }

        const email = contact.properties.email;
        if (!email) { skipped++; continue; }

        // Try Supabase first (has lead summary)
        const domain = email.split("@")[1];
        let newSummary: string | null = null;

        if (domain) {
          const { data: supaCompany } = await supabase
            .from("companies")
            .select("name, lead_summary, sales_org_summary, sub_market")
            .eq("domain", domain)
            .limit(1)
            .single();

          if (supaCompany) {
            const rationale = supaCompany.lead_summary || supaCompany.sales_org_summary;
            if (rationale) {
              const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ");
              const title = contact.properties.jobtitle || "";
              const company = supaCompany.name || contact.properties.company || domain;
              newSummary = `${name}${title ? ` (${title})` : ""} at ${company}. ${rationale}`;
            }
          }
        }

        // Fall back to HubSpot company description
        if (!newSummary) {
          try {
            const assocRes = await hubspot.apiRequest({
              method: "GET",
              path: `/crm/v4/objects/contacts/${contact.id}/associations/companies`,
            });
            const assocData = await assocRes.json() as { results?: Array<{ toObjectId: string }> };
            if (assocData.results?.length) {
              const companyRes = await hubspot.crm.companies.basicApi.getById(
                assocData.results[0].toObjectId,
                ["name", "description", "industry", "numberofemployees"],
              );
              const desc = companyRes.properties.description;
              if (desc) {
                const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ");
                const title = contact.properties.jobtitle || "";
                const company = companyRes.properties.name || contact.properties.company || "";
                newSummary = `${name}${title ? ` (${title})` : ""} at ${company}. ${desc.slice(0, 200)}`;
              }
            }
          } catch (err) {
            console.error(`[mql-backfill] Company lookup failed for ${email}:`, err);
          }
        }

        if (!newSummary) {
          skipped++;
          continue;
        }

        // Push to HubSpot
        if (isHubSpotPushEnabled()) {
          try {
            await hubspot.crm.contacts.basicApi.update(contact.id, {
              properties: { lead_summary: newSummary.replace(/"/g, "'") },
            });
            updated++;
            console.log(`[mql-backfill] ${email}: summary updated`);
          } catch (err) {
            console.error(`[mql-backfill] Update failed for ${email}:`, err);
            skipped++;
          }
        } else {
          console.log(`[mql-backfill] ${email}: would update (HUBSPOT_PUSH_ENABLED off)`);
          updated++;
        }
      }

      if (!searchRes.paging?.next) break;
      after = searchRes.paging.next.after;
    }

    console.log(`[mql-backfill] Done. Updated: ${updated}, Skipped: ${skipped}`);
    return { updated, skipped };
  },
});
