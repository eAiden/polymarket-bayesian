import { describe, it, expect } from "vitest";
import { signalsToLikelihoodRatio, bayesianUpdate, credibleInterval } from "@/lib/bayesian";
import type { NewsSignal } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sig(direction: "YES" | "NO", strength: "strong" | "moderate" | "weak"): NewsSignal {
  return {
    fact: "test fact",
    direction,
    strength,
    recency: "today",
    source: "test",
  };
}

// ─── signalsToLikelihoodRatio ─────────────────────────────────────────────────

describe("signalsToLikelihoodRatio", () => {
  it("returns 1.0 for empty signal array (no information)", () => {
    expect(signalsToLikelihoodRatio([])).toBe(1.0);
  });

  it("single strong YES → 1.4", () => {
    expect(signalsToLikelihoodRatio([sig("YES", "strong")])).toBe(1.4);
  });

  it("single moderate YES → 1.2", () => {
    expect(signalsToLikelihoodRatio([sig("YES", "moderate")])).toBe(1.2);
  });

  it("single weak YES → 1.08", () => {
    expect(signalsToLikelihoodRatio([sig("YES", "weak")])).toBeCloseTo(1.08);
  });

  it("single strong NO → 0.6", () => {
    expect(signalsToLikelihoodRatio([sig("NO", "strong")])).toBe(0.6);
  });

  it("single moderate NO → 0.8", () => {
    expect(signalsToLikelihoodRatio([sig("NO", "moderate")])).toBe(0.8);
  });

  it("single weak NO → 0.92", () => {
    expect(signalsToLikelihoodRatio([sig("NO", "weak")])).toBeCloseTo(0.92);
  });

  it("strong YES and strong NO partially cancel (1.4 × 0.6 = 0.84)", () => {
    const ratio = signalsToLikelihoodRatio([sig("YES", "strong"), sig("NO", "strong")]);
    expect(ratio).toBeCloseTo(0.84);
  });

  it("compound YES signals are clamped at 4.0 upper bound", () => {
    // 1.4^8 ≈ 14.8 → clamps to 4.0
    const signals = Array(8).fill(sig("YES", "strong"));
    expect(signalsToLikelihoodRatio(signals)).toBe(4.0);
  });

  it("compound NO signals are clamped at 0.25 lower bound", () => {
    // 0.6^8 ≈ 0.017 → clamps to 0.25
    const signals = Array(8).fill(sig("NO", "strong"));
    expect(signalsToLikelihoodRatio(signals)).toBe(0.25);
  });

  it("two moderate YES signals compound correctly (1.2 × 1.2 = 1.44, within bounds)", () => {
    const ratio = signalsToLikelihoodRatio([sig("YES", "moderate"), sig("YES", "moderate")]);
    expect(ratio).toBeCloseTo(1.44);
  });
});

// ─── bayesianUpdate ───────────────────────────────────────────────────────────

describe("bayesianUpdate", () => {
  it("neutral LR (1.0) leaves prior unchanged", () => {
    expect(bayesianUpdate(50, 1.0)).toBe(50);
    expect(bayesianUpdate(30, 1.0)).toBe(30);
    expect(bayesianUpdate(70, 1.0)).toBe(70);
  });

  it("prior=50, strong YES LR (1.4) → posterior above 50", () => {
    const posterior = bayesianUpdate(50, 1.4);
    expect(posterior).toBeGreaterThan(50);
    expect(posterior).toBeLessThan(70);
  });

  it("prior=50, strong NO LR (0.6) → posterior below 50", () => {
    const posterior = bayesianUpdate(50, 0.6);
    expect(posterior).toBeLessThan(50);
    expect(posterior).toBeGreaterThan(30);
  });

  it("prior=20, strong YES LR → moves market-underdog toward 50", () => {
    const posterior = bayesianUpdate(20, 1.4);
    expect(posterior).toBeGreaterThan(20);
    expect(posterior).toBeLessThan(50);
  });

  it("prior=80, strong NO LR → moves heavy favourite down", () => {
    const posterior = bayesianUpdate(80, 0.6);
    expect(posterior).toBeLessThan(80);
    expect(posterior).toBeGreaterThan(50);
  });

  it("result is clamped to minimum 1", () => {
    // Prior near 0, strong NO → should not go below 1
    expect(bayesianUpdate(1, 0.25)).toBeGreaterThanOrEqual(1);
  });

  it("result is clamped to maximum 99", () => {
    // Prior near 100, strong YES → should not go above 99
    expect(bayesianUpdate(99, 4.0)).toBeLessThanOrEqual(99);
  });

  it("extreme prior (0.1) is clamped before log to avoid -Infinity", () => {
    // Should not throw and should return a valid number in [1, 99]
    const posterior = bayesianUpdate(0.1, 1.4);
    expect(posterior).toBeGreaterThanOrEqual(1);
    expect(posterior).toBeLessThanOrEqual(99);
  });

  it("returns a value rounded to 1 decimal place", () => {
    const posterior = bayesianUpdate(55, 1.2);
    expect(posterior).toBe(Math.round(posterior * 10) / 10);
  });

  it("symmetry: reciprocal LRs from prior=50 produce mirror images around 50", () => {
    // LR=2.0 and LR=0.5 are exact reciprocals — posterior should be symmetric around 50
    const up = bayesianUpdate(50, 2.0);
    const down = bayesianUpdate(50, 0.5);
    expect(Math.abs(up - 50 - (50 - down))).toBeLessThan(0.5);
  });
});

// ─── credibleInterval ─────────────────────────────────────────────────────────

describe("credibleInterval", () => {
  it("returns [low, high] with low < posterior < high", () => {
    const [low, high] = credibleInterval(60, 3);
    expect(low).toBeLessThan(60);
    expect(high).toBeGreaterThan(60);
  });

  it("more signals → tighter interval (lower stdDev)", () => {
    const [low1, high1] = credibleInterval(60, 1);
    const [low2, high2] = credibleInterval(60, 9);
    expect(high2 - low2).toBeLessThan(high1 - low1);
  });

  it("interval is clamped to [1, 99]", () => {
    // Near-certain posterior — interval should not go outside [1, 99]
    const [low, high] = credibleInterval(98, 1);
    expect(low).toBeGreaterThanOrEqual(1);
    expect(high).toBeLessThanOrEqual(99);
  });

  it("signalCount=0 treated as 1 (no division by zero)", () => {
    expect(() => credibleInterval(50, 0)).not.toThrow();
    const [low, high] = credibleInterval(50, 0);
    expect(low).toBeGreaterThanOrEqual(1);
    expect(high).toBeLessThanOrEqual(99);
  });

  it("symmetric prior (50%) produces symmetric interval", () => {
    const [low, high] = credibleInterval(50, 4);
    expect(Math.abs(50 - low - (high - 50))).toBeLessThan(1);
  });
});
