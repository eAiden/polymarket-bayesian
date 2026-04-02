// Weighted linear scoring model — produces edge estimates in pp, not probabilities.
// Weights are hardcoded defaults; model training via DB calibration data is a future step.

import type { FeatureVector, ModelWeights, ScoringResult } from "./types";

// ─── Default weights (hand-tuned starting point) ────────────────────────────
// These are multiplied by their corresponding feature value to produce pp contribution.

const DEFAULT_WEIGHTS: ModelWeights = {
  netNewsDirection: 8.0,        // strong news shifts edge ~8pp
  strongSignalCount: 2.0,       // each strong signal adds 2pp
  breakingNewsPresent: 5.0,     // breaking news = 5pp potential edge
  newsAge: 3.0,                 // fresher = more edge (market hasn't absorbed)
  informationCompleteness: 2.0,  // HIGH completeness increases confidence in edge signal
  resolutionAmbiguity: -4.0,    // HIGH ambiguity reduces edge signal
  buySellImbalance: 4.0,        // order flow predicts short-term
  volumeSpike: 2.0,             // volume spikes precede moves
  spreadPct: -1.0,              // wide spread = noisy price, reduce edge
  liquidityRatio: 1.5,          // bid-heavy = bullish pressure
  priceMomentum3d: 0.3,         // momentum continuation
  priceMomentum7d: 0.15,        // longer momentum (weaker signal)
  crossMarketSpread: 0.5,       // disagreement = opportunity
  polymarketVsConsensus: -0.4,  // if Polymarket is outlier, bet toward consensus (negative)
  daysToResolution: 0,          // not directly weighted (urgency captures this)
  urgency: 2.0,                 // closer to resolution = faster edge decay
  categoryBias: -0.5,           // correct for historical bias
  intercept: 0,
  version: "v1.0-default",
  updatedAt: new Date().toISOString(),
};

// ─── Load weights ───────────────────────────────────────────────────────────

let cachedWeights: ModelWeights | null = null;

export function loadWeights(): ModelWeights {
  if (cachedWeights) return cachedWeights;
  cachedWeights = { ...DEFAULT_WEIGHTS };
  return cachedWeights;
}

export function getDefaultWeights(): ModelWeights {
  return { ...DEFAULT_WEIGHTS };
}

// Check if model has been trained or is still using default weights
export function isModelTrained(): { trained: boolean; version: string; updatedAt: string } {
  const w = loadWeights();
  return {
    trained: w.version !== "v1.0-default",
    version: w.version,
    updatedAt: w.updatedAt,
  };
}

// Invalidate cache (after training updates weights)
export function invalidateWeightsCache(): void {
  cachedWeights = null;
}

// ─── Feature weight keys (excludes metadata fields) ─────────────────────────

const FEATURE_KEYS: (keyof FeatureVector & keyof ModelWeights)[] = [
  "netNewsDirection",
  "strongSignalCount",
  "breakingNewsPresent",
  "newsAge",
  "informationCompleteness",
  "resolutionAmbiguity",
  "buySellImbalance",
  "volumeSpike",
  "spreadPct",
  "liquidityRatio",
  "priceMomentum3d",
  "priceMomentum7d",
  "crossMarketSpread",
  "polymarketVsConsensus",
  "daysToResolution",
  "urgency",
  "categoryBias",
];

// ─── Score a market ─────────────────────────────────────────────────────────

export function scoreMarket(features: FeatureVector, weights?: ModelWeights): ScoringResult {
  const w = weights ?? loadWeights();
  let rawEdge = w.intercept;
  const contributions: Array<{ feature: string; contribution: number }> = [];

  for (const key of FEATURE_KEYS) {
    const featureVal = features[key] as number;
    const weight = w[key] as number;
    if (typeof featureVal !== "number" || typeof weight !== "number") continue;

    const contrib = featureVal * weight;
    rawEdge += contrib;
    contributions.push({ feature: key, contribution: Math.round(contrib * 100) / 100 });
  }

  // Clamp to reasonable range
  const edge = Math.max(-30, Math.min(30, Math.round(rawEdge * 10) / 10));

  // Confidence from signal agreement + edge magnitude
  const absEdge = Math.abs(edge);
  const confidence: ScoringResult["confidence"] =
    absEdge > 12 ? "high" : absEdge > 6 ? "medium" : "low";

  // Direction: YES if edge > 3, NO if < -3, HOLD otherwise
  const direction: ScoringResult["direction"] =
    edge > 3 ? "YES" : edge < -3 ? "NO" : "HOLD";

  // Top 5 contributors by absolute value
  const topContributors = contributions
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 5);

  return { rawEdge: Math.round(rawEdge * 100) / 100, edge, confidence, direction, topContributors };
}
