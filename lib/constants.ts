// Shared threshold constants used across pipeline.ts and resolution.ts.
// Centralised so changing a band (e.g. during model tuning) touches one file.

// ─── Resolution thresholds ────────────────────────────────────────────────────
/** YES market price (%) at or above which a market is considered formally resolved YES */
export const RESOLUTION_YES_PCT = 98;
/** YES market price (%) at or below which a market is considered formally resolved NO */
export const RESOLUTION_NO_PCT = 2;

// ─── Near-resolution take-profit thresholds ───────────────────────────────────
/** Take profit on a YES trade when market reaches this probability — 6pp below formal resolution */
export const NEAR_RESOLUTION_LONG_PCT = 92;
/** Take profit on a NO trade when YES probability drops to this level — 6pp above formal NO resolution */
export const NEAR_RESOLUTION_SHORT_PCT = 8;

// ─── Edge thresholds ─────────────────────────────────────────────────────────
/** Minimum |edge| in pp to hold an open position; below this = edge decay exit */
export const EDGE_DECAY_THRESHOLD_PP = 2;
/** Minimum |edge| in pp to open a new paper trade */
export const EDGE_OPEN_THRESHOLD_PP = 5;
/** Minimum |edge| in pp to keep a stale-thesis position alive past STALE_THESIS_DAYS */
export const STALE_THESIS_EDGE_PP = 5;

// ─── Time-based stop ─────────────────────────────────────────────────────────
/** Days a position can remain open before triggering the stale-thesis stop (when edge < STALE_THESIS_EDGE_PP) */
export const STALE_THESIS_DAYS = 45;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps absolute edge in pp to a confidence tier.
 * Used in both pipeline.ts and db.ts — single definition avoids drift.
 */
export function edgeToConfidence(absEdge: number): "high" | "medium" | "low" {
  return absEdge >= 10 ? "high" : absEdge >= EDGE_OPEN_THRESHOLD_PP ? "medium" : "low";
}
