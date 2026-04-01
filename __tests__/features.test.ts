// Tests for computeFeatures() — the pure feature engineering function.
// Covers all 17 feature fields plus edge cases (missing enrichment, caps, maps).

import { describe, it, expect } from "vitest";
import { computeFeatures } from "@/lib/features";
import type { ExtractedSignal, MarketEnrichment } from "@/lib/types";
import type { CrossMarketMatch } from "@/lib/crossmarket";

// ─── Minimal fixture builders ────────────────────────────────────────────────

function makeSignal(overrides: Partial<ExtractedSignal> = {}): ExtractedSignal {
  return {
    newsSignals: [],
    resolution: { ambiguityRisk: "low", daysLeft: 14, resolutionNote: "" },
    crossMarketDisagreement: 0,
    newsAge: "recent",
    informationCompleteness: "medium",
    domainSignals: { keyMetric: "", trendDirection: "neutral", volatilityAssessment: "low" },
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<MarketEnrichment> = {}): MarketEnrichment {
  return {
    orderBook: null,
    trades: null,
    fred: null,
    crypto: null,
    priceHistory: [],
    calibrationBias: null,
    ...overrides,
  };
}

const noCrossMatches: CrossMarketMatch[] = [];

// ─── netNewsDirection ────────────────────────────────────────────────────────

describe("netNewsDirection", () => {
  it("all YES strong signals → +1", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "strong", recency: "today", source: "s" },
        { fact: "b", direction: "YES", strength: "strong", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.netNewsDirection).toBe(1);
  });

  it("all NO signals → -1", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "NO", strength: "strong", recency: "today", source: "s" },
        { fact: "b", direction: "NO", strength: "moderate", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.netNewsDirection).toBe(-1);
  });

  it("equal YES and NO weight → 0", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "strong", recency: "today", source: "s" },
        { fact: "b", direction: "NO", strength: "strong", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.netNewsDirection).toBe(0);
  });

  it("no signals → 0 (no division by zero)", () => {
    const fv = computeFeatures(makeSignal({ newsSignals: [] }), 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.netNewsDirection).toBe(0);
    expect(Number.isNaN(fv.netNewsDirection)).toBe(false);
  });

  it("mixed weights: strong YES (1.0) vs two weak NO (0.2 each)", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "strong", recency: "today", source: "s" },
        { fact: "b", direction: "NO", strength: "weak", recency: "today", source: "s" },
        { fact: "c", direction: "NO", strength: "weak", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    // yesWeight=1.0, noWeight=0.4, total=1.4 → (1.0-0.4)/1.4 ≈ 0.4286
    expect(fv.netNewsDirection).toBeCloseTo(0.4286, 3);
  });
});

// ─── newsAge + informationCompleteness + resolutionAmbiguity ────────────────

describe("categorical mappings", () => {
  it("newsAge: breaking=1, recent=0.5, stale=0", () => {
    expect(computeFeatures(makeSignal({ newsAge: "breaking" }), 50, makeEnrichment(), noCrossMatches, 0).newsAge).toBe(1.0);
    expect(computeFeatures(makeSignal({ newsAge: "recent" }), 50, makeEnrichment(), noCrossMatches, 0).newsAge).toBe(0.5);
    expect(computeFeatures(makeSignal({ newsAge: "stale" }), 50, makeEnrichment(), noCrossMatches, 0).newsAge).toBe(0);
  });

  it("informationCompleteness: high=1, medium=0.5, low=0", () => {
    expect(computeFeatures(makeSignal({ informationCompleteness: "high" }), 50, makeEnrichment(), noCrossMatches, 0).informationCompleteness).toBe(1.0);
    expect(computeFeatures(makeSignal({ informationCompleteness: "medium" }), 50, makeEnrichment(), noCrossMatches, 0).informationCompleteness).toBe(0.5);
    expect(computeFeatures(makeSignal({ informationCompleteness: "low" }), 50, makeEnrichment(), noCrossMatches, 0).informationCompleteness).toBe(0);
  });

  it("resolutionAmbiguity: high=1, medium=0.5, low=0", () => {
    const hi = makeSignal({ resolution: { ambiguityRisk: "high", daysLeft: 7, resolutionNote: "" } });
    const lo = makeSignal({ resolution: { ambiguityRisk: "low", daysLeft: 7, resolutionNote: "" } });
    expect(computeFeatures(hi, 50, makeEnrichment(), noCrossMatches, 0).resolutionAmbiguity).toBe(1.0);
    expect(computeFeatures(lo, 50, makeEnrichment(), noCrossMatches, 0).resolutionAmbiguity).toBe(0);
  });
});

// ─── strongSignalCount + breakingNewsPresent ─────────────────────────────────

describe("signal counting", () => {
  it("counts strong signals regardless of direction", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "strong", recency: "today", source: "s" },
        { fact: "b", direction: "NO", strength: "strong", recency: "today", source: "s" },
        { fact: "c", direction: "YES", strength: "moderate", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.strongSignalCount).toBe(2);
  });

  it("breakingNewsPresent: 1 when any signal has recency=breaking", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "weak", recency: "breaking", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.breakingNewsPresent).toBe(1);
  });

  it("breakingNewsPresent: 0 when no breaking signals", () => {
    const signal = makeSignal({
      newsSignals: [
        { fact: "a", direction: "YES", strength: "strong", recency: "today", source: "s" },
      ],
    });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.breakingNewsPresent).toBe(0);
  });
});

// ─── volumeSpike cap ─────────────────────────────────────────────────────────

describe("volumeSpike cap", () => {
  it("is capped at 3", () => {
    const enrichment = makeEnrichment({
      trades: {
        totalTrades: 10000, // 10000/50 = 200, should cap at 3
        largeTrades: 10,
        buyVolume: 5000,
        sellVolume: 5000,
        buySellRatio: 1.0,
        avgTradeSize: 100,
        recentTrend: "balanced",
      },
    });
    const fv = computeFeatures(makeSignal(), 50, enrichment, noCrossMatches, 0);
    expect(fv.volumeSpike).toBe(3);
    expect(fv.volumeSpike).toBeLessThanOrEqual(3);
  });

  it("is 0 when no trade data", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment({ trades: null }), noCrossMatches, 0);
    expect(fv.volumeSpike).toBe(0);
  });
});

// ─── liquidityRatio cap ──────────────────────────────────────────────────────

describe("liquidityRatio", () => {
  it("is clamped to minimum 0.1", () => {
    const enrichment = makeEnrichment({
      orderBook: { bidDepth: 0, askDepth: 1000, spread: 2, midpoint: 50 },
    });
    const fv = computeFeatures(makeSignal(), 50, enrichment, noCrossMatches, 0);
    expect(fv.liquidityRatio).toBeGreaterThanOrEqual(0.1);
  });

  it("is clamped to maximum 10", () => {
    const enrichment = makeEnrichment({
      orderBook: { bidDepth: 100000, askDepth: 1, spread: 2, midpoint: 50 },
    });
    const fv = computeFeatures(makeSignal(), 50, enrichment, noCrossMatches, 0);
    expect(fv.liquidityRatio).toBeLessThanOrEqual(10);
  });

  it("defaults to 1 with no orderBook", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.liquidityRatio).toBe(1);
  });
});

// ─── urgency ─────────────────────────────────────────────────────────────────

describe("urgency", () => {
  it("urgency = 1/sqrt(daysLeft) for normal case", () => {
    const signal = makeSignal({ resolution: { ambiguityRisk: "low", daysLeft: 25, resolutionNote: "" } });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.urgency).toBeCloseTo(1 / Math.sqrt(25), 5); // = 0.2
  });

  it("urgency is capped at 2 when daysLeft=0", () => {
    const signal = makeSignal({ resolution: { ambiguityRisk: "low", daysLeft: 0, resolutionNote: "" } });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.urgency).toBe(2);
  });

  it("daysToResolution is passed through unchanged", () => {
    const signal = makeSignal({ resolution: { ambiguityRisk: "low", daysLeft: 42, resolutionNote: "" } });
    const fv = computeFeatures(signal, 50, makeEnrichment(), noCrossMatches, 0);
    expect(fv.daysToResolution).toBe(42);
  });
});

// ─── crossMarketSpread + polymarketVsConsensus ───────────────────────────────

describe("cross-market features", () => {
  it("crossMarketSpread is 0 with no cross matches", () => {
    const fv = computeFeatures(makeSignal(), 60, makeEnrichment(), [], 0);
    expect(fv.crossMarketSpread).toBe(0);
  });

  it("crossMarketSpread = max - min across all prices", () => {
    const cross: CrossMarketMatch[] = [
      { marketId: "x", question: "q", probability: 40, similarity: 0.8, platform: "kalshi" },
      { marketId: "y", question: "q", probability: 70, similarity: 0.9, platform: "metaculus" },
    ];
    const fv = computeFeatures(makeSignal(), 55, makeEnrichment(), cross, 0);
    // prices: [55, 40, 70] → spread = 70 - 40 = 30
    expect(fv.crossMarketSpread).toBe(30);
  });

  it("polymarketVsConsensus is 0 with no cross matches (Polymarket IS consensus)", () => {
    const fv = computeFeatures(makeSignal(), 60, makeEnrichment(), [], 0);
    expect(fv.polymarketVsConsensus).toBe(0);
  });
});

// ─── categoryBias passthrough ────────────────────────────────────────────────

describe("categoryBias", () => {
  it("is passed through unchanged", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment(), noCrossMatches, 3.7);
    expect(fv.categoryBias).toBe(3.7);
  });

  it("negative bias passes through", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment(), noCrossMatches, -1.5);
    expect(fv.categoryBias).toBe(-1.5);
  });
});

// ─── All 17 fields populated ─────────────────────────────────────────────────

describe("completeness", () => {
  it("produces all required FeatureVector fields", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment(), noCrossMatches, 0);
    const required = [
      "netNewsDirection", "strongSignalCount", "breakingNewsPresent", "newsAge",
      "informationCompleteness", "resolutionAmbiguity", "buySellImbalance",
      "volumeSpike", "spreadPct", "liquidityRatio", "priceMomentum3d",
      "priceMomentum7d", "crossMarketSpread", "polymarketVsConsensus",
      "daysToResolution", "urgency", "categoryBias",
      "timestamp", "marketProbAtExtraction",
    ];
    for (const field of required) {
      expect(fv).toHaveProperty(field);
      if (field !== "timestamp") {
        expect(typeof (fv as Record<string, unknown>)[field]).toBe("number");
      }
    }
  });

  it("no NaN in any numeric field", () => {
    const fv = computeFeatures(makeSignal(), 50, makeEnrichment(), noCrossMatches, 0);
    const numericFields = Object.entries(fv)
      .filter(([k]) => k !== "timestamp")
      .map(([, v]) => v as number);
    for (const v of numericFields) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });
});
