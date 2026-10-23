// Enrichment audit logger — records every Cargo/LeadMagic API call
// to enrichment_log, upserts dedup cache and daily credit rollup.
// Non-blocking: failures are logged but never stop enrichment.

import { supabase } from "../lib/supabase.js";

export type Provider = "cargo" | "leadmagic";

export interface EnrichmentLogEntry {
  provider: Provider;
  operation: string;
  lookup_key: string;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown> | null;
  credits_estimated: number;
  trigger_source: string;
  success: boolean;
  error?: string;
  duration_ms?: number;
  contact_id?: string;
  company_id?: string;
  cargo_run_id?: string;
  cargo_workflow_id?: string;
  result_summary?: Record<string, unknown>;
}

export async function logEnrichmentCall(
  entry: EnrichmentLogEntry
): Promise<void> {
  try {
    // 1. Insert into enrichment_log
    const { data: logRow, error: logErr } = await supabase
      .from("enrichment_log")
      .insert({
        provider: entry.provider,
        operation: entry.operation,
        lookup_key: entry.lookup_key,
        input_payload: entry.input_payload,
        output_payload: entry.output_payload,
        credits_estimated: entry.credits_estimated,
        trigger_source: entry.trigger_source,
        success: entry.success,
        error: entry.error || null,
        duration_ms: entry.duration_ms || null,
        contact_id: entry.contact_id || null,
        company_id: entry.company_id || null,
        cargo_run_id: entry.cargo_run_id || null,
        cargo_workflow_id: entry.cargo_workflow_id || null,
        backfilled: false,
      })
      .select("id")
      .single();

    if (logErr) {
      console.error(
        `[enrichment-logger] enrichment_log insert failed:`,
        logErr.message
      );
      return;
    }

    const logId = logRow?.id;

    // 2. Upsert enrichment_dedup_cache (only on success)
    if (entry.success && logId) {
      const { error: cacheErr } = await supabase
        .from("enrichment_dedup_cache")
        .upsert(
          {
            provider: entry.provider,
            operation: entry.operation,
            lookup_key: entry.lookup_key,
            last_enriched_at: new Date().toISOString(),
            last_result_summary: entry.result_summary || null,
            enrichment_log_id: logId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "provider,operation,lookup_key" }
        );

      if (cacheErr) {
        console.error(
          `[enrichment-logger] dedup_cache upsert failed:`,
          cacheErr.message
        );
      }
    }

    // 3. Upsert enrichment_credits daily rollup (atomic increment via RPC)
    const today = new Date().toISOString().slice(0, 10);
    const { error: creditsErr } = await supabase.rpc(
      "upsert_enrichment_credits",
      {
        p_date: today,
        p_provider: entry.provider,
        p_operation: entry.operation,
        p_trigger_source: entry.trigger_source,
        p_credits: entry.credits_estimated,
        p_success: entry.success,
      }
    );

    if (creditsErr) {
      console.error(
        `[enrichment-logger] credits upsert failed:`,
        creditsErr.message
      );
    }
  } catch (err) {
    console.error(
      `[enrichment-logger] unexpected error:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ── Key normalization ───────────────────────────────────────────────

export function normalizeKey(
  type: "email" | "linkedin" | "name_domain" | "domain",
  value: string
): string {
  const v = (value || "").trim().toLowerCase();
  switch (type) {
    case "email":
      return v;
    case "linkedin":
      return v
        .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "")
        .replace(/\/+$/, "");
    case "name_domain":
      return v;
    case "domain":
      return v.replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/+$/, "");
  }
}

// ── Timer helper ────────────────────────────────────────────────────

export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}
