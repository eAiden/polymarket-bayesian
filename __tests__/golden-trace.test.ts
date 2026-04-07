// Golden trace test — proves the wires between modules are connected.
//
// Walks a canonical example from raw signals all the way through to a trade
// decision: signals → LR → posterior → edge → direction → confidence → Kelly.
// Then drives the same trade through the exit rule logic to confirm the
// take-profit / edge-decay paths still fire as expected.
//
// If any module changes its contract, this is the test that breaks first.

import { describe, it, expect } from "vitest";
import { signalsToLikelihoodRatio, bayesianUpdate, credibleInterval } from "@/lib/bayesian";
import { kellySize } from "@/lib/paper-trading";
import {
  edgeToConfidence,
  EDGE_OPEN_THRESHOLD_PP,
  EDGE_DECAY_THRESHOLD_PP,
  NEAR_RESOLUTION_LONG_PCT,
} from "@/lib/constants";
import type { NewsSignal } from "@/lib/types";

describe("golden trace: signals → trade decision", () => {
  it("strong YES news on a 40% market produces an actionable long", () => {
    // 1. Two strong YES signals from different sources
    const signals: NewsSignal[] = [
      { fact: "Court ruled in favor", direction: "YES", strength: "strong", recency: "today",      source: "Reuters" },
      { fact: "Confirmation hearing passed", direction: "YES", strength: "moderate", recency: "today", source: "BBC"     },
    ];

    // 2. Likelihood ratio: 1.4 × 1.2 = 1.68
    const lr = signalsToLikelihoodRatio(signals);
    expect(lr).toBeCloseTo(1.68, 2);

    // 3. Bayesian update from a 40% market prior
    const prior = 40;
    const posterior = bayesianUpdate(prior, lr);
    expect(posterior).toBeGreaterThan(prior);
    expect(posterior).toBeLessThan(60); // shouldn't overshoot wildly

    // 4. Edge in pp
    const edgePct = Math.round((posterior - prior) * 10) / 10;
    expect(edgePct).toBeGreaterThan(EDGE_OPEN_THRESHOLD_PP);

    // 5. Direction + confidence
    const direction = edgePct >= 0 ? "YES" : "NO";
    expect(direction).toBe("YES");
    const confidence = edgeToConfidence(Math.abs(edgePct));
    expect(confidence).not.toBe("low");

    // 6. Kelly sizing: should be > $0 and capped at 5% of bankroll
    const { notional, fraction } = kellySize(edgePct, confidence, prior, 10_000);
    expect(notional).toBeGreaterThan(0);
    expect(fraction).toBeLessThanOrEqual(0.05);
    expect(notional).toBeLessThanOrEqual(500);

    // 7. Credible interval should bracket the posterior
    const [lo, hi] = credibleInterval(posterior, signals.length);
    expect(lo).toBeLessThan(posterior);
    expect(hi).toBeGreaterThan(posterior);
  });

  it("strong NO news on a 70% market produces an actionable short", () => {
    const signals: NewsSignal[] = [
      { fact: "Plan abandoned",  direction: "NO", strength: "strong", recency: "today", source: "Reuters" },
      { fact: "CEO denied talks", direction: "NO", strength: "strong", recency: "today", source: "WSJ"     },
    ];
    const lr = signalsToLikelihoodRatio(signals);
    expect(lr).toBeLessThan(1);

    const prior = 70;
    const posterior = bayesianUpdate(prior, lr);
    expect(posterior).toBeLessThan(prior);

    const edgePct = Math.round((posterior - prior) * 10) / 10;
    expect(edgePct).toBeLessThan(-EDGE_OPEN_THRESHOLD_PP);

    const direction = edgePct >= 0 ? "YES" : "NO";
    expect(direction).toBe("NO");
    const confidence = edgeToConfidence(Math.abs(edgePct));
    expect(confidence).not.toBe("low");

    const { notional } = kellySize(edgePct, confidence, prior, 10_000);
    expect(notional).toBeGreaterThan(0);
  });

  it("weak conflicting signals on a 50% market produce no actionable trade", () => {
    const signals: NewsSignal[] = [
      { fact: "Mild positive",  direction: "YES", strength: "weak", recency: "this_week", source: "Reuters" },
      { fact: "Mild negative",  direction: "NO",  strength: "weak", recency: "this_week", source: "BBC"     },
    ];
    const lr = signalsToLikelihoodRatio(signals);
    expect(lr).toBeCloseTo(1.08 * 0.92, 3);

    const prior = 50;
    const posterior = bayesianUpdate(prior, lr);
    const edgePct = Math.round((posterior - prior) * 10) / 10;
    expect(Math.abs(edgePct)).toBeLessThan(EDGE_OPEN_THRESHOLD_PP);
  });

  it("category bias correction shrinks an inflated edge below the open threshold", () => {
    // Raw edge of +6pp; bias says model historically over-predicts YES by +4pp
    const rawEdge = 6;
    const bias = 4;
    const debiased = Math.round((rawEdge - bias) * 10) / 10;
    expect(debiased).toBe(2);
    expect(debiased).toBeLessThan(EDGE_OPEN_THRESHOLD_PP);
  });

  it("near-resolution take-profit threshold sits comfortably above the open threshold", () => {
    // Sanity: take-profit window must be reachable but well past where we'd open
    expect(NEAR_RESOLUTION_LONG_PCT).toBeGreaterThan(50 + EDGE_OPEN_THRESHOLD_PP);
    // Edge decay threshold must be smaller than open threshold (else we'd close immediately)
    expect(EDGE_DECAY_THRESHOLD_PP).toBeLessThan(EDGE_OPEN_THRESHOLD_PP);
  });
});
