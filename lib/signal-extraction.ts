// Signal extraction via Claude — extracts structured facts, never probabilities.
import { execFile } from "child_process";
import { promisify } from "util";
import type { FilteredMarket, ExtractedSignal, MarketEnrichment, DailySnapshot } from "./types";
import type { ScanError } from "./types";
import { fetchNewsForMarket, formatNewsForPrompt } from "./news";
import { fetchCrossMarketData, formatCrossMarketForPrompt, type CrossMarketMatch } from "./crossmarket";
import { fetchOrderBook, fetchRecentTrades, formatOrderBookForPrompt } from "./orderbook";
import { fetchFredData, formatFredForPrompt } from "./fred";
import { fetchCryptoPrices, formatCryptoForPrompt } from "./crypto";

const execFileAsync = promisify(execFile);

const EXTRACTION_MODEL = "claude-sonnet-4-6";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "/opt/homebrew/bin/claude";

async function callClaude(systemPrompt: string, userPrompt: string, model = EXTRACTION_MODEL): Promise<string> {
  const { stdout } = await execFileAsync(CLAUDE_PATH, [
    "--print",
    "--model", model,
    "--system-prompt", systemPrompt,
    userPrompt,
  ], {
    cwd: "/tmp",
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 4,
  });
  return stdout;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SIGNAL_SYSTEM = `You are a news analyst for prediction markets. Your job is to extract structured signals from news and market data.

CRITICAL: You must NEVER estimate a probability. You extract facts and categorize them — that's it.

Return ONLY a raw JSON object — no markdown, no backticks, no other text. Follow the schema exactly.`;

// ─── Prompt builder ─────────────────────────────────────────────────────────

function buildExtractionPrompt(
  market: FilteredMarket,
  news: string,
  crossMarket: string,
  crossMatches: CrossMarketMatch[],
  enrichment: MarketEnrichment,
): string {
  const today = new Date().toDateString();
  const obSection = formatOrderBookForPrompt(enrichment?.orderBook ?? null, enrichment?.trades ?? null);

  let domainData = "";
  if (market.category === "Economics" && enrichment?.fred) {
    domainData = formatFredForPrompt(enrichment.fred);
  }
  if (market.category === "Crypto" && enrichment?.crypto) {
    domainData = formatCryptoForPrompt(enrichment.crypto);
  }

  const resolutionSection = market.description
    ? `RESOLUTION CRITERIA: ${market.description}${market.resolutionSource ? `\nResolution source: ${market.resolutionSource}` : ""}`
    : "RESOLUTION CRITERIA: Not available.";

  const historySection = formatPriceHistory(enrichment?.priceHistory);

  // Compute cross-market spread for context
  const allPrices = [market.yesProbPct, ...crossMatches.map(m => m.probability)];
  const crossSpread = allPrices.length > 1
    ? Math.max(...allPrices) - Math.min(...allPrices)
    : 0;

  return `MARKET: ${market.question}
CURRENT PRICE: ${market.yesProbPct}% YES
RESOLVES: ${market.endDate} (${market.daysUntilResolution} days from today, ${today})
CATEGORY: ${market.category}

${resolutionSection}

${historySection ? historySection + "\n" : ""}RECENT NEWS:
${news}

CROSS-MARKET PRICES:
${crossMarket}
Cross-market price spread: ${crossSpread}pp

MARKET MICROSTRUCTURE:
${obSection}
${domainData ? "\n" + domainData : ""}

---

Extract the following signals from the data above. Do NOT estimate any probabilities.

Return this exact JSON schema:
{
  "newsSignals": [
    {
      "fact": "<string, max 150 chars — the concrete fact from news>",
      "direction": "<YES or NO — does this fact push toward YES or NO resolution?>",
      "strength": "<strong | moderate | weak>",
      "recency": "<breaking | today | this_week | older>",
      "source": "<source name>"
    }
  ],
  "resolution": {
    "daysLeft": ${market.daysUntilResolution},
    "ambiguityRisk": "<high | medium | low — risk of surprising resolution interpretation>",
    "criticalDate": "<ISO date string if there's a specific pivotal date, or null>",
    "resolutionNote": "<string max 150 chars — any edge case spotted, or null>"
  },
  "crossMarketDisagreement": <integer 0-100 — 0 = full consensus, 100 = wildly different>,
  "newsAge": "<stale | recent | breaking — freshness of most relevant news>",
  "informationCompleteness": "<high | medium | low — do you have enough info to assess this market?>",
  "domainSignals": {
    "keyMetric": "<e.g. 'BTC at $72,400' or 'CPI at 3.2%' — the most relevant domain number, or null>",
    "trendDirection": "<up | down | flat — trend of key metric, or null>",
    "volatilityAssessment": "<high | normal | low — current domain volatility, or null>"
  }
}

RULES:
- Extract 2-5 news signals. Each must cite a SPECIFIC fact from the news, not a vague summary.
- "strong" = this fact alone could move the market 5+pp if widely known
- "moderate" = relevant but not market-moving on its own
- "weak" = tangentially relevant
- "breaking" = published in last 2 hours, "today" = last 24h, "this_week" = last 7 days
- crossMarketDisagreement: 0-20 = consensus, 20-50 = mild disagreement, 50+ = major disagreement
- domainSignals: only populate for Economics, Crypto, Science categories`;
}

// ─── Price history formatter (reused from analysis) ─────────────────────────

function formatPriceHistory(history?: DailySnapshot[]): string {
  if (!history || history.length < 2) return "";
  const recent = history.slice(-14);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const delta = last.marketProb - first.marketProb;
  const days = Math.round((new Date(last.date).getTime() - new Date(first.date).getTime()) / 86_400_000);

  const points = recent.map(s => {
    const d = new Date(s.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${d}: ${s.marketProb}%`;
  }).join(" → ");

  return `PRICE HISTORY (last ${days}d): ${points}
Trend: ${delta > 0 ? "+" : ""}${delta}pp over ${days} days (${Math.abs(delta) > 10 ? "strong" : Math.abs(delta) > 5 ? "moderate" : "mild"} ${delta > 0 ? "upward" : delta < 0 ? "downward" : "flat"} movement)`;
}

// ─── JSON parsing ───────────────────────────────────────────────────────────

function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ─── Enrichment fetch ───────────────────────────────────────────────────────

export async function fetchEnrichment(
  market: FilteredMarket,
  priceHistory?: DailySnapshot[],
  categoryBiasMap?: Map<string, MarketEnrichment["calibrationBias"]>,
): Promise<MarketEnrichment> {
  const enrichment: MarketEnrichment = {};

  const yesTokenId = market.clobTokenIds?.[0];
  if (yesTokenId) {
    const [ob, trades] = await Promise.all([
      fetchOrderBook(yesTokenId),
      fetchRecentTrades(yesTokenId),
    ]);
    enrichment.orderBook = ob;
    enrichment.trades = trades;
  }

  if (market.category === "Economics") {
    enrichment.fred = await fetchFredData();
  }
  if (market.category === "Crypto") {
    enrichment.crypto = await fetchCryptoPrices();
  }

  if (priceHistory && priceHistory.length >= 2) {
    enrichment.priceHistory = priceHistory;
  }

  if (categoryBiasMap?.has(market.category)) {
    enrichment.calibrationBias = categoryBiasMap.get(market.category);
  }

  return enrichment;
}

// ─── Validate extracted signal ──────────────────────────────────────────────

function validateSignal(raw: Record<string, unknown>, market: FilteredMarket): ExtractedSignal | null {
  const newsSignals = Array.isArray(raw.newsSignals) ? raw.newsSignals : [];
  const resolution = raw.resolution as Record<string, unknown> | undefined;

  if (newsSignals.length === 0) return null;

  return {
    newsSignals: newsSignals.slice(0, 5).map((s: Record<string, unknown>) => ({
      fact: typeof s.fact === "string" ? s.fact.slice(0, 150) : "Unknown",
      direction: s.direction === "NO" ? "NO" as const : "YES" as const,
      strength: (["strong", "moderate", "weak"] as const).find(v => v === s.strength) ?? "moderate",
      recency: (["breaking", "today", "this_week", "older"] as const).find(v => v === s.recency) ?? "older",
      source: typeof s.source === "string" ? s.source : "Unknown",
    })),
    resolution: {
      daysLeft: market.daysUntilResolution,
      ambiguityRisk: (["high", "medium", "low"] as const).find(v => v === resolution?.ambiguityRisk) ?? "medium",
      criticalDate: typeof resolution?.criticalDate === "string" ? resolution.criticalDate : undefined,
      resolutionNote: typeof resolution?.resolutionNote === "string" ? (resolution.resolutionNote as string).slice(0, 150) : undefined,
    },
    crossMarketDisagreement: Math.max(0, Math.min(100, Number(raw.crossMarketDisagreement) || 0)),
    newsAge: (["stale", "recent", "breaking"] as const).find(v => v === raw.newsAge) ?? "stale",
    informationCompleteness: (["high", "medium", "low"] as const).find(v => v === raw.informationCompleteness) ?? "medium",
    domainSignals: raw.domainSignals ? {
      keyMetric: typeof (raw.domainSignals as Record<string, unknown>).keyMetric === "string"
        ? ((raw.domainSignals as Record<string, unknown>).keyMetric as string) : undefined,
      trendDirection: (["up", "down", "flat"] as const).find(v => v === (raw.domainSignals as Record<string, unknown>).trendDirection),
      volatilityAssessment: (["high", "normal", "low"] as const).find(v => v === (raw.domainSignals as Record<string, unknown>).volatilityAssessment),
    } : undefined,
  };
}

// ─── Main export ────────────────────────────────────────────────────────────

export interface ExtractionResult {
  market: FilteredMarket;
  signal: ExtractedSignal;
  crossMatches: CrossMarketMatch[];
  enrichment: MarketEnrichment;
}

export async function extractSignals(
  market: FilteredMarket,
  errors: ScanError[],
  priceHistory?: DailySnapshot[],
  categoryBiasMap?: Map<string, MarketEnrichment["calibrationBias"]>,
): Promise<ExtractionResult | null> {
  const [headlines, crossMatches, enrichment] = await Promise.all([
    fetchNewsForMarket(market.question, market.daysUntilResolution, errors),
    fetchCrossMarketData(market.question),
    fetchEnrichment(market, priceHistory, categoryBiasMap),
  ]);
  const news = formatNewsForPrompt(headlines);
  const crossMarket = formatCrossMarketForPrompt(crossMatches);

  const raw = await callClaude(
    SIGNAL_SYSTEM,
    buildExtractionPrompt(market, news, crossMarket, crossMatches, enrichment),
    EXTRACTION_MODEL,
  );

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    errors.push({ source: "analysis", message: `Signal extraction failed for "${market.question.slice(0, 50)}"`, timestamp: new Date().toISOString() });
    return null;
  }

  const signal = validateSignal(parsed, market);
  if (!signal) {
    errors.push({ source: "analysis", message: `Invalid signal for "${market.question.slice(0, 50)}"`, timestamp: new Date().toISOString() });
    return null;
  }

  console.log(`[extract] ${market.question.slice(0, 40)}: ${signal.newsSignals.length} signals, age=${signal.newsAge}, completeness=${signal.informationCompleteness}`);

  return { market, signal, crossMatches, enrichment };
}
