// Signal extraction via Claude — batched: 10 markets per prompt instead of 1 per market.
import { execFile } from "child_process";
import { promisify } from "util";
import type { FilteredMarket, ExtractedSignal, MarketEnrichment, DailySnapshot, NewsSignal, ScanError } from "./types";
import { fetchNewsForMarket, formatNewsForPrompt } from "./news";
import { fetchCrossMarketData, formatCrossMarketForPrompt, type CrossMarketMatch } from "./crossmarket";
import { fetchOrderBook, fetchRecentTrades, formatOrderBookForPrompt } from "./orderbook";
import { fetchFredData, formatFredForPrompt } from "./fred";
import { fetchCryptoPrices, formatCryptoForPrompt } from "./crypto";

const execFileAsync = promisify(execFile);

const EXTRACTION_MODEL = "claude-sonnet-4-6";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "/opt/homebrew/bin/claude";
const BATCH_SIZE = 10;

async function callClaude(systemPrompt: string, userPrompt: string, model = EXTRACTION_MODEL): Promise<string> {
  const { stdout } = await execFileAsync(CLAUDE_PATH, [
    "--print",
    "--model", model,
    "--system-prompt", systemPrompt,
    userPrompt,
  ], {
    cwd: "/tmp",
    timeout: 240_000,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

// ─── Batch result type ────────────────────────────────────────────────────────

export interface BatchedSignalResult {
  signal: ExtractedSignal;
  likelihoodRatio: number;
  reasoning: string;
  keyFactors: { bullish: string[]; bearish: string[] };
  sources: string[];
  topFact: string;
  newsAge: "stale" | "recent" | "breaking";
}

// ─── System prompt ────────────────────────────────────────────────────────────

const BATCH_SYSTEM = `You are a news analyst for prediction markets. Your job is to extract structured signals from news and market data for multiple markets at once.

CRITICAL: You must NEVER estimate a probability. You extract facts and categorize them — that is all.

Return ONLY a raw JSON array — no markdown, no backticks, no explanatory text. Each element must match the schema exactly.`;

// ─── Per-market context builder ───────────────────────────────────────────────

interface MarketContext {
  market: FilteredMarket;
  news: string;
  crossMarket: string;
  crossMatches: CrossMarketMatch[];
  enrichment: MarketEnrichment;
}

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

  return `PRICE HISTORY (last ${days}d): ${points}\nTrend: ${delta > 0 ? "+" : ""}${delta}pp over ${days} days`;
}

function buildBatchPrompt(contexts: MarketContext[]): string {
  const today = new Date().toDateString();
  const n = contexts.length;

  const marketBlocks = contexts.map((ctx, i) => {
    const { market, news, crossMarket, crossMatches, enrichment } = ctx;
    const obSection = formatOrderBookForPrompt(enrichment?.orderBook ?? null, enrichment?.trades ?? null);
    const historySection = formatPriceHistory(enrichment?.priceHistory);

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

    const allPrices = [market.yesProbPct, ...crossMatches.map(m => m.probability)];
    const crossSpread = allPrices.length > 1 ? Math.max(...allPrices) - Math.min(...allPrices) : 0;

    return `[Market ${i + 1}] ${market.question}
Current YES price: ${market.yesProbPct}%
Resolves: ${market.endDate} (${market.daysUntilResolution} days from today, ${today})
Category: ${market.category}

${resolutionSection}
${historySection ? "\n" + historySection : ""}

Recent News:
${news}

Cross-Market Prices:
${crossMarket}
Cross-market price spread: ${crossSpread}pp

Market Microstructure:
${obSection}${domainData ? "\n" + domainData : ""}`;
  }).join("\n\n---\n\n");

  return `Analyze these ${n} prediction markets. For each, extract news signals and assess their impact on the YES outcome.

${marketBlocks}

Return ONLY a JSON array with exactly ${n} objects in order:
[
  {
    "marketIndex": 1,
    "newsSignals": [
      {
        "fact": "<string, max 150 chars — the concrete fact from news>",
        "direction": "YES or NO",
        "strength": "strong or moderate or weak",
        "recency": "breaking or today or this_week or older",
        "source": "<source name>"
      }
    ],
    "likelihoodRatio": 1.0,
    "reasoning": "<2-3 sentences explaining your assessment>",
    "keyFactors": {
      "bullish": ["<factor supporting YES>"],
      "bearish": ["<factor supporting NO>"]
    },
    "topFact": "<single most important fact from news>",
    "newsAge": "recent or stale or breaking",
    "crossMarketDisagreement": 0,
    "informationCompleteness": "high or medium or low",
    "resolution": {
      "daysLeft": 14,
      "ambiguityRisk": "low or medium or high"
    }
  }
]

Rules:
- Extract 2-5 newsSignals per market. Each must cite a SPECIFIC fact from the news.
- "strong" = this fact alone could move market 5+pp; "moderate" = relevant; "weak" = tangential
- likelihoodRatio: 0.5-2.0 float — product of signal effects on YES probability (1.0 = neutral)
- newsAge: "breaking" = last 2h, "recent" = last 7 days, "stale" = older
- NEVER estimate a probability. Only extract facts and categorize signals.`;
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function parseJsonArray(text: string): Record<string, unknown>[] | null {
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const match = stripped.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as Record<string, unknown>[]; } catch { return null; }
}

// ─── Validate a single item from batch ───────────────────────────────────────

function validateBatchItem(raw: Record<string, unknown>, market: FilteredMarket): BatchedSignalResult | null {
  const newsSignals = Array.isArray(raw.newsSignals) ? raw.newsSignals : [];
  if (newsSignals.length === 0) return null;

  const validatedSignals: NewsSignal[] = newsSignals.slice(0, 5).map((s: Record<string, unknown>) => ({
    fact: typeof s.fact === "string" ? s.fact.slice(0, 150) : "Unknown",
    direction: s.direction === "NO" ? "NO" as const : "YES" as const,
    strength: (["strong", "moderate", "weak"] as const).find(v => v === s.strength) ?? "moderate",
    recency: (["breaking", "today", "this_week", "older"] as const).find(v => v === s.recency) ?? "older",
    source: typeof s.source === "string" ? s.source : "Unknown",
  }));

  const resolution = raw.resolution as Record<string, unknown> | undefined;
  const newsAge = (["stale", "recent", "breaking"] as const).find(v => v === raw.newsAge) ?? "stale";
  const lr = typeof raw.likelihoodRatio === "number"
    ? Math.max(0.25, Math.min(4.0, raw.likelihoodRatio))
    : 1.0;

  const kf = raw.keyFactors as { bullish?: unknown[]; bearish?: unknown[] } | undefined;
  const keyFactors = {
    bullish: Array.isArray(kf?.bullish) ? kf!.bullish.filter(s => typeof s === "string") as string[] : [],
    bearish: Array.isArray(kf?.bearish) ? kf!.bearish.filter(s => typeof s === "string") as string[] : [],
  };

  const signal: ExtractedSignal = {
    newsSignals: validatedSignals,
    resolution: {
      daysLeft: market.daysUntilResolution,
      ambiguityRisk: (["high", "medium", "low"] as const).find(v => v === resolution?.ambiguityRisk) ?? "medium",
      criticalDate: typeof resolution?.criticalDate === "string" ? resolution.criticalDate : undefined,
      resolutionNote: typeof resolution?.resolutionNote === "string"
        ? (resolution.resolutionNote as string).slice(0, 150) : undefined,
    },
    crossMarketDisagreement: Math.max(0, Math.min(100, Number(raw.crossMarketDisagreement) || 0)),
    newsAge,
    informationCompleteness: (["high", "medium", "low"] as const).find(v => v === raw.informationCompleteness) ?? "medium",
  };

  const sources = [...new Set(validatedSignals.map(s => s.source))].slice(0, 4);
  const topFact = typeof raw.topFact === "string" ? raw.topFact :
    validatedSignals.find(s => s.strength === "strong")?.fact ??
    validatedSignals[0]?.fact ?? "";

  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning.slice(0, 600) : "";

  return { signal, likelihoodRatio: lr, reasoning, keyFactors, sources, topFact, newsAge };
}

// ─── Enrichment fetch (unchanged from original) ───────────────────────────────

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

// ─── Batch extraction — main export ──────────────────────────────────────────

export async function extractSignalsBatch(
  markets: FilteredMarket[],
  enrichments: Map<string, MarketEnrichment>,
  errors: ScanError[],
): Promise<Map<string, BatchedSignalResult>> {
  const results = new Map<string, BatchedSignalResult>();
  if (markets.length === 0) return results;

  // Chunk into groups of BATCH_SIZE
  for (let batchStart = 0; batchStart < markets.length; batchStart += BATCH_SIZE) {
    const batch = markets.slice(batchStart, batchStart + BATCH_SIZE);

    // Fetch news + cross-market for all markets in this batch concurrently
    const contextPromises = batch.map(async (market): Promise<MarketContext> => {
      const [headlines, crossMatches] = await Promise.all([
        fetchNewsForMarket(market.question, market.daysUntilResolution, errors),
        fetchCrossMarketData(market.question),
      ]);
      const news = formatNewsForPrompt(headlines);
      const crossMarket = formatCrossMarketForPrompt(crossMatches);
      const enrichment = enrichments.get(market.id) ?? {};
      return { market, news, crossMarket, crossMatches, enrichment };
    });

    const contexts = await Promise.all(contextPromises);

    // Build and send batch prompt
    const prompt = buildBatchPrompt(contexts);
    let rawOutput: string;
    try {
      rawOutput = await callClaude(BATCH_SYSTEM, prompt, EXTRACTION_MODEL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ source: "analysis", message: `Batch Claude call failed (offset ${batchStart}): ${msg}`, timestamp: new Date().toISOString() });
      console.error(`[extract-batch] Claude call failed for batch at offset ${batchStart}:`, msg);
      continue;
    }

    // Parse the JSON array response
    const parsed = parseJsonArray(rawOutput);
    if (!parsed || !Array.isArray(parsed)) {
      errors.push({ source: "analysis", message: `Failed to parse batch response (offset ${batchStart})`, timestamp: new Date().toISOString() });
      console.error(`[extract-batch] Failed to parse response for batch at offset ${batchStart}`);
      continue;
    }

    // Map results back to market IDs by position
    for (let j = 0; j < batch.length; j++) {
      const market = batch[j];
      const item = parsed[j] as Record<string, unknown> | undefined;

      if (!item) {
        errors.push({ source: "analysis", message: `Missing batch result for "${market.question.slice(0, 50)}"`, timestamp: new Date().toISOString() });
        continue;
      }

      const validated = validateBatchItem(item, market);
      if (!validated) {
        errors.push({ source: "analysis", message: `Invalid batch result for "${market.question.slice(0, 50)}"`, timestamp: new Date().toISOString() });
        continue;
      }

      results.set(market.id, validated);
      console.log(`[extract-batch] ${market.question.slice(0, 40)}: ${validated.signal.newsSignals.length} signals, lr=${validated.likelihoodRatio.toFixed(2)}, age=${validated.newsAge}`);
    }
  }

  return results;
}

// ─── Legacy single-market extraction (kept for backward compat with fast reanalysis) ─────

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
  const enrichment = await fetchEnrichment(market, priceHistory, categoryBiasMap);
  const batchResult = await extractSignalsBatch([market], new Map([[market.id, enrichment]]), errors);
  const result = batchResult.get(market.id);
  if (!result) return null;

  const crossMatches = await fetchCrossMarketData(market.question);
  return { market, signal: result.signal, crossMatches, enrichment };
}
