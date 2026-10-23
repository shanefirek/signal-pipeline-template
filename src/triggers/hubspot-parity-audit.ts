// Weekly HubSpot ↔ Supabase parity audit.
//
// Shane's internal audit system. Runs Sundays 10am UTC, after company-refresh
// and contact-refresh crons. Snapshots HubSpot, runs detection SQL via Postgres
// stored procedures, prunes old snapshots, computes drift, and persists a
// summary row to audit_parity_runs.
//
// NO Slack. NO DMs. NO external notifications of any kind.
// Review via SQL in Supabase Studio. See scripts/audit-queries.sql.

import { logger, schedules } from "@trigger.dev/sdk/v3";
import {
  snapshotHubSpot,
  runDetectionQueries,
  pruneOldSnapshots,
  computeDrift,
  writeRunSummary,
} from "../lib/audit-parity.js";

export const hubspotParityAudit = schedules.task({
  id: "hubspot-parity-audit",
  cron: { pattern: "0 10 * * 0", timezone: "UTC" },
  maxDuration: 900,
  run: async () => {
    const snapshotId = new Date();
    const startedAt = Date.now();

    logger.info("[parity] starting", { snapshotId: snapshotId.toISOString() });

    // Phase 1: Snapshot HubSpot contacts + companies into audit_hs_*_snapshot
    const snapshotStats = await snapshotHubSpot(snapshotId);
    logger.info("[parity] snapshot complete", snapshotStats);

    // Phase 2: Run detection procedures (dedup / archive / enrich)
    const detectionStats = await runDetectionQueries(snapshotId);
    logger.info("[parity] detection complete", detectionStats);

    // Phase 3: Prune old snapshots (keep last 4)
    const prunedRows = await pruneOldSnapshots(4);
    logger.info("[parity] pruned rows", { prunedRows });

    // Phase 4: Compute drift vs previous snapshot
    const drift = await computeDrift(snapshotId);
    logger.info("[parity] drift computed", drift);

    // Phase 5: Persist run summary. This is the ONLY output beyond Trigger.dev
    // run logs. No Slack, no DMs, no external calls. Shane reviews via
    // Supabase Studio queries in scripts/audit-queries.sql.
    const durationSeconds = Math.floor((Date.now() - startedAt) / 1000);
    await writeRunSummary(
      snapshotId,
      snapshotStats,
      detectionStats,
      drift,
      durationSeconds,
    );
    logger.info("[parity] run summary persisted", { durationSeconds });

    return {
      snapshotId: snapshotId.toISOString(),
      snapshotStats,
      detectionStats,
      prunedRows,
      drift,
      durationSeconds,
    };
  },
});
