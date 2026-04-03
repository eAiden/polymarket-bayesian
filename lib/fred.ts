import type { FredData } from "./types";

// FRED API — free, no key needed for JSON format
const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
// Use FRED_API_KEY env var if set; fall back to the public demo key for low-volume usage
const FRED_API_KEY = process.env.FRED_API_KEY ?? "DEMO_KEY";

// Cache: economic data changes slowly
let cache: { data: FredData; expiry: number } | null = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const SERIES: Record<string, string> = {
  cpiYoY: "CPIAUCSL",          // CPI for All Urban Consumers
  unemploymentRate: "UNRATE",   // Unemployment Rate
  fedFundsRate: "FEDFUNDS",     // Federal Funds Effective Rate
  gdpGrowth: "A191RL1Q225SBEA", // Real GDP Growth Rate (quarterly)
};

async function fetchSeries(seriesId: string): Promise<number | undefined> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    try {
      const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
      const res = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!res.ok) return undefined;
      const data = await res.json();
      const obs = data.observations?.[0];
      if (!obs || obs.value === ".") return undefined;
      return parseFloat(obs.value);
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return undefined;
  }
}

export async function fetchFredData(): Promise<FredData | null> {
  // Check cache
  if (cache && Date.now() < cache.expiry) {
    return cache.data;
  }

  try {
    const [cpiYoY, unemploymentRate, fedFundsRate, gdpGrowth] = await Promise.all([
      fetchSeries(SERIES.cpiYoY),
      fetchSeries(SERIES.unemploymentRate),
      fetchSeries(SERIES.fedFundsRate),
      fetchSeries(SERIES.gdpGrowth),
    ]);

    // At least one series must succeed
    if (cpiYoY === undefined && unemploymentRate === undefined && fedFundsRate === undefined && gdpGrowth === undefined) {
      return null;
    }

    const data: FredData = {
      cpiYoY,
      unemploymentRate,
      fedFundsRate,
      gdpGrowth,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data, expiry: Date.now() + CACHE_TTL };
    return data;
  } catch {
    return null;
  }
}

export function formatFredForPrompt(fred: FredData | null): string {
  if (!fred) return "";

  const parts: string[] = ["ECONOMIC INDICATORS (FRED, latest available):"];
  if (fred.cpiYoY !== undefined) parts.push(`  CPI (YoY): ${fred.cpiYoY}%`);
  if (fred.unemploymentRate !== undefined) parts.push(`  Unemployment: ${fred.unemploymentRate}%`);
  if (fred.fedFundsRate !== undefined) parts.push(`  Fed Funds Rate: ${fred.fedFundsRate}%`);
  if (fred.gdpGrowth !== undefined) parts.push(`  GDP Growth (quarterly): ${fred.gdpGrowth}%`);

  return parts.length > 1 ? parts.join("\n") : "";
}
