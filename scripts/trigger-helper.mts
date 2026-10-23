#!/usr/bin/env npx tsx
// Helper to trigger Trigger.dev tasks from scripts
// Uses the SDK's tasks.trigger() which properly routes to our project

import { configure, tasks } from "@trigger.dev/sdk/v3";
import * as dotenv from "dotenv";
dotenv.config();

// Configure SDK with our project credentials
configure({
  secretKey: process.env.TRIGGER_SECRET_KEY,
});

export async function triggerDiscoverContact(payload: {
  domain: string;
  company_id?: string | null;
  lead_source?: string;
  lead_type?: "inbound" | "outbound" | "referral" | "unknown";
  ae_owner?: string;
}) {
  const handle = await tasks.trigger("discover-contact", payload);
  console.log(`[trigger] discover-contact for ${payload.domain}: ${handle.id}`);
  return handle;
}

export async function triggerEnrichContact(payload: {
  domain: string;
  contact_name: string;
  raw_signal_id?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  lead_source?: string;
  lead_type?: "inbound" | "outbound" | "referral" | "unknown";
  ae_owner?: string;
}) {
  const handle = await tasks.trigger("enrich-contact", payload);
  console.log(`[trigger] enrich-contact for ${payload.contact_name} @ ${payload.domain}: ${handle.id}`);
  return handle;
}

// Test if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Testing trigger helper...");
  triggerDiscoverContact({
    domain: "trigger-test-helper.com",
    lead_source: "test",
  }).then((handle) => {
    console.log("Success! Run ID:", handle.id);
  }).catch(console.error);
}
