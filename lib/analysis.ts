// Analysis pipeline v2: Signal extraction + scoring model.
// Claude extracts structured facts → features → weighted score → edge.
// Claude NEVER estimates probabilities.

import type { FilteredMarket, AnalyzedMarket, ScanError, MarketEnrichment, DailySnapshot } from "./types";
import { extractSignals, type ExtractionResult } from "./signal-extraction";
import { computeFeatures } from "./features";
import { scoreMarket, loadWeights } from "./scoring";
import { loadCalibrationRecords, computeCategoryBias } from "./calibration";
import { appendSignalSnapshot } from "./signal-log";

// ─── Convert signal-based result to AnalyzedMarket (backward compat) ────────
// The UI still expects AnalyzedMarket shape. We map edge score into it,
// keeping fairProb as "marketProb + edge" for display purposes.

function buildResultFromScore(
  extraction: ExtractionResult,
  edge: number,
  confidence: "high" | "medium" | "low",
  direction: "YES" | "NO" | "HOLD",
  topContributors: Array<{ feature: string; contribution: number }>,
  triggerType: "full_scan" | "news_triggered" | "manual" = "full_scan",
): AnalyzedMarket | null {
  const { market, signal } = extraction;

  // Only report markets with meaningful edge
  if (Math.abs(edge) < 3 && direction === "HOLD") return null;

  // Compute a "fair prob" from edge for UI backward compat
  const fairProb = Math.max(1, Math.min(99, Math.round(market.yesProbPct + edge)));

  const edgeLevel: AnalyzedMarket["edgeLevel"] =
    Math.abs(edge) > 15 ? "high" : Math.abs(edge) > 8 ? "medium" : "low";

  const mappedDirection: AnalyzedMarket["direction"] =
    direction === "HOLD" ? (edge >= 0 ? "YES" : "NO") : direction;

  // Build key factors from top contributors and news signals
  const bullish: string[] = [];
  const bearish: string[] = [];

  for (const s of signal.newsSignals) {
    if (s.strength === "weak") continue;
    const text = `[${s.recency}] ${s.fact}`;
    if (s.direction === "YES" && bullish.length < 2) bullish.push(text);
    if (s.direction === "NO" && bearish.length < 2) bearish.push(text);
  }

  // Build reasoning from top contributors
  const contribText = topContributors
    .map(c => `${c.feature}: ${c.contribution > 0 ? "+" : ""}${c.contribution}pp`)
    .join(", ");
  const reasoning = `Signal-based edge: ${edge > 0 ? "+" : ""}${edge}pp. Top drivers: ${contribText}. ` +
    `News: ${signal.newsSignals.length} signals (${signal.newsAge}), completeness: ${signal.informationCompleteness}. ` +
    `Resolution risk: ${signal.resolution.ambiguityRisk}` +
    (signal.resolution.resolutionNote ? `. Note: ${signal.resolution.resolutionNote}` : "");

  // Sources from news signals
  const sources = [...new Set(signal.newsSignals.map(s => s.source))].slice(0, 4);

  // Top fact: strongest signal aligned with direction, else first signal
  const topFact =
    signal.newsSignals.find(s => s.direction === mappedDirection && s.strength === "strong")?.fact ??
    signal.newsSignals.find(s => s.direction === mappedDirection)?.fact ??
    signal.newsSignals[0]?.fact;

  return {
    id: market.id,
    title: market.question.slice(0, 200),
    url: market.url,
    category: market.category,
    marketProb: market.yesProbPct,
    fairProb,
    edge: Math.round(edge * 10) / 10,
    edgeLevel,
    direction: mappedDirection,
    confidence,
    keyFactors: { bullish, bearish },
    volume: market.volume,
    endDate: market.endDate,
    endDateIso: market.endDateIso,
    daysUntilResolution: market.daysUntilResolution,
    reasoning: reasoning.slice(0, 600),
    sources,
    topFact,
    newsAge: signal.newsAge,
    topContributors: topContributors.slice(0, 3),
    lastTriggerType: triggerType,
  };
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function analyzeMarkets(
  markets: FilteredMarket[],
  onProgress?: (current: number, market: string) => void,
  errors?: ScanError[],
  existingMarkets?: Map<string, DailySnapshot[]>,
  triggerType: "full_scan" | "news_triggered" | "manual" = "full_scan",
): Promise<AnalyzedMarket[]> {
  if (markets.length === 0) return [];
  const scanErrors = errors ?? [];
  const CONCURRENCY = 3;
  let completed = 0;

  // Load calibration bias per category
  const calibRecords = loadCalibrationRecords();
  const categoryBiasMap = new Map<string, MarketEnrichment["calibrationBias"]>();
  for (const cat of ["Crypto", "Politics", "Sports", "Economics", "Science", "Other"]) {
    const bias = computeCategoryBias(calibRecords, cat);
    if (bias) {
      categoryBiasMap.set(cat, bias);
      console.log(`[calibration] ${cat} bias: ${bias.avgEdgeBias > 0 ? "+" : ""}${bias.avgEdgeBias}pp (n=${bias.sampleSize})`);
    }
  }

  const weights = loadWeights();
  console.log(`[analysis] Using model weights: ${weights.version}`);

  // ─── Signal extraction + scoring (1 Claude call per market) ───────────────
  console.log(`[analysis] Extracting signals from ${markets.length} markets (1 call each)...`);

  const results: AnalyzedMarket[] = [];

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(m => {
      const history = existingMarkets?.get(m.id);
      return extractSignals(m, scanErrors, history, categoryBiasMap);
    }));

    for (let j = 0; j < settled.length; j++) {
      completed++;
      const r = settled[j];

      if (r.status === "fulfilled" && r.value !== null) {
        const extraction = r.value;
        const { market, signal, crossMatches, enrichment } = extraction;

        // Compute features
        const catBias = categoryBiasMap.get(market.category)?.avgEdgeBias ?? 0;
        const features = computeFeatures(signal, market.yesProbPct, enrichment, crossMatches, catBias);

        // Score
        const score = scoreMarket(features, weights);
        console.log(`[score] ${market.question.slice(0, 40)}: edge=${score.edge > 0 ? "+" : ""}${score.edge}pp dir=${score.direction} conf=${score.confidence}`);

        // Ablation baseline score: newsAge × max(0, 1 - daysToResolution/30) × min(1, volumeSpike/3)
        // Direction is borrowed from full model (we're ablating features, not direction)
        const baselineScore = features.newsAge
          * Math.max(0, 1 - features.daysToResolution / 30)
          * Math.min(1, features.volumeSpike / 3);

        // Log signal snapshot for training / ablation comparison
        try {
          appendSignalSnapshot(
            market.id,
            market.yesProbPct,
            triggerType,
            signal,
            features,
            score,
            weights.version,
            baselineScore,
          );
        } catch (err) {
          console.warn(`[analysis] Failed to log snapshot for ${market.id}:`, (err as Error).message);
        }

        // Convert to AnalyzedMarket for UI compatibility
        const result = buildResultFromScore(extraction, score.edge, score.confidence, score.direction, score.topContributors, triggerType);
        if (result) results.push(result);
      } else if (r.status === "rejected") {
        console.warn(`[extract] ✗ ${batch[j].question.slice(0, 50)}: ${r.reason}`);
      }

      onProgress?.(completed, batch[j].question);
    }

    if (i + CONCURRENCY < markets.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[analysis] Done: ${results.length} markets with edge, ${markets.length - results.length} filtered (HOLD or low edge)`);
  return results;
}
