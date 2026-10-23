// HubSpot ↔ Supabase parity audit orchestration.
//
// Called by src/triggers/hubspot-parity-audit.ts on a weekly schedule.
// This module is READ-ONLY against HubSpot (search/read via SDK only)
// and WRITES ONLY to audit_* tables in Supabase.
//
// NO Slack. NO external notifications. All output is internal.
// Review happens in Supabase Studio via scripts/audit-queries.sql.
//
// Detection logic lives in Postgres functions defined in migration 012.
// This file just orchestrates: snapshot → rpc(detection) → prune → drift → write summary.

import { Client } from "@hubspot/api-client";
import { supabase } from "./supabase.js";

const hubspot = new Client({ accessToken: process.env.HUBSPOT_API_KEY });

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

// Index signatures added so these types are compatible with
// Trigger.dev's `logger.info(msg, record: Record<string, unknown>)` signature.

export interface SnapshotStats {
  contacts_total: number;
  companies_total: number;
  contacts_insert_errors: number;
  companies_insert_errors: number;
  [key: string]: unknown;
}

export interface DetectionStats {
  dedup_contact_rows: number;
  dedup_company_rows: number;
  archive_contact_rows: number;
  archive_company_rows: number;
  enrich_contact_rows: number;
  enrich_company_rows: number;
  quality_contact_rows: number;
  quality_company_rows: number;
  [key: string]: unknown;
}

export interface DriftStats {
  contacts_added: number;
  contacts_removed: number;
  contacts_modified: number;
  companies_added: number;
  companies_removed: number;
  companies_modified: number;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────
// Owner lookup — map hubspot_owner_id → display name
// ────────────────────────────────────────────────────────────────────────

async function loadOwners(): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  let after: string | undefined = undefined;
  do {
    const page = await hubspot.crm.owners.ownersApi.getPage(undefined, after, 100);
    for (const o of page.results) {
      const name =
        [o.firstName, o.lastName].filter(Boolean).join(" ") ||
        o.email ||
        o.id ||
        "(unknown)";
      owners.set(o.id || "", name);
    }
    after = page.paging?.next?.after;
  } while (after);
  return owners;
}

// ────────────────────────────────────────────────────────────────────────
// Snapshot contacts into audit_hs_contacts_snapshot
// ────────────────────────────────────────────────────────────────────────

async function snapshotContacts(
  snapshotId: Date,
  ownerMap: Map<string, string>,
): Promise<{ total: number; errors: number }> {
  let total = 0;
  let errors = 0;
  let after: string | undefined = undefined;
  const BATCH_SIZE = 100;

  do {
    const res: any = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [],
      properties: [
        "firstname",
        "lastname",
        "email",
        "jobtitle",
        "company",
        "associatedcompanyid",
        "hubspot_owner_id",
        "lifecyclestage",
        "lead_tier",
        "lead_origin",
        "signal_type",
        "icp_score",
        "lead_summary",
        "syft_last_seen",
        "hs_linkedin_url",
        "last_scored_date",
        "city",
        "state",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "first_touch_channel",
        "createdate",
        "lastmodifieddate",
      ],
      limit: BATCH_SIZE,
      after: after ? (parseInt(after, 10) as any) : undefined,
    } as any);

    const rows = res.results.map((c: any) => {
      const p = c.properties || {};
      return {
        snapshot_id: snapshotId.toISOString(),
        hubspot_id: c.id,
        email: p.email || null,
        firstname: p.firstname || null,
        lastname: p.lastname || null,
        jobtitle: p.jobtitle || null,
        associated_company_id: p.associatedcompanyid || null,
        hubspot_owner_id: p.hubspot_owner_id || null,
        owner_name: p.hubspot_owner_id
          ? ownerMap.get(p.hubspot_owner_id) || null
          : null,
        lifecyclestage: p.lifecyclestage || null,
        lead_tier: p.lead_tier || null,
        lead_origin: p.lead_origin || null,
        signal_type: p.signal_type || null,
        icp_score: p.icp_score ? parseFloat(p.icp_score) : null,
        lead_summary: p.lead_summary || null,
        syft_last_seen: p.syft_last_seen || null,
        hs_createdate: p.createdate || null,
        hs_lastmodified: p.lastmodifieddate || null,
        // Quality audit additions (migration 014)
        last_scored_date: p.last_scored_date || null,
        hs_linkedin_url: p.hs_linkedin_url || null,
        company_string: p.company || null,
        city: p.city || null,
        state: p.state || null,
        utm_source: p.utm_source || null,
        utm_medium: p.utm_medium || null,
        utm_campaign: p.utm_campaign || null,
        first_touch_channel: p.first_touch_channel || null,
        raw_properties: p,
      };
    });

    if (rows.length > 0) {
      const { error } = await supabase
        .from("audit_hs_contacts_snapshot")
        .insert(rows);
      if (error) {
        console.error("[parity] contact insert error:", error.message);
        errors += rows.length;
      } else {
        total += rows.length;
      }
    }

    const nextAfter = res.paging?.next?.after;
    after = nextAfter ? String(nextAfter) : undefined;
  } while (after);

  return { total, errors };
}

// ────────────────────────────────────────────────────────────────────────
// Snapshot companies into audit_hs_companies_snapshot
// ────────────────────────────────────────────────────────────────────────

async function snapshotCompanies(
  snapshotId: Date,
  ownerMap: Map<string, string>,
): Promise<{ total: number; errors: number }> {
  let total = 0;
  let errors = 0;
  let after: string | undefined = undefined;
  const BATCH_SIZE = 100;

  do {
    const res: any = await hubspot.crm.companies.searchApi.doSearch({
      filterGroups: [],
      properties: [
        "name",
        "domain",
        "hubspot_owner_id",
        "lifecyclestage",
        "lead_tier",
        "lead_temp",
        "lead_origin",
        "icp_score",
        "lead_summary",
        "sales_org_summary",
        "sub_market",
        "syft_last_seen",
        "last_scored_date",
        "first_touch_source",
        "touch_channels",
        "touch_campaigns",
        "utm_medium",
        "latest_source",
        "createdate",
        "hs_lastmodifieddate",
      ],
      limit: BATCH_SIZE,
      after: after ? (parseInt(after, 10) as any) : undefined,
    } as any);

    const rows = res.results.map((c: any) => {
      const p = c.properties || {};
      return {
        snapshot_id: snapshotId.toISOString(),
        hubspot_id: c.id,
        name: p.name || null,
        domain: p.domain || null,
        hubspot_owner_id: p.hubspot_owner_id || null,
        owner_name: p.hubspot_owner_id
          ? ownerMap.get(p.hubspot_owner_id) || null
          : null,
        lifecyclestage: p.lifecyclestage || null,
        lead_tier: p.lead_tier || null,
        lead_temp: p.lead_temp || null,
        lead_origin: p.lead_origin || null,
        icp_score: p.icp_score ? parseFloat(p.icp_score) : null,
        lead_summary: p.lead_summary || null,
        sales_org_summary: p.sales_org_summary || null,
        sub_market: p.sub_market || null,
        syft_last_seen: p.syft_last_seen || null,
        hs_createdate: p.createdate || null,
        hs_lastmodified: p.hs_lastmodifieddate || null,
        // Quality audit additions (migration 014)
        last_scored_date: p.last_scored_date || null,
        first_touch_source: p.first_touch_source || null,
        touch_channels: p.touch_channels || null,
        touch_campaigns: p.touch_campaigns || null,
        utm_medium: p.utm_medium || null,
        latest_source: p.latest_source || null,
        raw_properties: p,
      };
    });

    if (rows.length > 0) {
      const { error } = await supabase
        .from("audit_hs_companies_snapshot")
        .insert(rows);
      if (error) {
        console.error("[parity] company insert error:", error.message);
        errors += rows.length;
      } else {
        total += rows.length;
      }
    }

    const nextAfter = res.paging?.next?.after;
    after = nextAfter ? String(nextAfter) : undefined;
  } while (after);

  return { total, errors };
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export async function snapshotHubSpot(snapshotId: Date): Promise<SnapshotStats> {
  const ownerMap = await loadOwners();

  const contactsResult = await snapshotContacts(snapshotId, ownerMap);
  const companiesResult = await snapshotCompanies(snapshotId, ownerMap);

  return {
    contacts_total: contactsResult.total,
    companies_total: companiesResult.total,
    contacts_insert_errors: contactsResult.errors,
    companies_insert_errors: companiesResult.errors,
  };
}

/**
 * Run all 6 detection stored procedures via supabase.rpc().
 * Functions are defined in migration 012.
 */
export async function runDetectionQueries(
  snapshotId: Date,
): Promise<DetectionStats> {
  const snapIso = snapshotId.toISOString();

  const [
    dedupContacts,
    dedupCompanies,
    archiveContacts,
    archiveCompanies,
    enrichContacts,
    enrichCompanies,
    qualityContacts,
    qualityCompanies,
  ] = await Promise.all([
    supabase.rpc("audit_run_contact_dedup", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_company_dedup", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_archive_contacts", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_archive_companies", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_enrich_contacts", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_enrich_companies", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_quality_contacts", { p_snapshot_id: snapIso }),
    supabase.rpc("audit_run_quality_companies", { p_snapshot_id: snapIso }),
  ]);

  const errors = [
    dedupContacts.error,
    dedupCompanies.error,
    archiveContacts.error,
    archiveCompanies.error,
    enrichContacts.error,
    enrichCompanies.error,
    qualityContacts.error,
    qualityCompanies.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    for (const e of errors) console.error("[parity] detection error:", e);
    throw new Error(
      `Detection failed with ${errors.length} errors: ${errors.map((e: any) => e.message).join("; ")}`,
    );
  }

  return {
    dedup_contact_rows: dedupContacts.data ?? 0,
    dedup_company_rows: dedupCompanies.data ?? 0,
    archive_contact_rows: archiveContacts.data ?? 0,
    archive_company_rows: archiveCompanies.data ?? 0,
    enrich_contact_rows: enrichContacts.data ?? 0,
    enrich_company_rows: enrichCompanies.data ?? 0,
    quality_contact_rows: qualityContacts.data ?? 0,
    quality_company_rows: qualityCompanies.data ?? 0,
  };
}

export async function pruneOldSnapshots(keep: number): Promise<number> {
  const { data, error } = await supabase.rpc("audit_prune_snapshots", {
    p_keep: keep,
  });
  if (error) {
    console.error("[parity] prune error:", error);
    throw error;
  }
  return data ?? 0;
}

export async function computeDrift(snapshotId: Date): Promise<DriftStats> {
  const { data, error } = await supabase.rpc("audit_compute_drift", {
    p_snapshot_id: snapshotId.toISOString(),
  });
  if (error) {
    console.error("[parity] drift error:", error);
    throw error;
  }
  // RPC returns array of rows; take first
  const row = Array.isArray(data) ? data[0] : data;
  return {
    contacts_added: row?.contacts_added ?? 0,
    contacts_removed: row?.contacts_removed ?? 0,
    contacts_modified: row?.contacts_modified ?? 0,
    companies_added: row?.companies_added ?? 0,
    companies_removed: row?.companies_removed ?? 0,
    companies_modified: row?.companies_modified ?? 0,
  };
}

/**
 * Write a single summary row to audit_parity_runs.
 * Replaces the Slack digest — all stats are persisted here for future queries.
 */
export async function writeRunSummary(
  snapshotId: Date,
  snapshotStats: SnapshotStats,
  detectionStats: DetectionStats,
  drift: DriftStats,
  durationSeconds: number,
): Promise<void> {
  // Query live counts for work queue
  const [{ count: archivePending }, { count: enrichPending }, { count: dedupTotal }] =
    await Promise.all([
      supabase
        .from("audit_archive_candidates")
        .select("*", { count: "exact", head: true })
        .eq("decision", "pending"),
      supabase
        .from("audit_enrichment_gaps")
        .select("*", { count: "exact", head: true })
        .eq("resolved", false),
      supabase
        .from("audit_dedup_groups")
        .select("*", { count: "exact", head: true }),
    ]);

  const { error } = await supabase.from("audit_parity_runs").insert({
    snapshot_id: snapshotId.toISOString(),
    finished_at: new Date().toISOString(),
    contacts_total: snapshotStats.contacts_total,
    companies_total: snapshotStats.companies_total,
    contacts_added: drift.contacts_added,
    contacts_removed: drift.contacts_removed,
    contacts_modified: drift.contacts_modified,
    companies_added: drift.companies_added,
    companies_removed: drift.companies_removed,
    companies_modified: drift.companies_modified,
    dedup_groups_total: dedupTotal ?? 0,
    archive_candidates_pending: archivePending ?? 0,
    enrichment_gaps_pending: enrichPending ?? 0,
    run_duration_seconds: durationSeconds,
    notes: null,
  });

  if (error) {
    console.error("[parity] run summary insert error:", error);
    throw error;
  }
}
