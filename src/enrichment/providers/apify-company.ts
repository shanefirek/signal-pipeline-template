// Apify Website Content Crawler — fallback company data source when LeadMagic fails.
//
// Crawls a company's homepage + a couple of likely "about" pages, returns the
// extracted text content. The text gets fed into the Claude sub-market classifier
// to recover sub_market for domains that aren't in LeadMagic's database.
//
// Actor: apify/website-content-crawler
// Pricing: ~$0.0005 per page. We crawl up to 3 pages per company. ~$0.0015/company.
// Auth: APIFY_API_TOKEN env var.

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID = "apify~website-content-crawler";

// Common "about" page paths to try alongside the homepage. The crawler will
// follow links found on the homepage too, but seeding these increases the odds
// of catching real company text on sites with deep-buried About pages.
const ABOUT_PATHS = ["/", "/about", "/about-us", "/company", "/who-we-are"];

function getApiToken(): string | null {
  return process.env.APIFY_API_TOKEN || null;
}

export interface ScrapedCompanyData {
  domain: string;
  // Text we feed to the classifier
  combined_text: string;
  // Per-page snippets for debugging / observability
  pages: Array<{
    url: string;
    title: string | null;
    description: string | null;
    text_excerpt: string;
  }>;
  // Soft signals we can pull from page metadata
  page_count: number;
  total_chars: number;
}

interface ApifyPageResult {
  url?: string;
  loadedUrl?: string;
  metadata?: {
    title?: string;
    description?: string;
    canonicalUrl?: string;
    languageCode?: string;
  };
  text?: string;
  markdown?: string;
}

/**
 * Scrape a company's website and return text content suitable for classification.
 *
 * Returns null if Apify is not configured, the actor errors out, or no usable
 * content is returned. Caller is expected to fall through to the cheerio-based
 * lightweight fetcher in that case.
 */
export async function scrapeCompanyWebsite(domain: string): Promise<ScrapedCompanyData | null> {
  const token = getApiToken();
  if (!token) {
    console.log("[apify-company] No APIFY_API_TOKEN set, skipping scrape");
    return null;
  }

  // Build the start URLs — homepage + a couple of common about paths.
  // The crawler will dedupe and follow real links from the homepage too.
  const baseUrl = `https://${domain}`;
  const startUrls = ABOUT_PATHS.map((p) => ({ url: baseUrl + p }));

  const input = {
    startUrls,
    maxCrawlDepth: 1,
    maxCrawlPages: 4,
    crawlerType: "playwright:adaptive",
    saveMarkdown: false,
    saveHtml: false,
    removeCookieWarnings: true,
    expandIframes: false,
    requestTimeoutSecs: 20,
    proxyConfiguration: { useApifyProxy: true },
    // Keep dataset items lean — we only need text + metadata
    htmlTransformer: "readableText",
  };

  try {
    // Hard timeout on the fetch — Apify's run-sync API can hang indefinitely
    // when an actor goes wrong. We give it 90s actor budget + 30s fetch margin
    // = 120s total, then bail. Without this the entire backfill batch can stall
    // on a single bad domain.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}&timeout=90`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[apify-company] Actor run failed for ${domain} (${res.status}): ${errBody.slice(0, 300)}`);
      return null;
    }

    const items = (await res.json()) as ApifyPageResult[];
    if (!Array.isArray(items) || items.length === 0) {
      console.log(`[apify-company] No pages returned for ${domain}`);
      return null;
    }

    // Filter to pages that returned actual text
    const usable = items.filter((p) => p.text && p.text.trim().length > 100);
    if (usable.length === 0) {
      console.log(`[apify-company] All pages empty for ${domain}`);
      return null;
    }

    // Build the per-page snippets and a combined text blob (capped)
    const pages = usable.slice(0, 4).map((p) => {
      const text = (p.text || "").replace(/\s+/g, " ").trim();
      return {
        url: p.loadedUrl || p.url || baseUrl,
        title: p.metadata?.title || null,
        description: p.metadata?.description || null,
        text_excerpt: text.slice(0, 1000),
      };
    });

    // Combined text: homepage + about page bodies, capped at ~4000 chars total
    // Plenty for the classifier prompt without burning context
    const combined_text = pages
      .map((p) => {
        const parts: string[] = [];
        if (p.title) parts.push(`Title: ${p.title}`);
        if (p.description) parts.push(`Description: ${p.description}`);
        if (p.text_excerpt) parts.push(`Body: ${p.text_excerpt}`);
        return parts.join("\n");
      })
      .join("\n\n---\n\n")
      .slice(0, 4000);

    return {
      domain,
      combined_text,
      pages,
      page_count: pages.length,
      total_chars: combined_text.length,
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error(`[apify-company] Scrape timed out for ${domain} (>120s)`);
    } else {
      console.error(`[apify-company] Scrape error for ${domain}:`, err?.message || err);
    }
    return null;
  }
}
