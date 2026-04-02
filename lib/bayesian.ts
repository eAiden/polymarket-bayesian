// Pure Bayesian math — no imports needed.
// Converts news signals to a likelihood ratio, then updates the prior probability.

import type { NewsSignal } from "./types";

// ─── Likelihood ratio from news signals ───────────────────────────────────────

/**
 * Convert extracted news signals into a single likelihood ratio.
 * YES signals push ratio above 1.0, NO signals push ratio below 1.0.
 * Clamps final ratio to [0.25, 4.0].
 */
export function signalsToLikelihoodRatio(signals: NewsSignal[]): number {
  let ratio = 1.0;

  for (const s of signals) {
    let multiplier: number;
    if (s.direction === "YES") {
      multiplier = s.strength === "strong" ? 1.4 : s.strength === "moderate" ? 1.2 : 1.08;
    } else {
      multiplier = s.strength === "strong" ? 0.6 : s.strength === "moderate" ? 0.8 : 0.92;
    }
    ratio *= multiplier;
  }

  return Math.max(0.25, Math.min(4.0, ratio));
}

// ─── Bayesian update ─────────────────────────────────────────────────────────

/**
 * Update a prior probability using a likelihood ratio (Bayes' theorem in log-odds form).
 * All probabilities are in percentage points (0-100).
 */
export function bayesianUpdate(priorPct: number, likelihoodRatio: number): number {
  // Clamp prior away from 0/100 to avoid log(0)
  const prior = Math.max(0.5, Math.min(99.5, priorPct)) / 100;

  // Convert to log-odds
  const logOddsPrior = Math.log(prior / (1 - prior));

  // Apply likelihood ratio in log-odds space
  const logOddsLR = Math.log(likelihoodRatio);
  const logOddsPosterior = logOddsPrior + logOddsLR;

  // Convert back to probability
  const posteriorProb = 1 / (1 + Math.exp(-logOddsPosterior));

  // Return as percentage, clamped to [1, 99]
  return Math.max(1, Math.min(99, Math.round(posteriorProb * 100 * 10) / 10));
}

// ─── 90% Credible interval ────────────────────────────────────────────────────

/**
 * Compute a 90% credible interval for the posterior probability.
 * Uses a normal approximation on the log-odds scale.
 * More signals = tighter interval.
 * Returns [low, high] in percentage points.
 */
export function credibleInterval(posteriorPct: number, signalCount: number): [number, number] {
  const posterior = Math.max(0.01, Math.min(0.99, posteriorPct / 100));
  const logOdds = Math.log(posterior / (1 - posterior));

  // Uncertainty decreases with more signals; baseline std dev = 1.0 log-odds unit
  const n = Math.max(1, signalCount);
  const stdDev = 1.0 / Math.sqrt(n);

  // 90% CI: z = 1.645
  const z = 1.645;
  const loLow = logOdds - z * stdDev;
  const loHigh = logOdds + z * stdDev;

  const toLow = Math.max(1, Math.round((1 / (1 + Math.exp(-loLow))) * 100));
  const toHigh = Math.min(99, Math.round((1 / (1 + Math.exp(-loHigh))) * 100));

  return [toLow, toHigh];
}
