// Supabase Edge Function: Syft Webhook Receiver
// Receives raw Syft webhook POST → forwards to BOTH:
//   1. Trigger.dev syft-webhook task (V2 pipeline)
//   2. Clay webhook tables (V1 pipeline — parallel run during cutover)
//
// URL: https://ueazjxwfmqpwcnjchvgt.supabase.co/functions/v1/syft-webhook
// Add ?source=syft_website or ?source=syft_linkedin to distinguish signal type
//
// Syft sends: { account, lead, session?, linkedin? }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TRIGGER_API_URL = "https://api.trigger.dev";
const TRIGGER_SECRET_KEY = Deno.env.get("TRIGGER_SECRET_KEY");

// Clay webhook URLs (V1 parallel run)
const CLAY_WEBHOOKS: Record<string, string> = {
  syft_website: "https://api.clay.com/v3/sources/webhook/website-visitors-webhook-f6c5e51f-a00a-447c-8344-3e075aec8ff7",
  syft_linkedin: "https://api.clay.com/v3/sources/webhook/linkedin-activity-webhook-8b23cf18-bced-4211-8c64-bde528d305d3",
};
if (!TRIGGER_SECRET_KEY) {
  console.error("[syft-webhook] TRIGGER_SECRET_KEY not set — configure via: supabase secrets set TRIGGER_SECRET_KEY=<key>");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const url = new URL(req.url);

    // Determine signal source from query param or payload heuristics
    let source = url.searchParams.get("source") || "syft_website";
    if (!["syft_website", "syft_linkedin"].includes(source)) {
      source = "syft_website";
    }

    // Heuristic: if payload has linkedin action data, it's a LinkedIn signal
    if (body.linkedin?.action || body.lead?.linkedin_action) {
      source = "syft_linkedin";
    }

    // Skip Clay forward when called FROM Clay (prevents feedback loop)
    const fromClay = url.searchParams.get("from") === "clay";

    console.log(`[syft-webhook] Received ${source} signal for domain: ${body.account?.domain || "unknown"}${fromClay ? " (from Clay — skip Clay forward)" : ""}`);

    if (!TRIGGER_SECRET_KEY) {
      return new Response(JSON.stringify({ error: "TRIGGER_SECRET_KEY not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Trigger the Trigger.dev task via REST API
    const triggerRes = await fetch(`${TRIGGER_API_URL}/api/v1/tasks/syft-webhook/trigger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TRIGGER_SECRET_KEY}`,
      },
      body: JSON.stringify({
        payload: {
          source,
          data: body,
        },
      }),
    });

    if (!triggerRes.ok) {
      const errText = await triggerRes.text();
      console.error(`[syft-webhook] Trigger.dev API error: ${triggerRes.status} ${errText}`);
      return new Response(JSON.stringify({ error: "trigger_failed", details: errText }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await triggerRes.json();
    console.log(`[syft-webhook] Task triggered: ${result.id}`);

    // Forward to Clay webhook (parallel run — fire-and-forget, don't block on Clay)
    // Skip when called from Clay to prevent feedback loop
    const clayUrl = CLAY_WEBHOOKS[source];
    if (clayUrl && !fromClay) {
      fetch(clayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => {
        console.log(`[syft-webhook] Clay forward (${source}): ${r.status}`);
      }).catch((err) => {
        console.error(`[syft-webhook] Clay forward failed:`, err);
      });
    }

    return new Response(JSON.stringify({ ok: true, run_id: result.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[syft-webhook] Error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
