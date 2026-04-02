// Fetches news via Tavily Search API — designed for AI agents.
// Requires TAVILY_API_KEY in .env.local (free tier: 1,000 req/month at app.tavily.com).
// Falls back to Google News RSS if key is absent or request fails.
//
// Call reduction strategy:
//   1. Redis-backed cache (6h TTL) — survives server restarts between daily scans
//   2. In-memory cache (6h TTL)    — zero-latency L1 within a single scan run
//   3. search_depth "basic"        — 1 credit vs 2 for "advanced"
//   4. Skip Tavily for markets resolving >21 days out — RSS is sufficient

import { extractKeywords } from "./keywords";
import { kvGet, kvSetEx } from "./kv";
import type { ScanError } from "./types";

export interface NewsHeadline {
  title: string;
  source: string;
  pubDate: string;
  snippet?: string;  // article body excerpt (Tavily only)
  url?: string;
  score?: number;
}

// ─── Query builder ────────────────────────────────────────────────────────────

function buildQuery(question: string): string {
  return question
    .replace(/will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\s+by\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}/i, "")
    .replace(/\s+in\s+\d{4}/i, "")
    .trim()
    .slice(0, 200);
}

function domainToSource(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "Unknown";
  }
}

// ─── Tavily ───────────────────────────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;       // AI-extracted snippet
  raw_content?: string;  // full page text (advanced depth only)
  published_date?: string;
  score: number;         // Tavily relevance score 0-1
}

interface TavilyResponse {
  results: TavilyResult[];
}

async function fetchViaTavily(question: string, daysUntilResolution = 14): Promise<NewsHeadline[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  // Scale news window to resolution horizon — stale news is useless for imminent markets
  const days = Math.min(14, Math.max(2, daysUntilResolution));

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 12_000);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: buildQuery(question),
        topic: "news",
        search_depth: "basic",   // 1 credit vs 2 for "advanced" — snippets sufficient
        days,
        max_results: 5,
        include_raw_content: false,
      }),
    });
    clearTimeout(tid);
    if (!res.ok) return [];

    const data: TavilyResponse = await res.json();
    if (!Array.isArray(data.results)) return [];

    return data.results
      .filter(r => r.title && r.content)
      .map(r => ({
        title: r.title,
        source: domainToSource(r.url),
        pubDate: r.published_date ?? new Date().toUTCString(),
        snippet: r.content.slice(0, 500).trim(),
        url: r.url,
        score: Math.round(r.score * 100),
      }))
      .slice(0, 5);
  } catch (err) {
    clearTimeout(tid);
    console.warn("[news] Tavily fetch failed:", (err as Error).message);
    return [];
  }
}

// ─── Google News RSS fallback ─────────────────────────────────────────────────

function extractText(tag: string, xml: string): string {
  return (
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ??
    xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`))?.[1] ??
    ""
  ).trim();
}

function parseRssItems(xml: string): NewsHeadline[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  return items.slice(0, 20).map((item) => ({
    title: extractText("title", item),
    source:
      extractText("title", item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[0] ?? "") ||
      extractText("source", item) ||
      "Unknown",
    pubDate: extractText("pubDate", item),
  })).filter(h => h.title.length > 0);
}

function scoreHeadline(headline: NewsHeadline, question: string): number {
  let score = 0;
  const pubMs = new Date(headline.pubDate).getTime();
  if (!isNaN(pubMs)) {
    const ageHours = (Date.now() - pubMs) / 3_600_000;
    score += Math.max(0, 40 - ageHours * 2);
  }
  const src = headline.source.toLowerCase();
  const tier1 = /reuters|ap |associated press|bloomberg|wsj|wall street|ft\.com|financial times|bbc/;
  const tier2 = /politico|economist|guardian|nytimes|new york times|washington post|axios|npr/;
  if (tier1.test(src)) score += 30;
  else if (tier2.test(src)) score += 20;
  else score += 5;
  const keywords = extractKeywords(question);
  const titleLower = headline.title.toLowerCase();
  const matches = keywords.filter(k => titleLower.includes(k)).length;
  score += matches * (30 / Math.max(1, keywords.length));
  return Math.round(score);
}

async function fetchViaRss(question: string): Promise<NewsHeadline[]> {
  const query = encodeURIComponent(buildQuery(question));
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; news-rss-reader/1.0)" },
    });
    clearTimeout(tid);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml)
      .map(h => ({ ...h, score: scoreHeadline(h, question) }))
      .sort((a, b) => b.score! - a.score!)
      .filter(h => h.score! >= 10)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ─── Cache + Public API ───────────────────────────────────────────────────────
// L1: in-memory (fast, lost on restart)
// L2: Upstash Redis (persists across restarts — survives between daily cron runs)
// TTL 6 hours — news doesn't change meaningfully within a scan window.

const newsCache = new Map<string, { data: NewsHeadline[]; expiry: number }>();
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;  // 6 hours in ms  (L1)
const CACHE_TTL_SEC = 6 * 60 * 60;          // 6 hours in sec (L2 Redis EX)
const KV_PREFIX = "news:v1:";

// Markets resolving >21 days out: Tavily adds little over free RSS.
// This alone skips ~30-40% of Tavily calls on a typical scan.
const TAVILY_MAX_DAYS = 21;

export async function fetchNewsForMarket(question: string, daysUntilResolution = 14, errors?: ScanError[]): Promise<NewsHeadline[]> {
  const cacheKey = buildQuery(question).toLowerCase().trim();

  // L1: in-memory hit
  const mem = newsCache.get(cacheKey);
  if (mem && mem.expiry > Date.now()) {
    console.log(`[news] L1 cache hit for "${question.slice(0, 40)}"`);
    return mem.data;
  }

  // L2: Redis hit (survives server restarts)
  const kvKey = KV_PREFIX + cacheKey;
  const kvData = await kvGet<NewsHeadline[]>(kvKey);
  if (kvData) {
    console.log(`[news] L2 Redis hit for "${question.slice(0, 40)}"`);
    newsCache.set(cacheKey, { data: kvData, expiry: Date.now() + CACHE_TTL_MS });
    return kvData;
  }

  const store = (data: NewsHeadline[]) => {
    newsCache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL_MS });
    kvSetEx(kvKey, data, CACHE_TTL_SEC);
  };

  // Skip Tavily for far-out markets — RSS is sufficient and free
  if (daysUntilResolution > TAVILY_MAX_DAYS) {
    console.log(`[news] Skipping Tavily (${daysUntilResolution}d > ${TAVILY_MAX_DAYS}d), using RSS for "${question.slice(0, 40)}"`);
    const rss = await fetchViaRss(question);
    store(rss);
    return rss;
  }

  // Try Tavily; fall back to RSS if key missing or request fails
  const tavily = await fetchViaTavily(question, daysUntilResolution);
  if (tavily.length > 0) {
    console.log(`[news] Tavily(days=${Math.min(14, Math.max(2, daysUntilResolution))}): ${tavily.length} results for "${question.slice(0, 40)}"`);
    store(tavily);
    return tavily;
  }

  // Tavily returned nothing — fall back to RSS
  const rss = await fetchViaRss(question);
  console.log(`[news] RSS fallback: ${rss.length} results for "${question.slice(0, 40)}"`);
  if (rss.length === 0 && process.env.TAVILY_API_KEY) {
    errors?.push({ source: "news", message: `No news found for "${question.slice(0, 50)}"`, timestamp: new Date().toISOString() });
  }
  store(rss);
  return rss;
}

export function formatNewsForPrompt(headlines: NewsHeadline[]): string {
  if (headlines.length === 0) return "No recent news found.";
  return headlines
    .map((h, i) => {
      const meta = [h.source, h.score !== undefined ? `relevance:${h.score}` : ""].filter(Boolean).join(" | ");
      const date = h.pubDate ? ` (${new Date(h.pubDate).toDateString()})` : "";
      const body = h.snippet ? `\n   "${h.snippet}"` : "";
      return `${i + 1}. [${meta}] ${h.title}${date}${body}`;
    })
    .join("\n");
}
