// Lightweight website fetcher — final fallback when both LeadMagic and Apify fail.
//
// Plain `fetch()` of the homepage, then regex-extracts <title>, <meta description>,
// OpenGraph tags, and a small slice of body text. No JS rendering, no anti-bot
// handling — but fast (sub-second), free, and good enough for static marketing
// sites that LeadMagic missed and Apify either errored or wasn't configured.
//
// Returns null on any failure so callers can fall through cleanly.

export interface WebsiteFetchResult {
  domain: string;
  url: string;
  status: number;
  title: string | null;
  description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_site_name: string | null;
  body_excerpt: string;
  combined_text: string;
}

const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ACME-GTMOS/1.0; +https://acmegtm.com/bot)";

/**
 * Try fetching a domain's homepage and extract whatever metadata we can.
 *
 * Returns null on:
 *   - HTTP errors (4xx/5xx)
 *   - Timeouts
 *   - Empty/non-HTML responses
 *   - Aggressive anti-bot blocks
 */
export async function fetchWebsite(domain: string): Promise<WebsiteFetchResult | null> {
  const url = `https://${domain}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.log(`[website-fetch] ${domain} returned ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) {
      console.log(`[website-fetch] ${domain} returned non-HTML (${contentType})`);
      return null;
    }

    // Read up to 200KB of body — homepages with more than that are usually
    // bloated SPAs we can't usefully parse without JS rendering anyway
    const reader = res.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const MAX_SIZE = 200_000;

    while (totalSize < MAX_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalSize += value.byteLength;
    }
    reader.cancel();

    const html = new TextDecoder("utf-8").decode(
      Buffer.concat(chunks.map((c) => Buffer.from(c)))
    );

    if (!html || html.length < 200) {
      console.log(`[website-fetch] ${domain} returned tiny HTML (${html.length} chars)`);
      return null;
    }

    return parseHtml(domain, res.url || url, res.status, html);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.log(`[website-fetch] ${domain} timed out`);
    } else {
      console.log(`[website-fetch] ${domain} error: ${err?.message || err}`);
    }
    return null;
  }
}

// --- HTML parsing helpers (regex-based, no cheerio) ---

function parseHtml(
  domain: string,
  url: string,
  status: number,
  html: string,
): WebsiteFetchResult {
  const title = extractTitle(html);
  const description = extractMetaContent(html, "description");
  const og_title = extractOgContent(html, "og:title");
  const og_description = extractOgContent(html, "og:description");
  const og_site_name = extractOgContent(html, "og:site_name");
  const body_excerpt = extractBodyText(html, 2000);

  const combined_text = [
    title && `Title: ${title}`,
    description && `Description: ${description}`,
    og_title && og_title !== title && `OG Title: ${og_title}`,
    og_description && og_description !== description && `OG Description: ${og_description}`,
    og_site_name && `Site Name: ${og_site_name}`,
    body_excerpt && `Body: ${body_excerpt}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  return {
    domain,
    url,
    status,
    title,
    description,
    og_title,
    og_description,
    og_site_name,
    body_excerpt,
    combined_text,
  };
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!match) return null;
  return decodeHtmlEntities(match[1].trim()).slice(0, 200) || null;
}

function extractMetaContent(html: string, name: string): string | null {
  // <meta name="description" content="..."> — name attr can come before or after content
  const re = new RegExp(
    `<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const reAlt = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`,
    "i",
  );
  const match = html.match(re) || html.match(reAlt);
  if (!match) return null;
  return decodeHtmlEntities(match[1].trim()).slice(0, 500) || null;
}

function extractOgContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const reAlt = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`,
    "i",
  );
  const match = html.match(re) || html.match(reAlt);
  if (!match) return null;
  return decodeHtmlEntities(match[1].trim()).slice(0, 500) || null;
}

function extractBodyText(html: string, maxChars: number): string {
  // Strip <script>, <style>, <noscript>, <svg>, comments, and all tags.
  // We're not trying to render — just trying to give the classifier some
  // human-readable text to work with.
  const stripped = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return decodeHtmlEntities(stripped).slice(0, maxChars);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
