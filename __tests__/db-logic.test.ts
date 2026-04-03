// Tests for pure logic extracted from db.ts functions.
// All DB I/O is inlined as pure helpers — no real DB connection required.

import { describe, it, expect } from "vitest";
import { edgeToConfidence, EDGE_OPEN_THRESHOLD_PP } from "@/lib/constants";

// ─── edgeToConfidence ─────────────────────────────────────────────────────────

describe("edgeToConfidence", () => {
  it("returns 'high' at 10pp", () => {
    expect(edgeToConfidence(10)).toBe("high");
  });

  it("returns 'high' above 10pp", () => {
    expect(edgeToConfidence(15)).toBe("high");
    expect(edgeToConfidence(30)).toBe("high");
  });

  it("returns 'medium' at EDGE_OPEN_THRESHOLD_PP", () => {
    expect(edgeToConfidence(EDGE_OPEN_THRESHOLD_PP)).toBe("medium");
  });

  it("returns 'medium' between threshold and 10", () => {
    expect(edgeToConfidence(7)).toBe("medium");
    expect(edgeToConfidence(9.9)).toBe("medium");
  });

  it("returns 'low' below EDGE_OPEN_THRESHOLD_PP", () => {
    expect(edgeToConfidence(EDGE_OPEN_THRESHOLD_PP - 0.1)).toBe("low");
    expect(edgeToConfidence(0)).toBe("low");
  });

  it("handles boundary at exactly 10 — high, not medium", () => {
    expect(edgeToConfidence(10)).toBe("high");
    expect(edgeToConfidence(9.99)).toBe("medium");
  });
});

// ─── closeTrade status logic ──────────────────────────────────────────────────
// Mirrors the status derivation in closeTrade() in db.ts.

function deriveTradeStatus(reason: string): "closed" | "stopped" {
  return reason === "resolution" ? "closed" : "stopped";
}

describe("closeTrade status derivation", () => {
  it("resolution exit → status='closed'", () => {
    expect(deriveTradeStatus("resolution")).toBe("closed");
  });

  it("edge_decay exit → status='stopped'", () => {
    expect(deriveTradeStatus("edge_decay")).toBe("stopped");
  });

  it("stop_loss exit → status='stopped'", () => {
    expect(deriveTradeStatus("stop_loss")).toBe("stopped");
  });

  it("take_profit exit → status='stopped'", () => {
    expect(deriveTradeStatus("take_profit")).toBe("stopped");
  });

  it("any unknown reason → status='stopped' (safe default)", () => {
    expect(deriveTradeStatus("unknown_future_reason")).toBe("stopped");
  });
});

// ─── batchAppendPriceHistory dedup logic ─────────────────────────────────────
// Mirrors the filter step in batchAppendPriceHistory() in db.ts.

function filterChangedPrices(
  rows: Array<{ marketId: string; marketProb: number }>,
  latestByMarket: Map<string, number>,
): Array<{ marketId: string; marketProb: number }> {
  return rows.filter(r => latestByMarket.get(r.marketId) !== r.marketProb);
}

describe("batchAppendPriceHistory dedup filter", () => {
  it("keeps rows where price changed", () => {
    const latest = new Map([["m1", 55]]);
    const result = filterChangedPrices([{ marketId: "m1", marketProb: 60 }], latest);
    expect(result).toHaveLength(1);
  });

  it("drops rows where price is unchanged", () => {
    const latest = new Map([["m1", 55]]);
    const result = filterChangedPrices([{ marketId: "m1", marketProb: 55 }], latest);
    expect(result).toHaveLength(0);
  });

  it("keeps rows for markets with no prior price history", () => {
    const latest = new Map<string, number>();
    const result = filterChangedPrices([{ marketId: "new-market", marketProb: 40 }], latest);
    expect(result).toHaveLength(1);
  });

  it("handles mixed batch correctly", () => {
    const latest = new Map([
      ["m1", 55],  // unchanged
      ["m2", 30],  // changed
    ]);
    const rows = [
      { marketId: "m1", marketProb: 55 },   // skip
      { marketId: "m2", marketProb: 35 },   // keep
      { marketId: "m3", marketProb: 70 },   // new market — keep
    ];
    const result = filterChangedPrices(rows, latest);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.marketId)).toEqual(["m2", "m3"]);
  });

  it("empty input returns empty output", () => {
    const result = filterChangedPrices([], new Map());
    expect(result).toHaveLength(0);
  });

  it("all prices unchanged returns empty output", () => {
    const latest = new Map([["m1", 60], ["m2", 40]]);
    const rows = [{ marketId: "m1", marketProb: 60 }, { marketId: "m2", marketProb: 40 }];
    expect(filterChangedPrices(rows, latest)).toHaveLength(0);
  });
});
