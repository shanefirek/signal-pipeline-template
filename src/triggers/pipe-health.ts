import { schedules } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";

// Pipe Health — runs every 6 hours
//
// Checks for stuck signals, failed pushes, zero volume.
// Sends Slack alert if anything is wrong.
//
// No current equivalent. Replaces manual monitoring.

export const pipeHealth = schedules.task({
  id: "pipe-health",
  cron: "0 */6 * * *", // Every 6 hours
  maxDuration: 60,
  run: async () => {
    const alerts: string[] = [];

    // Check 1: Raw signals stuck in enriching/scoring > 1 hour
    // (scoring signals now wait for enrichment to call tryMarkSignalDone)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: stuckSignals } = await supabase
      .from("raw_signals")
      .select("id", { count: "exact", head: true })
      .in("status", ["enriching", "scoring"])
      .lt("created_at", oneHourAgo);

    if (stuckSignals && stuckSignals > 0) {
      alerts.push(`${stuckSignals} signals stuck in "enriching"/"scoring" > 1 hour — marking as error`);

      // Auto-fix: mark stuck signals as error so they don't pile up
      const { data: stuckRows } = await supabase
        .from("raw_signals")
        .select("id, domain, status")
        .in("status", ["enriching", "scoring"])
        .lt("created_at", oneHourAgo)
        .limit(50);

      for (const row of (stuckRows || [])) {
        await supabase.from("raw_signals").update({
          status: "error",
          error: `Stuck in "${row.status}" for >1h — auto-cleared by pipe-health`,
          processed_at: new Date().toISOString(),
        }).eq("id", row.id);
        console.log(`[pipe-health] Cleared stuck signal ${row.id} (${row.domain}) from ${row.status} → error`);
      }
    }

    // Check 2: HubSpot push failures in last 6h
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { count: pushFailures } = await supabase
      .from("push_log")
      .select("id", { count: "exact", head: true })
      .eq("success", false)
      .gte("created_at", sixHoursAgo);

    if (pushFailures && pushFailures > 5) {
      alerts.push(`${pushFailures} HubSpot push failures in last 6h`);
    }

    // Check 4: Volume sanity — zero signals in 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: recentSignals } = await supabase
      .from("raw_signals")
      .select("id", { count: "exact", head: true })
      .gte("created_at", oneDayAgo);

    if (recentSignals === 0) {
      alerts.push("Zero signals in 24h — Syft webhook may be down");
    } else if (recentSignals && recentSignals > 500) {
      alerts.push(`Unusual volume: ${recentSignals} signals in 24h`);
    }

    // Check 5: Stale contacts piling up
    const { count: staleContacts } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("needs_refresh", true);

    if (staleContacts && staleContacts > 50) {
      alerts.push(`${staleContacts} contacts need refresh — stale-refresh may be failing`);
    }

    // Check 6: Hot contacts departed but not replaced
    const { count: unreplacedDepartures } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .not("job_change_detected_at", "is", null)
      .in("tier", ["hot", "warm"]);

    if (unreplacedDepartures && unreplacedDepartures > 5) {
      alerts.push(`${unreplacedDepartures} hot/warm contacts have departed — check replacements`);
    }

    // Check 8: Signals marked "done" but missing entities (silent failures)
    // After lifecycle fix, new signals should never hit this — only legacy orphans
    const { count: orphanDone } = await supabase
      .from("raw_signals")
      .select("id", { count: "exact", head: true })
      .eq("status", "done")
      .is("company_id", null)
      .is("contact_id", null)
      .eq("validation", "pass")
      .eq("validation_gate", true);

    if (orphanDone && orphanDone > 0) {
      alerts.push(`${orphanDone} signals marked "done" with no company or contact — integrity violation`);
    }

    // Send Slack alert if any issues
    if (alerts.length > 0) {
      const webhookUrl = null; // pipe-health alerts stay in logs only — not useful in Slack
      if (webhookUrl) {
        const message = {
          text: `Pipe Health Alert`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Pipe Health Alert" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: alerts.map((a) => `• ${a}`).join("\n"),
              },
            },
          ],
        };

        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
          });
        } catch (err) {
          console.error("[pipe-health] Slack alert failed:", err);
        }
      }

      console.log(`[pipe-health] ${alerts.length} issues found:\n${alerts.join("\n")}`);
    } else {
      console.log("[pipe-health] All clear");
    }

    return {
      healthy: alerts.length === 0,
      alerts,
      stats: {
        stuck_signals: stuckSignals || 0,
        push_failures: pushFailures || 0,
        recent_signals_24h: recentSignals || 0,
        stale_contacts: staleContacts || 0,
        unreplaced_departures: unreplacedDepartures || 0,
        orphan_done_signals: orphanDone || 0,
      },
    };
  },
});
