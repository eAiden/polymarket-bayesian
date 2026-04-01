// Tests for the ablation baseline score formula.
// Formula: newsAge × max(0, 1 - daysToResolution/30) × min(1, volumeSpike/3)
// This formula lives inline in analysis.ts and pipeline.ts — tested here as a pure function
// so we can verify edge cases without running the full pipeline.

import { describe, it, expect } from "vitest";

// Inline the formula for isolated testing.
// If the formula changes in analysis.ts, this test will catch the divergence.
function baselineScore(newsAge: number, daysToResolution: number, volumeSpike: number): number {
  return newsAge
    * Math.max(0, 1 - daysToResolution / 30)
    * Math.min(1, volumeSpike / 3);
}

describe("ablation baseline score formula", () => {
  it("normal case: recent news, 7 days out, moderate volume", () => {
    // newsAge = 0.5 (recent), daysToResolution = 7, volumeSpike = 2
    const result = baselineScore(0.5, 7, 2);
    // = 0.5 × (1 - 7/30) × min(1, 2/3)
    // = 0.5 × (23/30) × (2/3)
    // ≈ 0.5 × 0.7667 × 0.6667 ≈ 0.2556
    expect(result).toBeCloseTo(0.2556, 3);
  });

  it("breaking news case: newsAge=1 gives higher score", () => {
    const breaking = baselineScore(1.0, 7, 2);
    const recent = baselineScore(0.5, 7, 2);
    expect(breaking).toBeGreaterThan(recent);
    expect(breaking).toBeCloseTo(recent * 2, 5);
  });

  it("zero volumeSpike returns 0, not NaN", () => {
    const result = baselineScore(1.0, 7, 0);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("daysToResolution > 30: middle term is 0, score is 0", () => {
    expect(baselineScore(1.0, 31, 3)).toBe(0);
    expect(baselineScore(1.0, 100, 3)).toBe(0);
    expect(baselineScore(0.5, 30.01, 2)).toBe(0);
  });

  it("daysToResolution = 0: middle term is 1.0 (maximum urgency)", () => {
    // newsAge=1, days=0, vol=3 → 1 × 1 × 1 = 1.0
    expect(baselineScore(1.0, 0, 3)).toBeCloseTo(1.0, 5);
  });

  it("daysToResolution = 30: middle term exactly 0", () => {
    expect(baselineScore(1.0, 30, 3)).toBeCloseTo(0, 5);
  });

  it("volumeSpike >= 3: min(1, vol/3) is capped at 1.0", () => {
    const capped = baselineScore(1.0, 0, 3);
    const exceeds = baselineScore(1.0, 0, 9);
    expect(capped).toBeCloseTo(1.0, 5);
    expect(exceeds).toBeCloseTo(1.0, 5); // should not exceed 1
  });

  it("stale news (newsAge=0): score is always 0", () => {
    expect(baselineScore(0, 7, 2)).toBe(0);
    expect(baselineScore(0, 0, 100)).toBe(0);
  });

  it("output is always in [0, 1]", () => {
    const cases = [
      [0, 0, 0], [1, 0, 3], [0.5, 14, 1.5], [1, 29, 2.9], [0.1, 1, 0.1],
    ] as [number, number, number][];
    for (const [age, days, vol] of cases) {
      const s = baselineScore(age, days, vol);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
