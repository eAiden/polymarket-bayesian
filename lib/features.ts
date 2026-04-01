// Feature engineering: converts extracted signals + market data into numeric feature vector.
// Pure function — deterministic, testable, no LLM involved.

import type { ExtractedSignal, FeatureVector, MarketEnrichment, DailySnapshot } from "./types";
import type { CrossMarketMatch } from "./crossmarket";

export function computeFeatures(
  signal: ExtractedSignal,
  marketProb: number,
  enrichment: MarketEnrichment,
  crossMatches: CrossMarketMatch[],
  categoryBias: number,
): FeatureVector {
  const now = new Date().toISOString();

  // ─── News signals ───────────────────────────────────────────────────────────
  const strengthWeight = { strong: 1.0, moderate: 0.5, weak: 0.2 };
  let yesWeight = 0;
  let noWeight = 0;
  let strongCount = 0;
  let hasBreaking = false;

  for (const s of signal.newsSignals) {
    const w = strengthWeight[s.strength];
    if (s.direction === "YES") yesWeight += w;
    else noWeight += w;
    if (s.strength === "strong") strongCount++;
    if (s.recency === "breaking") hasBreaking = true;
  }

  const totalWeight = yesWeight + noWeight;
  const netNewsDirection = totalWeight > 0 ? (yesWeight - noWeight) / totalWeight : 0;

  // ─── Categorical → numeric ──────────────────────────────────────────────────
  const newsAgeMap = { breaking: 1.0, recent: 0.5, stale: 0 };
  const completenessMap = { high: 1.0, medium: 0.5, low: 0 };
  const ambiguityMap = { high: 1.0, medium: 0.5, low: 0 };

  // ─── Market microstructure ──────────────────────────────────────────────────
  let buySellImbalance = 0;
  let volumeSpike = 0;
  let spreadPct = 0;
  let liquidityRatio = 1;

  if (enrichment.trades) {
    const t = enrichment.trades;
    buySellImbalance = t.buySellRatio > 0
      ? Math.max(-1, Math.min(1, (t.buySellRatio - 1) / 2)) // normalize around 1.0
      : 0;
    volumeSpike = t.avgTradeSize > 0 ? t.totalTrades / 50 : 0; // rough proxy
  }

  if (enrichment.orderBook) {
    const ob = enrichment.orderBook;
    spreadPct = ob.spread;
    liquidityRatio = ob.askDepth > 0 ? ob.bidDepth / ob.askDepth : 1;
  }

  // ─── Price momentum ─────────────────────────────────────────────────────────
  const history = enrichment.priceHistory ?? [];
  const priceMomentum3d = computeMomentum(history, 3);
  const priceMomentum7d = computeMomentum(history, 7);

  // ─── Cross-market ───────────────────────────────────────────────────────────
  const allPrices = [marketProb, ...crossMatches.map(m => m.probability)];
  const crossMarketSpread = allPrices.length > 1
    ? Math.max(...allPrices) - Math.min(...allPrices)
    : 0;

  // Compute consensus (weighted: Polymarket 2x, others 1x)
  let weightedSum = marketProb * 2;
  let totalW = 2;
  for (const m of crossMatches) {
    const w = m.similarity >= 0.7 ? 1.0 : 0.5;
    weightedSum += m.probability * w;
    totalW += w;
  }
  const consensus = weightedSum / totalW;
  const polymarketVsConsensus = marketProb - consensus;

  // ─── Time ───────────────────────────────────────────────────────────────────
  const daysToResolution = signal.resolution.daysLeft;
  const urgency = daysToResolution > 0 ? 1 / Math.sqrt(daysToResolution) : 2; // cap at 2 for same-day

  return {
    netNewsDirection,
    strongSignalCount: strongCount,
    breakingNewsPresent: hasBreaking ? 1 : 0,
    newsAge: newsAgeMap[signal.newsAge],
    informationCompleteness: completenessMap[signal.informationCompleteness],
    resolutionAmbiguity: ambiguityMap[signal.resolution.ambiguityRisk],
    buySellImbalance,
    volumeSpike: Math.min(3, volumeSpike), // cap at 3x
    spreadPct,
    liquidityRatio: Math.max(0.1, Math.min(10, liquidityRatio)), // cap range
    priceMomentum3d,
    priceMomentum7d,
    crossMarketSpread,
    polymarketVsConsensus,
    daysToResolution,
    urgency,
    categoryBias,
    timestamp: now,
    marketProbAtExtraction: marketProb,
  };
}

function computeMomentum(history: DailySnapshot[], lookbackDays: number): number {
  if (history.length < 2) return 0;
  const now = Date.now();
  const cutoff = now - lookbackDays * 86_400_000;

  // Find the snapshot closest to the cutoff
  let oldestInWindow: DailySnapshot | null = null;
  for (const s of history) {
    if (new Date(s.date).getTime() >= cutoff) {
      if (!oldestInWindow) oldestInWindow = s;
    }
  }

  if (!oldestInWindow) return 0;
  const latest = history[history.length - 1];
  return latest.marketProb - oldestInWindow.marketProb;
}
