// Email Waterfall — Cargo-first with LeadMagic fallback.
//
// History:
//   - Original Clay waterfall had 5 steps (Findymail, LeadMagic).
//   - Apr 2026: Switched to LeadMagic-only after Findymail/Apify issues.
//   - Apr 14 2026: Cargo-first rewrite. Cargo data quality is better.
//
// Current logic:
//   1. If existing email → Cargo verify (0.2 credits). If valid, done.
//   2. If no email + have name+domain → Cargo find email (1.1-4 credits).
//   3. If Cargo misses → LeadMagic find email (fallback).
//   4. Final validation via Cargo verify.
//
// Cargo-first because data quality is better. LeadMagic as fallback only.

import * as cargo from "./providers/cargo.js";
import * as leadmagic from "./providers/leadmagic.js";
import type { EmailWaterfallResult } from "./types.js";
import { logEnrichmentCall, normalizeKey, startTimer } from "./enrichment-logger.js";

export async function runEmailWaterfall(params: {
  existing_email?: string | null;
  contact_name?: string | null;
  domain?: string | null;
}): Promise<EmailWaterfallResult> {
  const { existing_email, contact_name, domain } = params;

  const logKey = existing_email
    ? normalizeKey("email", existing_email)
    : contact_name && domain
      ? normalizeKey("name_domain", `${contact_name.split(" ")[0]}|${contact_name.split(" ").slice(1).join(" ")}|${domain}`)
      : "unknown";

  // Step 1: If we have an existing email, validate it with Cargo
  if (existing_email && existing_email.trim() !== "") {
    const t1 = startTimer();
    const cargoVerify = await cargo.verifyEmail(existing_email);
    const d1 = t1();
    logEnrichmentCall({
      provider: "cargo", operation: "verify_email",
      lookup_key: normalizeKey("email", existing_email),
      input_payload: { email: existing_email },
      output_payload: cargoVerify as any,
      credits_estimated: 0.2, trigger_source: "email-waterfall",
      success: !!(cargoVerify.deliverable || cargoVerify.valid), duration_ms: d1,
      result_summary: { deliverable: cargoVerify.deliverable, valid: cargoVerify.valid },
    }).catch(() => {});

    if (cargoVerify.deliverable || cargoVerify.valid) {
      console.log(`[email-waterfall] Cargo verified existing email: ${existing_email}`);
      return { email: existing_email, verified: true, source: "cargo_validate" };
    }

    // Cargo said no — try LeadMagic as fallback validation
    const t2 = startTimer();
    const lmValidate = await leadmagic.validateEmail(existing_email);
    const d2 = t2();
    logEnrichmentCall({
      provider: "leadmagic", operation: "validate_email",
      lookup_key: normalizeKey("email", existing_email),
      input_payload: { email: existing_email },
      output_payload: lmValidate as any,
      credits_estimated: 1, trigger_source: "email-waterfall",
      success: !!lmValidate?.deliverable, duration_ms: d2,
      result_summary: { deliverable: lmValidate?.deliverable },
    }).catch(() => {});

    if (lmValidate?.deliverable) {
      console.log(`[email-waterfall] LeadMagic verified existing email: ${existing_email}`);
      return { email: existing_email, verified: true, source: "leadmagic_validate" };
    }

    console.log(`[email-waterfall] Existing email ${existing_email} failed both Cargo and LeadMagic validation`);
  }

  // Step 2: No verified email — try Cargo email finder
  if (contact_name && domain) {
    const firstName = contact_name.split(" ")[0];
    const lastName = contact_name.split(" ").slice(1).join(" ");

    if (firstName && lastName) {
      const t3 = startTimer();
      const cargoFind = await cargo.findEmail(firstName, lastName, domain);
      const d3 = t3();
      logEnrichmentCall({
        provider: "cargo", operation: "find_email",
        lookup_key: normalizeKey("name_domain", `${firstName}|${lastName}|${domain}`),
        input_payload: { firstName, lastName, companyDomain: domain },
        output_payload: cargoFind as any,
        credits_estimated: 1.1, trigger_source: "email-waterfall",
        success: !!cargoFind.email, duration_ms: d3,
        result_summary: { email: cargoFind.email, verified: cargoFind.verified },
      }).catch(() => {});

      if (cargoFind.email) {
        if (cargoFind.verified) {
          console.log(`[email-waterfall] Cargo found verified email: ${cargoFind.email}`);
          return { email: cargoFind.email, verified: true, source: "cargo_find" };
        }

        // Cargo found but not verified — verify it
        const t4 = startTimer();
        const cargoVerify = await cargo.verifyEmail(cargoFind.email);
        const d4 = t4();
        logEnrichmentCall({
          provider: "cargo", operation: "verify_email",
          lookup_key: normalizeKey("email", cargoFind.email),
          input_payload: { email: cargoFind.email },
          output_payload: cargoVerify as any,
          credits_estimated: 0.2, trigger_source: "email-waterfall",
          success: !!(cargoVerify.deliverable || cargoVerify.valid), duration_ms: d4,
          result_summary: { deliverable: cargoVerify.deliverable, valid: cargoVerify.valid },
        }).catch(() => {});

        if (cargoVerify.deliverable || cargoVerify.valid) {
          console.log(`[email-waterfall] Cargo found + verified: ${cargoFind.email}`);
          return { email: cargoFind.email, verified: true, source: "cargo_find" };
        }

        console.log(`[email-waterfall] Cargo found ${cargoFind.email} but verification failed`);
      }
    }

    // Step 3: Cargo missed — fallback to LeadMagic
    const t5 = startTimer();
    const lmFind = await leadmagic.findWorkEmail({
      name: contact_name,
      domain,
    });
    const d5 = t5();
    logEnrichmentCall({
      provider: "leadmagic", operation: "find_work_email",
      lookup_key: logKey,
      input_payload: { name: contact_name, domain },
      output_payload: lmFind as any,
      credits_estimated: 1, trigger_source: "email-waterfall",
      success: !!lmFind?.email, duration_ms: d5,
      result_summary: { email: lmFind?.email, status: lmFind?.status },
    }).catch(() => {});

    if (lmFind?.email) {
      if (lmFind.status === "valid") {
        console.log(`[email-waterfall] LeadMagic fallback found: ${lmFind.email}`);
        return { email: lmFind.email, verified: true, source: "leadmagic_find" };
      }

      // Non-valid status — verify with Cargo
      const t6 = startTimer();
      const cargoVerify = await cargo.verifyEmail(lmFind.email);
      const d6 = t6();
      logEnrichmentCall({
        provider: "cargo", operation: "verify_email",
        lookup_key: normalizeKey("email", lmFind.email),
        input_payload: { email: lmFind.email },
        output_payload: cargoVerify as any,
        credits_estimated: 0.2, trigger_source: "email-waterfall",
        success: !!(cargoVerify.deliverable || cargoVerify.valid), duration_ms: d6,
        result_summary: { deliverable: cargoVerify.deliverable, valid: cargoVerify.valid },
      }).catch(() => {});

      if (cargoVerify.deliverable || cargoVerify.valid) {
        console.log(`[email-waterfall] LeadMagic found, Cargo verified: ${lmFind.email}`);
        return { email: lmFind.email, verified: true, source: "leadmagic_find" };
      }

      // Try LeadMagic validation as last resort
      const t7 = startTimer();
      const lmValidate = await leadmagic.validateEmail(lmFind.email);
      const d7 = t7();
      logEnrichmentCall({
        provider: "leadmagic", operation: "validate_email",
        lookup_key: normalizeKey("email", lmFind.email),
        input_payload: { email: lmFind.email },
        output_payload: lmValidate as any,
        credits_estimated: 1, trigger_source: "email-waterfall",
        success: !!lmValidate?.deliverable, duration_ms: d7,
        result_summary: { deliverable: lmValidate?.deliverable },
      }).catch(() => {});

      if (lmValidate?.deliverable) {
        console.log(`[email-waterfall] LeadMagic found + validated: ${lmFind.email}`);
        return { email: lmFind.email, verified: true, source: "leadmagic_find" };
      }

      console.log(
        `[email-waterfall] LeadMagic found ${lmFind.email} with status=${lmFind.status} ` +
          `but all validation failed — skipping`
      );
    }
  }

  // Nothing verified — return null
  console.log(`[email-waterfall] No verified email found for ${contact_name} @ ${domain}`);
  return { email: null, verified: false, source: "none" };
}
