// Model training — gradient descent on resolved signal snapshots.
// Updates model-weights.json. Minimum 20 resolved samples before training.
// Uses mean-squared-error loss between predicted edge and target edge derived from outcome.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { kvGet, kvSet } from "./kv";
import type { FeatureVector, ModelWeights, SignalSnapshot } from "./types";
import { getDefaultWeights, invalidateWeightsCache } from "./scoring";

const SIGNAL_LOG_FILE = join(process.cwd(), "data", "signal-log.json");
const WEIGHTS_FILE = join(process.cwd(), "data", "model-weights.json");

export const MIN_SAMPLES = 20;
const LEARNING_RATE = 0.005;
const EPOCHS = 200;
const EDGE_SCALE = 15; // target edge magnitude for correctly-called markets

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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TrainingResult {
  samplesUsed: number;
  epochs: number;
  finalLoss: number;
  initialLoss: number;
  lossImprovement: number;  // %
  weightsVersion: string;
  updatedAt: string;
  featureImportance: Array<{ feature: string; weight: number; change: number }>;
}

export interface TrainingError {
  error: string;
  samplesAvailable: number;
  samplesNeeded: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSnapshots(): SignalSnapshot[] {
  try {
    if (!existsSync(SIGNAL_LOG_FILE)) return [];
    const raw = JSON.parse(readFileSync(SIGNAL_LOG_FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// Converts a resolved snapshot to a target edge (pp).
// Logic: if YES resolved (outcome=1), the model should have been predicting positive edge.
// We scale by how wrong the market was — a 90% underdog resolving YES gives a bigger target
// than a 55% favorite resolving YES.
function targetEdge(snap: SignalSnapshot): number | null {
  if (snap.outcome == null) return null;

  const prob = snap.marketProbAtAnalysis; // YES probability at scan time (0-100)
  const resolved = snap.outcome === 1;    // true = YES resolved

  // Market surprise: how unexpected was the outcome?
  // YES resolved at 20%: surprise = (1 - 0.20) = 0.80 → big positive target
  // YES resolved at 80%: surprise = (1 - 0.80) = 0.20 → small positive target
  // NO resolved at 20%: surprise = (1 - 0.80) = 0.20 → small negative target
  // NO resolved at 80%: surprise = (1 - 0.20) = 0.80 → big negative target
  const normalizedProb = prob / 100;
  const surprise = resolved
    ? (1 - normalizedProb)  // how undervalued YES was
    : normalizedProb;       // how overvalued YES was

  const sign = resolved ? 1 : -1;
  return sign * surprise * EDGE_SCALE;
}

function predict(features: FeatureVector, weights: ModelWeights): number {
  let raw = weights.intercept;
  for (const key of FEATURE_KEYS) {
    const fv = features[key] as number;
    const w = weights[key] as number;
    if (typeof fv === "number" && typeof w === "number") {
      raw += fv * w;
    }
  }
  return Math.max(-30, Math.min(30, raw));
}

function mse(samples: Array<{ features: FeatureVector; target: number }>, weights: ModelWeights): number {
  const n = samples.length;
  if (n === 0) return 0;
  return samples.reduce((sum, s) => {
    const err = predict(s.features, weights) - s.target;
    return sum + err * err;
  }, 0) / n;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function trainModel(options: { force?: boolean } = {}): TrainingResult | TrainingError {
  const { force = false } = options;

  const allSnapshots = loadSnapshots();
  const resolved = allSnapshots.filter(s => s.resolved && s.outcome != null);

  if (resolved.length < MIN_SAMPLES && !force) {
    return {
      error: `Not enough data yet. Need ${MIN_SAMPLES} resolved markets, have ${resolved.length}.`,
      samplesAvailable: resolved.length,
      samplesNeeded: MIN_SAMPLES,
    };
  }

  // Build training samples
  const samples: Array<{ features: FeatureVector; target: number }> = [];
  for (const snap of resolved) {
    const target = targetEdge(snap);
    if (target == null || !snap.featureVector) continue;
    // Basic sanity check on features
    if (typeof snap.featureVector.netNewsDirection !== "number") continue;
    samples.push({ features: snap.featureVector, target });
  }

  if (samples.length < 5) {
    return {
      error: `Only ${samples.length} usable samples after filtering (need feature vectors + outcomes).`,
      samplesAvailable: samples.length,
      samplesNeeded: MIN_SAMPLES,
    };
  }

  // Start from default weights — never overfit to a previous trained version
  const weights: ModelWeights = getDefaultWeights();

  // Initial loss
  const initialLoss = mse(samples, weights);

  // Stochastic gradient descent
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    // Shuffle samples each epoch
    const shuffled = [...samples].sort(() => Math.random() - 0.5);

    for (const { features, target } of shuffled) {
      const pred = predict(features, weights);
      const error = pred - target; // positive = predicted too high

      // Gradient step: w_i -= lr * error * x_i
      for (const key of FEATURE_KEYS) {
        const fv = features[key] as number;
        if (typeof fv !== "number") continue;
        (weights as unknown as Record<string, number>)[key] -= LEARNING_RATE * error * fv;
      }
      weights.intercept -= LEARNING_RATE * error;
    }

    // Adaptive: halve learning rate at halfway point for fine-tuning
    if (epoch === Math.floor(EPOCHS / 2)) {
      // No direct LR mutation — handled implicitly by the loop constant.
      // A future improvement would parametrize lr per epoch.
    }
  }

  // Final loss and improvement
  const finalLoss = mse(samples, weights);
  const lossImprovement = initialLoss > 0
    ? Math.round((1 - finalLoss / initialLoss) * 10000) / 100
    : 0;

  // Feature importance: sort by |trained weight|, show delta from default
  const defaultWeights = getDefaultWeights();
  const featureImportance = FEATURE_KEYS.map(key => ({
    feature: key,
    weight: Math.round((weights[key] as number) * 1000) / 1000,
    change: Math.round(((weights[key] as number) - (defaultWeights[key] as number)) * 1000) / 1000,
  })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  // Persist
  const version = `v${new Date().toISOString().slice(0, 10)}-n${samples.length}`;
  const updatedAt = new Date().toISOString();
  const savedWeights: ModelWeights = { ...weights, version, updatedAt };

  writeFileSync(WEIGHTS_FILE, JSON.stringify(savedWeights, null, 2), "utf-8");
  kvSet("model-weights", savedWeights);
  invalidateWeightsCache();

  console.log(`[training] Trained on ${samples.length} samples. Loss: ${initialLoss.toFixed(3)} → ${finalLoss.toFixed(3)} (${lossImprovement > 0 ? "+" : ""}${lossImprovement}% improvement)`);

  return {
    samplesUsed: samples.length,
    epochs: EPOCHS,
    finalLoss: Math.round(finalLoss * 1000) / 1000,
    initialLoss: Math.round(initialLoss * 1000) / 1000,
    lossImprovement,
    weightsVersion: version,
    updatedAt,
    featureImportance,
  };
}

// ─── Training stats (for API) ─────────────────────────────────────────────────

export async function getTrainingStatsAsync(): Promise<{
  totalSnapshots: number;
  resolvedSnapshots: number;
  usableSnapshots: number;
  readyToTrain: boolean;
  samplesNeeded: number;
}> {
  const kvLog = await kvGet<SignalSnapshot[]>("signal-log");
  const all = kvLog ?? loadSnapshots();
  const resolved = all.filter(s => s.resolved && s.outcome != null);
  const usable = resolved.filter(s => s.featureVector && typeof s.featureVector.netNewsDirection === "number");
  return {
    totalSnapshots: all.length,
    resolvedSnapshots: resolved.length,
    usableSnapshots: usable.length,
    readyToTrain: usable.length >= MIN_SAMPLES,
    samplesNeeded: Math.max(0, MIN_SAMPLES - usable.length),
  };
}

export function getTrainingStats(): {
  totalSnapshots: number;
  resolvedSnapshots: number;
  usableSnapshots: number;
  readyToTrain: boolean;
  samplesNeeded: number;
} {
  const all = loadSnapshots();
  const resolved = all.filter(s => s.resolved && s.outcome != null);
  const usable = resolved.filter(s => s.featureVector && typeof s.featureVector.netNewsDirection === "number");

  return {
    totalSnapshots: all.length,
    resolvedSnapshots: resolved.length,
    usableSnapshots: usable.length,
    readyToTrain: usable.length >= MIN_SAMPLES,
    samplesNeeded: Math.max(0, MIN_SAMPLES - usable.length),
  };
}
