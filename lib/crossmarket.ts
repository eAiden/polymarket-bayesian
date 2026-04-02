// Fetches matching questions from Metaculus and Manifold Markets for cross-market validation.
// Both APIs are free with no auth required for read access.

import { extractKeywords, keywordSimilarity } from "./keywords";

export interface CrossMarketMatch {
  platform: "Metaculus" | "Manifold" | "Metaculus+Manifold";
  title: string;
  probability: number; // integer 1-99
  url: string;
  similarity: number; // 0-1, fraction of key terms matched
}

async function fetchWithTimeout(url: string, timeoutMs = 8_000): Promise<Response> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; polymarket-bayesian/1.0)" },
    });
  } finally {
    clearTimeout(tid);
  }
}

// Metaculus requires an API key (free account at metaculus.com).
// Set METACULUS_API_KEY in your .env.local to enable it.
async function fetchMetaculus(question: string, keywords: string[]): Promise<CrossMarketMatch[]> {
  const apiKey = process.env.METACULUS_API_KEY;
  if (!apiKey) return [];

  const query = encodeURIComponent(question.replace(/\?$/, "").slice(0, 100));
  const url = `https://www.metaculus.com/api2/questions/?search=${query}&limit=5&forecast_type=binary`;

  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "Authorization": `Token ${apiKey}`,
        "User-Agent": "Mozilla/5.0 (compatible; polymarket-bayesian/1.0)",
      },
    });
    clearTimeout(tid);
    if (!res.ok) return [];
    const data = await res.json();
    const items: unknown[] = Array.isArray(data.results) ? data.results : [];

    return items
      .filter((q: unknown) => {
        const item = q as Record<string, unknown>;
        if (item.active_state !== "OPEN" && item.active_state !== "open") return false;
        const pred = (item.community_prediction as Record<string, unknown> | undefined)?.full as Record<string, unknown> | undefined;
        return pred?.q2 != null;
      })
      .map((q: unknown) => {
        const item = q as Record<string, unknown>;
        const pred = (item.community_prediction as Record<string, unknown>).full as Record<string, unknown>;
        const prob = Math.round((pred.q2 as number) * 100);
        const title = (item.title as string) ?? "";
        return {
          platform: "Metaculus" as const,
          title,
          probability: Math.min(99, Math.max(1, prob)),
          url: `https://www.metaculus.com${item.page_url ?? ""}`,
          similarity: keywordSimilarity(title, keywords),
        };
      })
      .filter(m => m.similarity >= 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 2);
  } catch {
    return [];
  }
}

async function fetchManifold(question: string, keywords: string[]): Promise<CrossMarketMatch[]> {
  const term = encodeURIComponent(question.replace(/\?$/, "").slice(0, 100));
  const url = `https://api.manifold.markets/v0/search-markets?term=${term}&limit=5`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const items: unknown[] = await res.json();
    if (!Array.isArray(items)) return [];

    return items
      .filter((m: unknown) => {
        const item = m as Record<string, unknown>;
        return item.outcomeType === "BINARY" && !item.isResolved && item.probability != null;
      })
      .map((m: unknown) => {
        const item = m as Record<string, unknown>;
        const prob = Math.round((item.probability as number) * 100);
        const title = (item.question as string) ?? "";
        return {
          platform: "Manifold" as const,
          title,
          probability: Math.min(99, Math.max(1, prob)),
          url: (item.url as string) ?? "https://manifold.markets",
          similarity: keywordSimilarity(title, keywords),
        };
      })
      .filter(m => m.similarity >= 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 2);
  } catch {
    return [];
  }
}

// Deduplicate cross-platform matches: if Metaculus and Manifold return the
// same underlying question (title similarity > 0.8), merge into one entry
// keeping the higher-similarity match and annotating both platform names.
function deduplicateMatches(matches: CrossMarketMatch[]): CrossMarketMatch[] {
  const result: CrossMarketMatch[] = [];
  const used = new Set<number>();

  for (let i = 0; i < matches.length; i++) {
    if (used.has(i)) continue;
    let best = matches[i];
    for (let j = i + 1; j < matches.length; j++) {
      if (used.has(j)) continue;
      // Check title similarity between the two matches
      const aWords = best.title.toLowerCase().split(/\s+/);
      const bWords = matches[j].title.toLowerCase().split(/\s+/);
      const overlap = aWords.filter(w => bWords.includes(w)).length;
      const sim = overlap / Math.max(aWords.length, bWords.length);
      if (sim > 0.6) {
        used.add(j);
        // Keep the one with higher similarity to original question; merge platform names
        const merged = best.similarity >= matches[j].similarity ? best : matches[j];
        best = {
          ...merged,
          platform: `${best.platform}+${matches[j].platform}` as CrossMarketMatch["platform"],
          probability: Math.round((best.probability + matches[j].probability) / 2),
        };
      }
    }
    result.push(best);
  }
  return result;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const crossMarketCache = new Map<string, { data: CrossMarketMatch[]; expiry: number }>();
const CACHE_TTL = 30 * 60 * 1000;

export async function fetchCrossMarketData(question: string): Promise<CrossMarketMatch[]> {
  const keywords = extractKeywords(question);
  const cacheKey = keywords.sort().join("|");
  const cached = crossMarketCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    console.log(`[crossmarket] cache hit for "${question.slice(0, 40)}"`);
    return cached.data;
  }

  const [metaculus, manifold] = await Promise.allSettled([
    fetchMetaculus(question, keywords),
    fetchManifold(question, keywords),
  ]);

  const all = [
    ...(metaculus.status === "fulfilled" ? metaculus.value : []),
    ...(manifold.status === "fulfilled" ? manifold.value : []),
  ];

  const result = deduplicateMatches(all);
  crossMarketCache.set(cacheKey, { data: result, expiry: Date.now() + CACHE_TTL });
  return result;
}

export function formatCrossMarketForPrompt(matches: CrossMarketMatch[]): string {
  if (!Array.isArray(matches) || matches.length === 0) return "No matching questions found on Metaculus or Manifold.";
  return matches
    .map(m => `- [${m.platform} | match:${Math.round(m.similarity * 100)}%] "${m.title}" → ${m.probability}%`)
    .join("\n");
}
