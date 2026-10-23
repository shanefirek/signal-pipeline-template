// Company Data Waterfall — single entry point for all company enrichment.
//
// Replaces direct `companySearch()` calls scattered across enrich-company.ts,
// tam-enrich.ts, refresh tasks, and future ingestion paths. One door, one
// source of truth, one classifier.
//
// Tier order (cheapest first, most reliable when it hits):
//   1. LeadMagic companySearch       (~1 credit, structured data)
//   2. Apify website-content-crawler (~$0.0015, free-text scrape)
//   3. Lightweight HTTP + meta tags  (free, last-ditch fallback)
//   4. Mark as enrichment_gap        (caller decides what to do)
//
// At every tier we run the sub-market classifier on whatever data we got.
// The classifier itself has its own fallback chain (TLD → industry keyword →
// Claude). Together they guarantee that every domain we successfully fetch
// SOMETHING for gets a defensible sub_market.

import { companySearch, type CompanySearchResult } from "./providers/leadmagic-company.js";
import { scrapeCompanyWebsite, type ScrapedCompanyData } from "./providers/apify-company.js";
import { fetchWebsite, type WebsiteFetchResult } from "./providers/website-fetch.js";
import {
  classifySubMarket,
  type ClassifierOutput,
  type SubMarket,
} from "../lib/sub-market-classifier.js";

export type DataSource = "leadmagic" | "apify" | "website_fetch" | "none";

/**
 * The unified output every caller gets back, regardless of which tier the data
 * came from. Fields are best-effort — LeadMagic gives the richest data, scrapes
 * give name/description but no employee_count or funding.
 */
export interface CompanyData {
  domain: string;
  // Source attribution
  data_source: DataSource;
  // Core fields (some may be null depending on source)
  name: string | null;
  description: string | null;
  industry: string | null;
  employee_count: number | null;
  // LeadMagic-only structured fields (null when scraped)
  leadmagic: CompanySearchResult | null;
  // Scrape data (set when LeadMagic missed)
  scraped: ScrapedCompanyData | WebsiteFetchResult | null;
  // Sub-market classification (always populated)
  classification: ClassifierOutput;
  // Convenience accessor
  sub_market: SubMarket;
}

/**
 * Did LeadMagic actually return usable data, or just an empty stub? An "empty"
 * response (no description, no industry, no employee count) is no better than
 * a miss — we should fall through to scraping instead of giving the classifier
 * nothing to work with.
 */
function isLeadMagicHit(lm: CompanySearchResult | null): lm is CompanySearchResult {
  if (!lm) return false;
  const hasName = !!(lm.companyName && lm.companyName.trim().length > 0);
  const hasDescription = !!(lm.description && lm.description.trim().length > 30);
  const hasIndustry = !!(lm.industry && lm.industry.trim().length > 0);
  const hasEmployees = !!(lm.employeeCount && lm.employeeCount > 0);
  // Need at least name + (description OR industry OR employees) to count as a real hit
  return hasName && (hasDescription || hasIndustry || hasEmployees);
}

/**
 * Run the company data waterfall and classify the result.
 *
 * Always returns a CompanyData record. If every tier fails, returns a record
 * with `data_source: "none"` and `classification.sub_market: "Not SLED"`.
 * Caller decides whether to DQ, retry later, or surface to a human.
 */
export async function getCompanyData(
  domain: string,
): Promise<CompanyData> {
  // Tier 1: LeadMagic
  const lm = await companySearch(domain);
  if (isLeadMagicHit(lm)) {
    const classification = await classifySubMarket({
      domain,
      name: lm.companyName,
      description: lm.description,
      industry: lm.industry,
      employee_count: lm.employeeCount,
    });

    return {
      domain,
      data_source: "leadmagic",
      name: lm.companyName,
      description: lm.description,
      industry: lm.industry,
      employee_count: lm.employeeCount,
      leadmagic: lm,
      scraped: null,
      classification,
      sub_market: classification.sub_market,
    };
  }

  // Tier 2: Apify website-content-crawler
  const apifyResult = await scrapeCompanyWebsite(domain);
  if (apifyResult) {
    const classification = await classifySubMarket({
      domain,
      name: extractNameFromScrape(apifyResult.combined_text, domain),
      description: extractDescriptionFromScrape(apifyResult),
      industry: null,
      employee_count: null,
      scraped_text: apifyResult.combined_text,
    });

    return {
      domain,
      data_source: "apify",
      name: extractNameFromScrape(apifyResult.combined_text, domain),
      description: extractDescriptionFromScrape(apifyResult),
      industry: null,
      employee_count: null,
      leadmagic: null,
      scraped: apifyResult,
      classification,
      sub_market: classification.sub_market,
    };
  }

  // Tier 3: Lightweight HTTP fetch + meta extraction
  const fetchResult = await fetchWebsite(domain);
  if (fetchResult) {
    const classification = await classifySubMarket({
      domain,
      name: fetchResult.og_site_name || fetchResult.title,
      description: fetchResult.og_description || fetchResult.description,
      industry: null,
      employee_count: null,
      scraped_text: fetchResult.combined_text,
    });

    return {
      domain,
      data_source: "website_fetch",
      name: fetchResult.og_site_name || fetchResult.title,
      description: fetchResult.og_description || fetchResult.description,
      industry: null,
      employee_count: null,
      leadmagic: null,
      scraped: fetchResult,
      classification,
      sub_market: classification.sub_market,
    };
  }

  // Tier 4: Nothing worked. Hand caller a "Cannot Determine" record so it can
  // make its own DQ decision instead of swallowing the failure silently.
  console.log(`[waterfall] All tiers failed for ${domain} — marking enrichment gap`);
  const classification = await classifySubMarket({
    domain,
  });

  return {
    domain,
    data_source: "none",
    name: null,
    description: null,
    industry: null,
    employee_count: null,
    leadmagic: null,
    scraped: null,
    classification,
    sub_market: classification.sub_market,
  };
}

// --- Helpers for extracting structured fields from scraped text ---

function extractNameFromScrape(
  combinedText: string,
  domain: string,
): string | null {
  // Try to find a "Title: ..." line first (Apify scraper format)
  const titleMatch = combinedText.match(/Title:\s*([^\n]+)/);
  if (titleMatch) {
    // Strip common suffixes ("| Home", "- About Us", etc.)
    return titleMatch[1].split(/[|\-—–]/)[0].trim().slice(0, 200);
  }
  return null;
}

function extractDescriptionFromScrape(
  scraped: ScrapedCompanyData | WebsiteFetchResult,
): string | null {
  if ("pages" in scraped) {
    // Apify result — first page description preferred
    const firstPage = scraped.pages[0];
    if (firstPage?.description) return firstPage.description.slice(0, 1500);
    // Fall back to first 500 chars of body excerpt
    if (firstPage?.text_excerpt) return firstPage.text_excerpt.slice(0, 1500);
    return null;
  }
  // Website-fetch result
  return scraped.og_description || scraped.description || scraped.body_excerpt?.slice(0, 1500) || null;
}
