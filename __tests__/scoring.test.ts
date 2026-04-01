// Tests for scoreMarket() — the weighted linear scoring model.
// Covers edge clamping, direction/confidence thresholds, contributor sorting, and math.

import { describe, it, expect } from "vitest";
import { scoreMarket, getDefaultWeights } from "@/lib/scoring";
import type { FeatureVector, ModelWeights } from "@/lib/types";

// ─── Minimal fixture ─────────────────────────────────────────────────────────

function zeroFeatures(): FeatureVector {
  return {
    netNewsDirection: 0,
    strongSignalCount: 0,
    breakingNewsPresent: 0,
    newsAge: 0,
    informationCompleteness: 0,
    resolutionAmbiguity: 0,
    buySellImbalance: 0,
    volumeSpike: 0,
    spreadPct: 0,
    liquidityRatio: 0,
    priceMomentum3d: 0,
    priceMomentum7d: 0,
    crossMarketSpread: 0,
    polymarketVsConsensus: 0,
    daysToResolution: 0,
    urgency: 0,
    categoryBias: 0,
    timestamp: new Date().toISOString(),
    marketProbAtExtraction: 50,
  };
}

function unitWeights(): ModelWeights {
  return {
    netNewsDirection: 1,
    strongSignalCount: 1,
    breakingNewsPresent: 1,
    newsAge: 1,
    informationCompleteness: 1,
    resolutionAmbiguity: 1,
    buySellImbalance: 1,
    volumeSpike: 1,
    spreadPct: 1,
    liquidityRatio: 1,
    priceMomentum3d: 1,
    priceMomentum7d: 1,
    crossMarketSpread: 1,
    polymarketVsConsensus: 1,
    daysToResolution: 1,
    urgency: 1,
    categoryBias: 1,
    intercept: 0,
    version: "test-unit",
    updatedAt: new Date().toISOString(),
  };
}

// ─── Edge calculation ─────────────────────────────────────────────────────────

describe("edge calculation", () => {
  it("all-zero features with zero intercept → edge 0", () => {
    const result = scoreMarket(zeroFeatures(), unitWeights());
    expect(result.edge).toBe(0);
    expect(result.rawEdge).toBe(0);
  });

  it("intercept flows through to raw edge", () => {
    const w = { ...unitWeights(), intercept: 5 };
    const result = scoreMarket(zeroFeatures(), w);
    expect(result.rawEdge).toBe(5);
    expect(result.edge).toBe(5);
  });

  it("single feature contribution: feature=2, weight=3 → rawEdge=6", () => {
    const f = { ...zeroFeatures(), netNewsDirection: 2 };
    const w = { ...unitWeights(), netNewsDirection: 3, intercept: 0 };
    const result = scoreMarket(f, w);
    expect(result.rawEdge).toBe(6);
  });

  it("edge is clamped to +30 maximum", () => {
    // Set features so weighted sum >> 30
    const f = { ...zeroFeatures(), netNewsDirection: 1 };
    const w = { ...unitWeights(), netNewsDirection: 100, intercept: 0 };
    const result = scoreMarket(f, w);
    expect(result.edge).toBe(30);
    expect(result.rawEdge).toBe(100); // rawEdge is NOT clamped
  });

  it("edge is clamped to -30 minimum", () => {
    const f = { ...zeroFeatures(), netNewsDirection: -1 };
    const w = { ...unitWeights(), netNewsDirection: 100, intercept: 0 };
    const result = scoreMarket(f, w);
    expect(result.edge).toBe(-30);
  });

  it("edge is rounded to 1 decimal place", () => {
    const f = { ...zeroFeatures(), netNewsDirection: 1 };
    const w = { ...unitWeights(), netNewsDirection: 7.777, intercept: 0 };
    const result = scoreMarket(f, w);
    expect(result.edge).toBe(7.8);
  });
});

// ─── Direction thresholds ─────────────────────────────────────────────────────

describe("direction", () => {
  it("edge > 3 → YES", () => {
    const w = { ...unitWeights(), intercept: 10 };
    expect(scoreMarket(zeroFeatures(), w).direction).toBe("YES");
  });

  it("edge < -3 → NO", () => {
    const w = { ...unitWeights(), intercept: -10 };
    expect(scoreMarket(zeroFeatures(), w).direction).toBe("NO");
  });

  it("edge between -3 and +3 → HOLD", () => {
    const w = { ...unitWeights(), intercept: 2 };
    expect(scoreMarket(zeroFeatures(), w).direction).toBe("HOLD");
    const w2 = { ...unitWeights(), intercept: -2 };
    expect(scoreMarket(zeroFeatures(), w2).direction).toBe("HOLD");
  });

  it("edge exactly 3 → HOLD (boundary: > 3 required for YES)", () => {
    const w = { ...unitWeights(), intercept: 3 };
    expect(scoreMarket(zeroFeatures(), w).direction).toBe("HOLD");
  });

  it("edge exactly -3 → HOLD (boundary: < -3 required for NO)", () => {
    const w = { ...unitWeights(), intercept: -3 };
    expect(scoreMarket(zeroFeatures(), w).direction).toBe("HOLD");
  });
});

// ─── Confidence thresholds ────────────────────────────────────────────────────

describe("confidence", () => {
  it("|edge| > 12 → high confidence", () => {
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 15 }).confidence).toBe("high");
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: -15 }).confidence).toBe("high");
  });

  it("|edge| > 6 and <= 12 → medium confidence", () => {
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 8 }).confidence).toBe("medium");
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: -9 }).confidence).toBe("medium");
  });

  it("|edge| <= 6 → low confidence", () => {
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 4 }).confidence).toBe("low");
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 0 }).confidence).toBe("low");
  });

  it("boundary: edge=12 → medium (> 12 required for high)", () => {
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 12 }).confidence).toBe("medium");
  });

  it("boundary: edge=6 → low (> 6 required for medium)", () => {
    expect(scoreMarket(zeroFeatures(), { ...unitWeights(), intercept: 6 }).confidence).toBe("low");
  });
});

// ─── Top contributors ─────────────────────────────────────────────────────────

describe("topContributors", () => {
  it("returns at most 5 contributors", () => {
    const f = { ...zeroFeatures(), netNewsDirection: 1, strongSignalCount: 1, newsAge: 1, urgency: 1, breakingNewsPresent: 1, categoryBias: 1 };
    const result = scoreMarket(f, unitWeights());
    expect(result.topContributors.length).toBeLessThanOrEqual(5);
  });

  it("sorted by absolute contribution, largest first", () => {
    const f = { ...zeroFeatures(), netNewsDirection: 1, priceMomentum3d: 1 };
    const w = { ...unitWeights(), netNewsDirection: 10, priceMomentum3d: 2 };
    const result = scoreMarket(f, w);
    const contribs = result.topContributors.map(c => Math.abs(c.contribution));
    for (let i = 0; i < contribs.length - 1; i++) {
      expect(contribs[i]).toBeGreaterThanOrEqual(contribs[i + 1]);
    }
  });

  it("contributions are rounded to 2 decimal places", () => {
    const f = { ...zeroFeatures(), netNewsDirection: 1 };
    const w = { ...unitWeights(), netNewsDirection: 3.14159 };
    const result = scoreMarket(f, w);
    const top = result.topContributors.find(c => c.feature === "netNewsDirection");
    expect(top).toBeDefined();
    expect(top!.contribution).toBe(3.14); // rounded to 2dp
  });

  it("negative contributions are included", () => {
    const f = { ...zeroFeatures(), categoryBias: 1 };
    const w = { ...unitWeights(), categoryBias: -5 };
    const result = scoreMarket(f, w);
    const bias = result.topContributors.find(c => c.feature === "categoryBias");
    expect(bias).toBeDefined();
    expect(bias!.contribution).toBeLessThan(0);
  });
});

// ─── Default weights ──────────────────────────────────────────────────────────

describe("default weights", () => {
  it("getDefaultWeights returns an object with version v1.0-default", () => {
    const w = getDefaultWeights();
    expect(w.version).toBe("v1.0-default");
  });

  it("default weights have all required feature keys", () => {
    const w = getDefaultWeights();
    const required = [
      "netNewsDirection", "strongSignalCount", "breakingNewsPresent", "newsAge",
      "informationCompleteness", "resolutionAmbiguity", "buySellImbalance",
      "volumeSpike", "spreadPct", "liquidityRatio", "priceMomentum3d",
      "priceMomentum7d", "crossMarketSpread", "polymarketVsConsensus",
      "daysToResolution", "urgency", "categoryBias", "intercept",
    ];
    for (const key of required) {
      expect(w).toHaveProperty(key);
      expect(typeof (w as Record<string, unknown>)[key]).toBe("number");
    }
  });

  it("scoreMarket uses default weights when none provided (no crash)", () => {
    // This just verifies it doesn't throw; actual weights from disk vary by environment
    expect(() => scoreMarket(zeroFeatures())).not.toThrow();
  });
});
