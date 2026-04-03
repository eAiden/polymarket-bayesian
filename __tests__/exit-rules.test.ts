// Tests for the exit-rule helpers in lib/pipeline.ts.
//
// checkExitRules and computePnl are private to pipeline.ts, so we mirror
// their implementations inline here — the same pattern used in pnl.test.ts.
// Any change to the pipeline implementations should be reflected here.

import { describe, it, expect } from "vitest";
import {
  NEAR_RESOLUTION_LONG_PCT,
  NEAR_RESOLUTION_SHORT_PCT,
  EDGE_DECAY_THRESHOLD_PP,
  EDGE_OPEN_THRESHOLD_PP,
  STALE_THESIS_EDGE_PP,
  STALE_THESIS_DAYS,
} from "@/lib/constants";

// ─── Types (mirrors OpenTradeRef in pipeline.ts) ──────────────────────────────

interface OpenTradeRef {
  id: number;
  marketId: string;
  direction: string;
  entryProb: number;
  entryEdge: number;
  sizeUsd: number;
  openedAt: string;
}

// ─── Inlined helpers (must stay in sync with pipeline.ts) ────────────────────

function computePnl(trade: OpenTradeRef, currentYesProb: number): number {
  const currentSharePrice = trade.direction === "YES" ? currentYesProb : 100 - currentYesProb;
  const entrySharePrice = trade.direction === "YES" ? trade.entryProb : 100 - trade.entryProb;
  return entrySharePrice > 0
    ? Math.round(trade.sizeUsd * (currentSharePrice - entrySharePrice) / entrySharePrice * 100) / 100
    : 0;
}

function checkExitRules(
  trade: OpenTradeRef,
  edgePct: number,
  currentYesProb: number,
): { shouldExit: boolean; reason: string; exitLabel: string } | null {
  const absEdge = Math.abs(edgePct);

  const nearResolution =
    (trade.direction === "NO" && currentYesProb <= NEAR_RESOLUTION_SHORT_PCT) ||
    (trade.direction === "YES" && currentYesProb >= NEAR_RESOLUTION_LONG_PCT);
  if (nearResolution) {
    return { shouldExit: true, reason: "take_profit", exitLabel: "near-resolution take profit" };
  }

  const edgeFlipped =
    (trade.direction === "YES" && edgePct < 0) ||
    (trade.direction === "NO" && edgePct > 0);
  const edgeGone = absEdge < EDGE_DECAY_THRESHOLD_PP;
  if (edgeFlipped || edgeGone) {
    const label = edgeFlipped ? "edge flipped" : `edge < ${EDGE_DECAY_THRESHOLD_PP}pp`;
    return { shouldExit: true, reason: "edge_decay", exitLabel: label };
  }

  const ageDays = (Date.now() - new Date(trade.openedAt).getTime()) / 86_400_000;
  if (ageDays > STALE_THESIS_DAYS && absEdge < STALE_THESIS_EDGE_PP) {
    return { shouldExit: true, reason: "stop_loss", exitLabel: `stale thesis (${Math.round(ageDays)}d, edge=${edgePct > 0 ? "+" : ""}${edgePct}pp)` };
  }

  return null;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const baseYesTrade: OpenTradeRef = {
  id: 1, marketId: "mkt1", direction: "YES",
  entryProb: 55, entryEdge: 10, sizeUsd: 500, openedAt: daysAgo(5),
};
const baseNoTrade: OpenTradeRef = {
  id: 2, marketId: "mkt2", direction: "NO",
  entryProb: 35, entryEdge: -10, sizeUsd: 500, openedAt: daysAgo(5),
};

// ─── computePnl ───────────────────────────────────────────────────────────────

describe("computePnl", () => {
  describe("YES position", () => {
    it("profit when YES price rises", () => {
      // entry=55, current=75, size=500: 500*(75-55)/55 ≈ 181.82
      const pnl = computePnl({ ...baseYesTrade, entryProb: 55, sizeUsd: 500 }, 75);
      expect(pnl).toBeCloseTo(181.82, 1);
      expect(pnl).toBeGreaterThan(0);
    });

    it("loss when YES price falls", () => {
      // entry=55, current=30, size=500
      const pnl = computePnl({ ...baseYesTrade, entryProb: 55, sizeUsd: 500 }, 30);
      expect(pnl).toBeLessThan(0);
    });

    it("full loss at resolution NO (price=0)", () => {
      const pnl = computePnl({ ...baseYesTrade, entryProb: 55, sizeUsd: 500 }, 0);
      expect(pnl).toBeCloseTo(-500, 1);
    });

    it("no change in price → pnl is 0", () => {
      const pnl = computePnl({ ...baseYesTrade, entryProb: 60, sizeUsd: 500 }, 60);
      expect(pnl).toBe(0);
    });
  });

  describe("NO position", () => {
    it("profit when YES price drops (Al Mina case)", () => {
      // NO entry at entryProb=11 (YES price), so NO share price = 100-11=89
      // currentYesProb=7 → NO exit price = 100-7=93
      // pnl = 500*(93-89)/89 ≈ 22.47
      const pnl = computePnl({ ...baseNoTrade, entryProb: 11, sizeUsd: 500 }, 7);
      expect(pnl).toBeCloseTo(22.47, 1);
      expect(pnl).toBeGreaterThan(0);
    });

    it("loss when YES price rises (NO tokens fall)", () => {
      // NO entry at entryProb=20 (YES), NO share = 80; current YES=50 → NO=50
      const pnl = computePnl({ ...baseNoTrade, entryProb: 20, sizeUsd: 500 }, 50);
      expect(pnl).toBeCloseTo(-187.5, 1);
    });

    it("full win at resolution NO (YES=0, NO pays 100)", () => {
      // NO entry at entryProb=13 (YES), NO share = 87
      // pnl = 500*(100-87)/87 ≈ 74.71
      const pnl = computePnl({ ...baseNoTrade, entryProb: 13, sizeUsd: 500 }, 0);
      expect(pnl).toBeCloseTo(74.71, 1);
    });

    it("full loss when YES resolves to 100 (NO=0)", () => {
      const pnl = computePnl({ ...baseNoTrade, entryProb: 37, sizeUsd: 500 }, 100);
      expect(pnl).toBeCloseTo(-500, 1);
    });
  });

  describe("edge cases", () => {
    it("entryProb=0 guard → pnl is 0, no division by zero", () => {
      const pnl = computePnl({ ...baseYesTrade, entryProb: 0 }, 75);
      expect(pnl).toBe(0);
      expect(Number.isNaN(pnl)).toBe(false);
    });

    it("sizeUsd=0 → pnl is 0", () => {
      const pnl = computePnl({ ...baseYesTrade, sizeUsd: 0 }, 75);
      expect(pnl).toBe(0);
    });

    it("result rounds to cents (2 decimal places)", () => {
      const pnl = computePnl({ ...baseNoTrade, entryProb: 11, sizeUsd: 500 }, 7);
      expect(pnl * 100 % 1).toBeCloseTo(0, 5);
    });
  });
});

// ─── checkExitRules — take profit ────────────────────────────────────────────

describe("checkExitRules — near-resolution take profit", () => {
  it("YES trade: fires at NEAR_RESOLUTION_LONG_PCT", () => {
    const result = checkExitRules(baseYesTrade, 8, NEAR_RESOLUTION_LONG_PCT);
    expect(result?.reason).toBe("take_profit");
  });

  it("YES trade: fires above NEAR_RESOLUTION_LONG_PCT", () => {
    const result = checkExitRules(baseYesTrade, 4, 95);
    expect(result?.reason).toBe("take_profit");
  });

  it("YES trade: does NOT fire one tick below threshold", () => {
    const result = checkExitRules(baseYesTrade, 8, NEAR_RESOLUTION_LONG_PCT - 1);
    expect(result?.reason).not.toBe("take_profit");
  });

  it("NO trade: fires at NEAR_RESOLUTION_SHORT_PCT", () => {
    const result = checkExitRules(baseNoTrade, -8, NEAR_RESOLUTION_SHORT_PCT);
    expect(result?.reason).toBe("take_profit");
  });

  it("NO trade: fires below NEAR_RESOLUTION_SHORT_PCT", () => {
    const result = checkExitRules(baseNoTrade, -4, 3);
    expect(result?.reason).toBe("take_profit");
  });

  it("NO trade: does NOT fire one tick above threshold", () => {
    const result = checkExitRules(baseNoTrade, -8, NEAR_RESOLUTION_SHORT_PCT + 1);
    expect(result?.reason).not.toBe("take_profit");
  });
});

// ─── checkExitRules — edge decay ─────────────────────────────────────────────

describe("checkExitRules — edge decay", () => {
  it("YES trade: fires when edge flips negative", () => {
    const result = checkExitRules(baseYesTrade, -3, 55);
    expect(result?.reason).toBe("edge_decay");
    expect(result?.exitLabel).toBe("edge flipped");
  });

  it("NO trade: fires when edge flips positive", () => {
    const result = checkExitRules(baseNoTrade, 3, 40);
    expect(result?.reason).toBe("edge_decay");
    expect(result?.exitLabel).toBe("edge flipped");
  });

  it("fires when |edge| drops below EDGE_DECAY_THRESHOLD_PP", () => {
    const result = checkExitRules(baseYesTrade, EDGE_DECAY_THRESHOLD_PP - 0.1, 60);
    expect(result?.reason).toBe("edge_decay");
  });

  it("does NOT fire when |edge| equals EDGE_DECAY_THRESHOLD_PP exactly", () => {
    // boundary: absEdge < 2, so exactly 2 should NOT trigger
    const result = checkExitRules(baseYesTrade, EDGE_DECAY_THRESHOLD_PP, 60);
    expect(result?.reason).not.toBe("edge_decay");
  });

  it("does NOT fire when edge is healthy and thesis fresh", () => {
    const result = checkExitRules(baseYesTrade, 10, 60);
    expect(result).toBeNull();
  });
});

// ─── checkExitRules — time-based stop ────────────────────────────────────────

describe("checkExitRules — time-based stale-thesis stop", () => {
  it("fires when trade is older than STALE_THESIS_DAYS with weak edge", () => {
    const staleTrade = { ...baseYesTrade, openedAt: daysAgo(STALE_THESIS_DAYS + 1) };
    const result = checkExitRules(staleTrade, STALE_THESIS_EDGE_PP - 1, 60);
    expect(result?.reason).toBe("stop_loss");
  });

  it("does NOT fire at exactly STALE_THESIS_DAYS (must be strictly greater)", () => {
    // Trade opened exactly STALE_THESIS_DAYS ago — boundary should NOT trigger
    // (ageDays > STALE_THESIS_DAYS is strict)
    const exactBoundary = { ...baseYesTrade, openedAt: daysAgo(STALE_THESIS_DAYS) };
    const result = checkExitRules(exactBoundary, STALE_THESIS_EDGE_PP - 1, 60);
    expect(result?.reason).not.toBe("stop_loss");
  });

  it("does NOT fire when edge is strong even if stale", () => {
    const staleTrade = { ...baseYesTrade, openedAt: daysAgo(STALE_THESIS_DAYS + 5) };
    const result = checkExitRules(staleTrade, STALE_THESIS_EDGE_PP, 60);
    expect(result?.reason).not.toBe("stop_loss");
  });

  it("does NOT fire when trade is fresh even with weak edge", () => {
    const freshTrade = { ...baseYesTrade, openedAt: daysAgo(10) };
    const result = checkExitRules(freshTrade, STALE_THESIS_EDGE_PP - 1, 60);
    expect(result?.reason).not.toBe("stop_loss");
  });

  it("exitLabel includes age and edge info", () => {
    const staleTrade = { ...baseYesTrade, openedAt: daysAgo(STALE_THESIS_DAYS + 3) };
    const result = checkExitRules(staleTrade, 3, 60);
    expect(result?.exitLabel).toContain("stale thesis");
    expect(result?.exitLabel).toContain("pp");
  });
});

// ─── checkExitRules — null path ───────────────────────────────────────────────

describe("checkExitRules — no exit (returns null)", () => {
  it("healthy YES trade with strong edge returns null", () => {
    expect(checkExitRules(baseYesTrade, 12, 65)).toBeNull();
  });

  it("healthy NO trade with strong edge returns null", () => {
    expect(checkExitRules(baseNoTrade, -12, 35)).toBeNull();
  });

  it("fresh trade with weak edge does not stop (age gate)", () => {
    const fresh = { ...baseYesTrade, openedAt: daysAgo(3) };
    expect(checkExitRules(fresh, 3, 60)).toBeNull();
  });
});

// ─── Priority ordering ────────────────────────────────────────────────────────

describe("checkExitRules — priority: take_profit beats edge_decay", () => {
  it("YES near resolution with zero edge: take_profit wins over edge_decay", () => {
    // YES at 93% with edge=1pp — both edge_decay (< 2pp) and take_profit fire
    // take_profit is checked first and should win
    const result = checkExitRules(baseYesTrade, 1, 93);
    expect(result?.reason).toBe("take_profit");
  });

  it("NO near resolution with flipped edge: take_profit wins over edge_decay", () => {
    // NO trade at YES=6% with edge now positive (flip) — take_profit checked first
    const result = checkExitRules(baseNoTrade, 2, 5);
    expect(result?.reason).toBe("take_profit");
  });
});
