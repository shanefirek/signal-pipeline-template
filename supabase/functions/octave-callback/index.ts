// Supabase Edge Function: Octave Callback Receiver
// Receives async agent results from Octave → writes directly to octave_results table
// so the polling loop in waterfall.ts picks it up immediately.
//
// URL: https://ueazjxwfmqpwcnjchvgt.supabase.co/functions/v1/octave-callback
//
// Octave sends: x-request-id header + body { callbackUrl, data: { data: { company, score, ... } } }
// request_id comes from: x-request-id header, query param ?request_id=X, or body.requestId

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, api_key",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const url = new URL(req.url);

    // Extract request_id: x-request-id header (Octave's format), query param, or body.requestId
    const requestId = req.headers.get("x-request-id") || url.searchParams.get("request_id") || body?.requestId;
    if (!requestId) {
      // Log the full body keys so we can debug the Octave callback shape
      console.error("[octave-callback] No request_id found. Body keys:", Object.keys(body || {}));
      console.error("[octave-callback] Body preview:", JSON.stringify(body).slice(0, 500));
      return new Response(JSON.stringify({ error: "missing request_id", body_keys: Object.keys(body || {}) }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[octave-callback] Received callback for request_id: ${requestId}`);

    // Octave nests result inside data.data
    const result = body?.data?.data || body?.data || body;
    const score = result?.score || null;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Update octave_results row from pending → completed
    const { data: updated, error: updateErr } = await supabase
      .from("octave_results")
      .update({
        output_payload: result,
        score,
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("request_id", requestId)
      .eq("status", "pending")
      .select("id")
      .single();

    if (updateErr) {
      // Might be a duplicate callback or test — log but don't fail hard
      console.warn(`[octave-callback] Update issue for ${requestId}:`, updateErr.message);
      return new Response(JSON.stringify({ ok: false, request_id: requestId, warning: updateErr.message }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[octave-callback] Updated row ${updated?.id} for ${requestId}, score: ${score}`);

    return new Response(JSON.stringify({ ok: true, request_id: requestId, score }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[octave-callback] Error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
