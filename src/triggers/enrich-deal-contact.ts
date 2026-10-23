import { task } from "@trigger.dev/sdk/v3";
import { supabase } from "../lib/supabase.js";
import { hubspot, isHubSpotPushEnabled, updateHubSpotContact, pushCompanyToHubSpot } from "../lib/hubspot.js";
import { findMobilePhone, profileSearch, findLinkedInByEmail } from "../enrichment/providers/leadmagic.js";
import { domainsMatch } from "../enrichment/providers/cargo.js";
import { getCompanyData } from "../enrichment/company-data-waterfall.js";
import {
  employeeFinder,
  jobsFinder,
  technographics,
  classifySalesTeamLLM,
} from "../enrichment/providers/leadmagic-company.js";
import { computeTamICP, scoreSalesTeamReal } from "../scoring/tam-icp.js";
import { companyLeadTemp } from "../scoring/icp.js";
import { deriveFundingStage } from "../lib/funding.js";
import { generateLeadSummary, formatSalesAnalysisForPrompt } from "../lib/summaries.js";
import { deriveLeadOrigin } from "../lib/constants.js";
import { logEnrichmentCall, normalizeKey, startTimer } from "../enrichment/enrichment-logger.js";

// Enrich Deal Contact — ISOLATED task for HubSpot deals
//
// Why this exists:
// The normal Syft pipeline (normalize → enrich-company → discover-contact →
// enrich-contact) has accumulated gates that block deal-created workflows:
//   - gates.ts has `if lead_source === "hubspot_deal_created" return true`
//     bypasses in 3+ places (engagement check, customer check, etc.) — every
//     bypass is tech debt
//   - normalize.ts checks `!contactExistsHubspot` before enriching, which
//     blocks deal contacts by definition (they exist in HubSpot already)
//   - enrich-contact.ts early-exits if contact exists in HubSpot, skipping
//     Cargo/phone/summary entirely
//   - enrich-company.ts "hasExistingDeal" gate skips contact discovery — but
//     for deal contacts we WANT full enrichment on the one existing contact
//
// Rather than add more bypass flags to the shared pipeline (compounding the
// gate-bypass coupling problem), this task runs its own focused enrichment
// flow with zero validation gates. Every deal gets full treatment.
//
// Tech debt: ~80 lines of company enrichment are duplicated from
// enrich-company.ts. Acknowledged cost of isolation. Refactoring to share a
// library function would require touching the Syft path, which is the
// dependency risk we are specifically avoiding here.
//
// Input: HubSpot IDs (authoritative) — we re-fetch contact/company fresh
// every run to stay in sync with whatever the AE did in HubSpot.

interface EnrichDealContactPayload {
  deal_id: string;
  deal_name?: string | null;
  company_hs_id: string | null;
  contact_hs_id: string | null;
  domain: string;
}

interface EnrichDealContactResult {
  deal_id: string;
  domain: string;
  company_updated: boolean;
  contact_updated: boolean;
  linkedin_found: boolean;
  phone_found: boolean;
  summary_generated: boolean;
  errors: string[];
}

// Parse funding values from LeadMagic (strings like "350K", "1.5M", "$2M")
function parseFunding(val: unknown): number | null {
  if (typeof val === "number") return val;
  if (!val) return null;
  const str = String(val).replace(/[$,]/g, "").trim().toUpperCase();
  const match = str.match(/^([\d.]+)([KMB])?$/);
  if (!match) return parseFloat(str) || null;
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "K") return num * 1000;
  if (suffix === "M") return num * 1000000;
  if (suffix === "B") return num * 1000000000;
  return num;
}

export const enrichDealContact = task({
  id: "enrich-deal-contact",
  maxDuration: 600, // Company enrichment + LLM summary can take time
  run: async (payload: EnrichDealContactPayload): Promise<EnrichDealContactResult> => {
    const { deal_id, company_hs_id, contact_hs_id, domain } = payload;
    const errors: string[] = [];
    const result: EnrichDealContactResult = {
      deal_id,
      domain,
      company_updated: false,
      contact_updated: false,
      linkedin_found: false,
      phone_found: false,
      summary_generated: false,
      errors,
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Company enrichment (inline — acknowledged duplication)
    // ═══════════════════════════════════════════════════════════════
    // Check Supabase for existing company. If fresh (<7d), reuse. Otherwise
    // run the full enrichment chain and push to HubSpot.
    const { data: existingCompany } = await supabase
      .from("companies")
      .select("id, enriched_at, icp_score, sub_market, lead_summary, sales_org_summary, lead_temp, funding_stage, funding_total, employee_count, industry, description, name")
      .eq("domain", domain)
      .limit(1)
      .maybeSingle();

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const isStale = !existingCompany?.enriched_at
      || (Date.now() - new Date(existingCompany.enriched_at).getTime()) > SEVEN_DAYS_MS;

    let companyId: string | null = existingCompany?.id || null;
    let companyName: string | null = existingCompany?.name || null;
    let subMarket: string | null = existingCompany?.sub_market || null;
    let leadSummary: string | null = existingCompany?.lead_summary || null;
    let salesOrgSummary: string | null = existingCompany?.sales_org_summary || null;
    let icpScore: number = existingCompany?.icp_score || 0;
    let leadTemp: string | null = existingCompany?.lead_temp || null;
    let fundingStage: string | null = existingCompany?.funding_stage || null;
    let fundingTotal: number | null = existingCompany?.funding_total || null;
    let employeeCount: number | null = existingCompany?.employee_count || null;
    let industry: string | null = existingCompany?.industry || null;
    let description: string | null = existingCompany?.description || null;
    let salesAnalysisForSummary: any = null;
    let leadmagicCompanyData: any = null;

    if (isStale) {
      try {
        console.log(`[enrich-deal-contact] ${domain}: running full company enrichment`);

        const companyData = await getCompanyData(domain);

        if (companyData.data_source !== "none") {
          const employees = await employeeFinder(domain);
          const jobs = await jobsFinder(domain);
          const salesAnalysis = await classifySalesTeamLLM(
            employees?.employees || [],
            jobs?.jobs || [],
            companyData.name || domain,
            companyData.employee_count,
          );
          const salesScore = scoreSalesTeamReal(salesAnalysis);
          const sales_org_summary = salesAnalysis.llm_summary || "No identifiable sales team on LinkedIn.";

          let techData: Awaited<ReturnType<typeof technographics>> = null;
          if (salesScore.score >= 25) {
            techData = await technographics(domain);
          }

          const ft = parseFunding(companyData.leadmagic?.total_funding);
          const fs = ft ? deriveFundingStage(ft) : null;

          const tamIcp = computeTamICP({
            sub_market: companyData.sub_market,
            employee_count: companyData.employee_count,
            annual_revenue: companyData.leadmagic?.revenue_formatted ?? null,
            funding_stage: fs,
            sales_team: salesAnalysis,
            technologies: techData?.technologies || [],
          });

          const icp = Math.round(tamIcp.raw_total * (125 / 175));
          const lt = companyLeadTemp(icp);
          const empCount = companyData.employee_count || null;

          const summary = await generateLeadSummary({
            contact_name: null,
            title: null,
            email: null,
            company_name: companyData.name,
            domain,
            description: companyData.description,
            employee_count: empCount,
            industry: companyData.industry,
            sub_market: companyData.sub_market,
            sales_team_data: formatSalesAnalysisForPrompt(salesAnalysis),
            funding_stage: fs,
            funding_total: ft,
            lead_source: "hubspot_deal_created",
            icp_score: icp,
            intent_score: 0,
            total_score: icp,
            tier: lt.toLowerCase(),
            vertical_fit_score: tamIcp.vertical_fit,
            outbound_need_score: salesScore.score,
          });

          // Upsert company row
          const enrichmentSources: string[] = [companyData.data_source];
          if (employees) enrichmentSources.push("leadmagic_employees");
          if (jobs) enrichmentSources.push("leadmagic_jobs");
          if (techData) enrichmentSources.push("leadmagic_technographics");

          const { data: upserted, error: upsertErr } = await supabase
            .from("companies")
            .upsert(
              {
                domain,
                name: companyData.name,
                industry: companyData.industry,
                employee_count: empCount,
                description: companyData.description,
                sub_market: companyData.sub_market,
                classifier_source: companyData.classification.source,
                classifier_confidence: companyData.classification.confidence,
                classifier_reason: companyData.classification.reason,
                classifier_version: companyData.classification.version,
                last_classified_at: new Date().toISOString(),
                data_source: companyData.data_source,
                funding_stage: fs,
                funding_total: ft,
                vertical_fit_score: tamIcp.vertical_fit,
                headcount_score: tamIcp.headcount,
                company_stage_score: tamIcp.company_stage,
                sales_team_score: tamIcp.outbound_need,
                outbound_need_score: salesScore.score,
                tech_stack_score: tamIcp.tech_stack,
                tam_icp_raw: tamIcp.raw_total,
                icp_score: icp,
                lead_temp: lt,
                sales_org_summary,
                sales_team_data: JSON.parse(JSON.stringify(salesAnalysis)),
                sales_hiring_data: jobs?.jobs ? JSON.parse(JSON.stringify(jobs.jobs)) : null,
                tech_stack_data: techData?.technologies || null,
                leadmagic_data: companyData.leadmagic,
                lead_summary: summary,
                lead_source: "hubspot_deal_created",
                lead_origin: deriveLeadOrigin("hubspot_deal_created"),
                hubspot_deal_id: deal_id,
                deal_created_at: new Date().toISOString(),
                enriched_at: new Date().toISOString(),
                enrichment_sources: enrichmentSources,
              },
              { onConflict: "domain" },
            )
            .select("id")
            .single();

          if (upsertErr) {
            errors.push(`company_upsert: ${upsertErr.message}`);
          } else if (upserted) {
            companyId = upserted.id;
          }

          // Populate captured vars for contact summary
          companyName = companyData.name;
          subMarket = companyData.sub_market;
          leadSummary = summary;
          salesOrgSummary = sales_org_summary;
          icpScore = icp;
          leadTemp = lt;
          fundingStage = fs;
          fundingTotal = ft;
          employeeCount = empCount;
          industry = companyData.industry;
          description = companyData.description;
          salesAnalysisForSummary = salesAnalysis;
          leadmagicCompanyData = companyData.leadmagic;

          // Push company to HubSpot (always, no gates — this IS a deal)
          if (company_hs_id && isHubSpotPushEnabled()) {
            try {
              await pushCompanyToHubSpot({
                domain,
                name: companyData.name || undefined,
                employee_count: empCount ?? undefined,
                sub_market: companyData.sub_market || undefined,
                icp_score: icp,
                lead_temp: "Hot", // Deal = highest intent, override
                lead_origin: deriveLeadOrigin("hubspot_deal_created"),
                total_score: icp,
                lead_summary: summary || undefined,
                sales_org_summary: sales_org_summary || undefined,
                description: companyData.description || undefined,
                city: (companyData.leadmagic?.headquarters as any)?.city,
                state: (companyData.leadmagic?.headquarters as any)?.region,
                country: (companyData.leadmagic?.headquarters as any)?.countryCode,
                funding_stage: fs || undefined,
                annualrevenue: companyData.leadmagic?.revenue || undefined,
                total_money_raised: companyData.leadmagic?.total_funding_formatted || undefined,
              });

              // Always force lead_tier = Hot on deal companies
              await hubspot.crm.companies.basicApi.update(company_hs_id, {
                properties: { lead_tier: "Hot" },
              });

              result.company_updated = true;
              await supabase.from("push_log").insert({
                entity_type: "company",
                entity_id: companyId,
                destination: "hubspot",
                action: "deal_enrich",
                success: true,
              });
            } catch (err) {
              const msg = `company_push: ${String(err)}`;
              errors.push(msg);
              console.error(`[enrich-deal-contact] ${msg}`);
              await supabase.from("push_log").insert({
                entity_type: "company",
                entity_id: companyId,
                destination: "hubspot",
                action: "deal_enrich",
                success: false,
                error: String(err),
              });
            }
          }
        } else {
          errors.push(`company_enrichment: no data from any tier for ${domain}`);
        }
      } catch (err) {
        errors.push(`company_enrichment: ${String(err)}`);
        console.error(`[enrich-deal-contact] Company enrichment failed:`, err);
      }
    } else {
      console.log(`[enrich-deal-contact] ${domain}: using cached company data (enriched ${existingCompany?.enriched_at})`);

      // Still push lead_tier=Hot since this is a deal
      if (company_hs_id && isHubSpotPushEnabled()) {
        try {
          await hubspot.crm.companies.basicApi.update(company_hs_id, {
            properties: { lead_tier: "Hot" },
          });
          result.company_updated = true;
        } catch (err) {
          errors.push(`company_tier_update: ${String(err)}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Fetch contact from HubSpot
    // ═══════════════════════════════════════════════════════════════
    if (!contact_hs_id) {
      errors.push("no_contact_hs_id");
      return result;
    }

    let contactProps: any = null;
    try {
      const contactRes = await hubspot.crm.contacts.basicApi.getById(
        contact_hs_id,
        [
          "email", "firstname", "lastname", "jobtitle", "phone", "mobilephone",
          "hs_linkedin_url", "lead_tier", "lead_origin", "icp_score", "sub_market",
          "lead_summary", "company",
        ],
      );
      contactProps = contactRes.properties;
    } catch (err) {
      errors.push(`contact_fetch: ${String(err)}`);
      return result;
    }

    const firstName = contactProps.firstname || "";
    const lastName = contactProps.lastname || "";
    const contactName = `${firstName} ${lastName}`.trim();
    const email = contactProps.email || null;
    const existingTitle = contactProps.jobtitle || null;
    const existingPhone = contactProps.phone || contactProps.mobilephone || null;
    let linkedinUrl: string | null = contactProps.hs_linkedin_url || null;
    let currentTitle: string | null = existingTitle;

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: LeadMagic employment verification (finds LinkedIn + verifies title)
    // ═══════════════════════════════════════════════════════════════
    // Every deal contact MUST have LinkedIn. Use profile-search to verify
    // current employment and catch departures. If no LinkedIn URL, try
    // b2b-profile (email→LinkedIn, 10 credits) first.
    if (firstName && lastName && domain) {
      try {
        // Step 3a: Get LinkedIn URL if missing
        if (!linkedinUrl && email) {
          const elapsed = startTimer();
          const b2bResult = await findLinkedInByEmail(email);
          const durationMs = elapsed();
          if (b2bResult?.profile_url) {
            linkedinUrl = b2bResult.profile_url;
            result.linkedin_found = true;
            console.log(`[enrich-deal-contact] LeadMagic b2b-profile found LinkedIn for ${contactName}: ${linkedinUrl}`);
          }
          logEnrichmentCall({
            provider: "leadmagic",
            operation: "b2b_profile",
            lookup_key: normalizeKey("email", email),
            input_payload: { work_email: email },
            output_payload: b2bResult as any,
            credits_estimated: b2bResult ? 10 : 0,
            trigger_source: "enrich-deal-contact",
            success: !!b2bResult?.profile_url,
            duration_ms: durationMs,
            result_summary: b2bResult ? { profile_url: b2bResult.profile_url } : undefined,
          }).catch(() => {});
        }

        // Step 3b: Verify employment via profile-search (needs LinkedIn URL)
        if (linkedinUrl) {
          const elapsed = startTimer();
          const profile = await profileSearch(linkedinUrl);
          const durationMs = elapsed();

          logEnrichmentCall({
            provider: "leadmagic",
            operation: "profile_search",
            lookup_key: normalizeKey("linkedin", linkedinUrl),
            input_payload: { profile_url: linkedinUrl },
            output_payload: profile as any,
            credits_estimated: 1,
            trigger_source: "enrich-deal-contact",
            success: !!profile,
            duration_ms: durationMs,
            result_summary: profile ? { company: profile.current_company, title: profile.current_title } : undefined,
          }).catch(() => {});

          if (profile) {
            // Check ALL active positions — not just current_position.
            // Handles consultants, fractional execs, PE partners with concurrent roles.
            const workExperience: any[] = profile.raw?.work_experience || [];
            const activePositions = workExperience.filter((w: any) =>
              w.employment_period?.includes("Present")
            );

            // Check current_position first, then all active positions
            const currentDomain = profile.company_website?.replace(/^https?:\/\//, "").replace(/\/.*/, "") || null;
            let match = domainsMatch(domain, currentDomain) || domainsMatch(domain, profile.current_company);
            let matchedTitle = match ? profile.current_title : null;

            if (!match) {
              for (const pos of activePositions) {
                const posDomain = pos.company_website?.replace(/^https?:\/\//, "").replace(/\/.*/, "") || null;
                if (domainsMatch(domain, posDomain) || domainsMatch(domain, pos.company_name)) {
                  match = true;
                  matchedTitle = pos.position_title || null;
                  break;
                }
              }
            }

            if (match) {
              if (matchedTitle && !currentTitle) {
                currentTitle = matchedTitle;
              }
              console.log(`[enrich-deal-contact] ${contactName} verified at ${domain} (title: ${currentTitle})`);
            } else if (profile.current_company) {
              errors.push(`departed: ${contactName} is now at ${profile.current_company}`);
              console.log(`[enrich-deal-contact] ${contactName} departed ${domain} → ${profile.current_company}`);
            }
          }
        }
      } catch (err) {
        errors.push(`profile_verify: ${String(err)}`);
        console.warn(`[enrich-deal-contact] Profile verification failed, continuing:`, err);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Phone lookup via LeadMagic (needs LinkedIn or email)
    // ═══════════════════════════════════════════════════════════════
    let phone: string | null = null;
    if (!existingPhone) {
      const identifier = linkedinUrl || email;
      if (identifier) {
        try {
          const phoneElapsed = startTimer();
          const phoneResult = await findMobilePhone(identifier);
          const phoneDurationMs = phoneElapsed();
          phone = phoneResult?.mobile_number || null;
          if (phone) {
            result.phone_found = true;
            console.log(`[enrich-deal-contact] Phone found for ${contactName}: ${phone}`);
          }

          // Log LeadMagic phone lookup (non-blocking)
          logEnrichmentCall({
            provider: "leadmagic",
            operation: "find_mobile_phone",
            lookup_key: linkedinUrl ? normalizeKey("linkedin", linkedinUrl) : normalizeKey("email", email!),
            input_payload: { identifier },
            output_payload: phoneResult as any,
            credits_estimated: 1,
            trigger_source: "enrich-deal-contact",
            success: !!phone,
            duration_ms: phoneDurationMs,
            result_summary: phone ? { phone } : undefined,
          }).catch(() => {});
        } catch (err) {
          errors.push(`phone: ${String(err)}`);
        }
      }
    } else {
      phone = existingPhone;
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Generate contact-specific lead_summary
    // ═══════════════════════════════════════════════════════════════
    // Only regenerate if we have fresh company data to include person context.
    // If using cached company, keep the cached summary (still company-level).
    let contactSummary: string | null = leadSummary;
    if (contactName && (firstName || lastName)) {
      try {
        const summary = await generateLeadSummary({
          contact_name: contactName,
          title: currentTitle,
          email,
          company_name: companyName,
          domain,
          description,
          employee_count: employeeCount,
          industry,
          sub_market: subMarket,
          sales_team_data: salesAnalysisForSummary
            ? formatSalesAnalysisForPrompt(salesAnalysisForSummary)
            : (salesOrgSummary || ""),
          funding_stage: fundingStage,
          funding_total: fundingTotal,
          lead_source: "hubspot_deal_created",
          icp_score: icpScore,
          intent_score: 0,
          total_score: icpScore,
          tier: "hot",
          vertical_fit_score: 0,
          outbound_need_score: 0,
        });
        if (summary) {
          contactSummary = summary;
          result.summary_generated = true;
        }
      } catch (err) {
        errors.push(`summary: ${String(err)}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Upsert Supabase contact row FIRST
    // ═══════════════════════════════════════════════════════════════
    // Order matters: push_log.entity_id is a UUID column, so we need the
    // Supabase row's UUID (not the HubSpot numeric ID) before we log the
    // HubSpot push. Use email as primary conflict key, fall back to
    // linkedin_url.
    let supabaseContactId: string | null = null;
    if (email || linkedinUrl) {
      try {
        const contactRow: Record<string, unknown> = {
          domain,
          first_name: firstName || null,
          last_name: lastName || null,
          title: currentTitle,
          hubspot_contact_id: contact_hs_id,
          hubspot_pushed_at: new Date().toISOString(),
          tier: "hot",
          lead_origin: deriveLeadOrigin("hubspot_deal_created"),
          icp_score: icpScore || null,
          ...(companyId && { company_id: companyId }),
          ...(email && { email }),
          ...(linkedinUrl && { linkedin_url: linkedinUrl }),
          ...(phone && { phone }),
          ...(contactSummary && { lead_summary: contactSummary }),
        };

        const { data: upserted, error: upsertErr } = await supabase
          .from("contacts")
          .upsert(contactRow, { onConflict: email ? "email" : "linkedin_url" })
          .select("id")
          .single();
        if (upsertErr) {
          errors.push(`contact_upsert: ${upsertErr.message}`);
        } else if (upserted) {
          supabaseContactId = upserted.id;
        }
      } catch (err) {
        errors.push(`contact_upsert: ${String(err)}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 7: Update HubSpot contact (always — no gates)
    // ═══════════════════════════════════════════════════════════════
    if (isHubSpotPushEnabled()) {
      try {
        await updateHubSpotContact({
          hubspot_contact_id: contact_hs_id,
          lead_tier: "Hot",
          lead_temp: "Hot",
          lead_origin: deriveLeadOrigin("hubspot_deal_created"),
          icp_score: icpScore || undefined,
          total_score: icpScore || undefined,
          ...(subMarket && { sub_market: subMarket }),
          ...(contactSummary && { lead_summary: contactSummary }),
          ...(salesOrgSummary && { sales_org_summary: salesOrgSummary }),
          ...(linkedinUrl && { hs_linkedin_url: linkedinUrl }),
          ...(phone && { phone }),
          ...(currentTitle && { jobtitle: currentTitle }),
          ...(companyName && { company: companyName }),
        });
        result.contact_updated = true;

        if (supabaseContactId) {
          const { error: logErr } = await supabase.from("push_log").insert({
            entity_type: "contact",
            entity_id: supabaseContactId,
            destination: "hubspot",
            action: "deal_enrich",
            success: true,
          });
          if (logErr) errors.push(`push_log: ${logErr.message}`);
        }
      } catch (err) {
        errors.push(`contact_push: ${String(err)}`);
        console.error(`[enrich-deal-contact] Contact push failed:`, err);
        if (supabaseContactId) {
          await supabase.from("push_log").insert({
            entity_type: "contact",
            entity_id: supabaseContactId,
            destination: "hubspot",
            action: "deal_enrich",
            success: false,
            error: String(err),
          });
        }
      }
    }

    console.log(`[enrich-deal-contact] Done ${deal_id} ${domain}: company=${result.company_updated} contact=${result.contact_updated} linkedin=${result.linkedin_found} phone=${result.phone_found} errors=${errors.length}`);
    return result;
  },
});
