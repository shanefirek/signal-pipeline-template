import { supabase } from "./supabase.js";

/**
 * Attempt to mark a raw_signal as "done" only if it's fully processed.
 *
 * A signal is considered done when:
 * - company_id is set AND (contact_id is set OR no contact expected OR contact confirmed in HubSpot)
 *
 * This prevents the race condition where score-intent (which runs in parallel
 * with enrichment) marks signals "done" before company/contact IDs are written.
 */
export async function tryMarkSignalDone(rawSignalId: string | null): Promise<void> {
  if (!rawSignalId) return;

  const { data: signal } = await supabase
    .from("raw_signals")
    .select("company_id, contact_id, email, linkedin_url, status, contact_exists_hubspot")
    .eq("id", rawSignalId)
    .single();

  if (!signal) return;

  // Already done or filtered — no-op
  if (signal.status === "done" || signal.status === "filtered") return;

  const hasCompany = !!signal.company_id;
  const hasContact = !!signal.contact_id;
  const contactExpected = !!(signal.linkedin_url || signal.email?.trim());
  // Contact is accounted for if: linked in Supabase, not expected, or confirmed in HubSpot
  const contactAccountedFor = hasContact || !contactExpected || !!signal.contact_exists_hubspot;

  if (hasCompany && contactAccountedFor) {
    await supabase.from("raw_signals").update({
      status: "done",
      processed_at: new Date().toISOString(),
    }).eq("id", rawSignalId);
  }
}
