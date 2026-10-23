import { schedules } from "@trigger.dev/sdk/v3";
import { hubspot } from "../lib/hubspot.js";

// UTM Backfill — runs every 6 hours
//
// Problem: HubSpot meetings links capture UTMs in hs_analytics_first_url
// but DON'T auto-populate custom contact properties (utm_source, utm_medium, utm_campaign).
// Landing pages with tracking code DO populate, but meetings pages don't.
//
// Fix: Parse hs_analytics_first_url, extract UTM params, write to custom properties.
// Only touches contacts where utm_campaign is empty but UTMs exist in the URL.

export const utmBackfill = schedules.task({
  id: "utm-backfill",
  cron: "0 */6 * * *", // Every 6 hours
  maxDuration: 120,
  run: async () => {
    let after: string | undefined;
    let fixed = 0;
    let skipped = 0;

    for (let page = 0; page < 50; page++) {
      const res = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: "hs_analytics_first_url", operator: "CONTAINS_TOKEN" as any, value: "utm_" },
            { propertyName: "utm_campaign", operator: "NOT_HAS_PROPERTY" as any },
          ],
        }],
        properties: ["email", "hs_analytics_first_url", "utm_source", "utm_medium", "utm_campaign"],
        limit: 100,
        ...(after ? { after } : {}),
      });

      for (const contact of res.results) {
        const url = contact.properties.hs_analytics_first_url;
        if (!url) continue;

        try {
          const u = new URL(url);
          const source = u.searchParams.get("utm_source");
          const medium = u.searchParams.get("utm_medium");
          const campaign = u.searchParams.get("utm_campaign");

          if (!source && !medium && !campaign) {
            skipped++;
            continue;
          }

          const properties: Record<string, string> = {};
          if (source) properties.utm_source = source;
          if (medium) properties.utm_medium = medium;
          if (campaign) properties.utm_campaign = campaign;

          await hubspot.crm.contacts.basicApi.update(contact.id, { properties });
          fixed++;
          console.log(`[utm-backfill] Fixed ${contact.properties.email}: ${JSON.stringify(properties)}`);
        } catch (e) {
          console.error(`[utm-backfill] Failed to parse URL for ${contact.properties.email}:`, e);
          skipped++;
        }
      }

      if (!res.paging?.next) break;
      after = res.paging.next.after;
    }

    console.log(`[utm-backfill] Done. Fixed: ${fixed}, Skipped: ${skipped}`);
    return { fixed, skipped };
  },
});
