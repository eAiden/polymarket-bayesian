// Tests for paper trading P&L math — the YES and NO share-price paths.
// These are the formulas inside closePositionEarly and closePosition.
// Tested as inline pure functions so we don't need file I/O or full state.
//
// IMPORTANT: entryPrice and exitPrice are ALWAYS the share price of the SIDE taken:
//   YES position: entryPrice = YES market price (e.g. 55¢)
//   NO  position: entryPrice = NO market price  (e.g. 89¢ when YES is at 11¢)
//
// The Al Mina bug: old code passed currentMarketPrice (the YES price) as currentPrice
// for a NO position, then computed exitSharePrice = 100 - currentPrice = 11 instead of
// using the NO price directly. These tests pin the correct behavior.

import { describe, it, expect } from "vitest";

// ─── P&L formula (inline — mirrors closePositionEarly) ───────────────────────

function calcPnl(
  side: "YES" | "NO",
  entrySharePrice: number,  // share price of the side taken at entry
  currentMarketPrice: number, // YES market price at exit/update
  notional: number,
): { exitSharePrice: number; pnl: number; pnlPct: number } {
  const exitSharePrice = side === "YES" ? currentMarketPrice : 100 - currentMarketPrice;
  const pnl = entrySharePrice > 0
    ? Math.round(notional * (exitSharePrice - entrySharePrice) / entrySharePrice * 100) / 100
    : 0;
  const pnlPct = notional > 0 ? Math.round((pnl / notional) * 10000) / 100 : 0;
  return { exitSharePrice, pnl, pnlPct };
}

// ─── YES position P&L ─────────────────────────────────────────────────────────

describe("YES position P&L", () => {
  it("profit when YES price rises", () => {
    // Enter YES at 55¢, exit at 75¢ on $130 notional
    const { pnl, pnlPct } = calcPnl("YES", 55, 75, 130.17);
    expect(pnl).toBeGreaterThan(0);
    // pnl = 130.17 × (75-55)/55 = 130.17 × 0.3636 ≈ 47.34
    expect(pnl).toBeCloseTo(47.34, 1);
  });

  it("loss when YES price falls to 0 (market resolves NO)", () => {
    // Enter YES at 55¢, resolves to 0
    const { pnl, pnlPct } = calcPnl("YES", 55, 0, 130.17);
    expect(pnl).toBeCloseTo(-130.17, 2); // full loss
    expect(pnlPct).toBeCloseTo(-100, 1);
  });

  it("full win when YES resolves to 100", () => {
    // Enter YES at 55¢, resolves YES at 100¢
    const { pnl, pnlPct } = calcPnl("YES", 55, 100, 100);
    // pnl = 100 × (100-55)/55 ≈ 81.82
    expect(pnl).toBeCloseTo(81.82, 1);
    expect(pnlPct).toBeCloseTo(81.82, 1);
  });

  it("exitSharePrice equals currentMarketPrice for YES position", () => {
    const { exitSharePrice } = calcPnl("YES", 60, 70, 500);
    expect(exitSharePrice).toBe(70);
  });
});

// ─── NO position P&L ──────────────────────────────────────────────────────────

describe("NO position P&L", () => {
  it("Al Mina case: NO at 89¢, YES drops to 7¢ → profit", () => {
    // entryPrice=89 (NO price when YES=11), currentMarketPrice=7 (YES price at exit)
    // exitSharePrice = 100 - 7 = 93
    // pnl = 500 × (93-89)/89 = 500 × 4/89 ≈ 22.47
    const { exitSharePrice, pnl, pnlPct } = calcPnl("NO", 89, 7, 500);
    expect(exitSharePrice).toBe(93);
    expect(pnl).toBeCloseTo(22.47, 2);
    expect(pnlPct).toBeCloseTo(4.49, 1);
  });

  it("NO position: loss when YES price rises (NO tokens fall)", () => {
    // Enter NO at 80¢ (YES=20), YES rises to 50¢ (NO=50)
    // pnl = 500 × (50-80)/80 = 500 × (-30/80) = -187.50
    const { pnl } = calcPnl("NO", 80, 50, 500);
    expect(pnl).toBeLessThan(0);
    expect(pnl).toBeCloseTo(-187.50, 1);
  });

  it("NO resolves favorably: YES goes to 0, NO tokens pay 100", () => {
    // Enter NO at 87¢, market resolves NO (YES=0, NO=100)
    const { exitSharePrice, pnl } = calcPnl("NO", 87, 0, 500);
    expect(exitSharePrice).toBe(100);
    // pnl = 500 × (100-87)/87 ≈ 74.71
    expect(pnl).toBeCloseTo(74.71, 1);
  });

  it("NO resolves against: YES goes to 100, NO tokens pay 0", () => {
    // Enter NO at 63¢, market resolves YES (NO=0)
    const { exitSharePrice, pnl, pnlPct } = calcPnl("NO", 63, 100, 191.55);
    expect(exitSharePrice).toBe(0);
    expect(pnl).toBeCloseTo(-191.55, 1);
    expect(pnlPct).toBeCloseTo(-100, 0);
  });

  it("exitSharePrice = 100 - currentMarketPrice for NO position", () => {
    const { exitSharePrice } = calcPnl("NO", 70, 30, 500);
    expect(exitSharePrice).toBe(70); // 100 - 30
  });

  it("the OLD bug: treating entryPrice=89 as YES price gave inflated P&L", () => {
    // Old code did: exitSharePrice = 100 - 7 = 93 but used entrySharePrice = 100 - 89 = 11
    const oldBugPnl = Math.round(500 * (93 - 11) / 11 * 100) / 100;
    expect(oldBugPnl).toBeCloseTo(3727.27, 1); // the inflated value the user saw

    // Correct: entryPrice IS the NO share price (89), no inversion needed
    const { pnl: correctPnl } = calcPnl("NO", 89, 7, 500);
    expect(correctPnl).toBeCloseTo(22.47, 2); // the correct value
  });
});

// ─── Elon tweets case (real closed position) ─────────────────────────────────

describe("real closed positions cross-check", () => {
  it("Elon tweets NO: entry 63¢, resolved NO (YES=0)", () => {
    const { pnl, pnlPct } = calcPnl("NO", 63, 0, 191.55);
    expect(pnl).toBeCloseTo(112.50, 1);
    expect(pnlPct).toBeCloseTo(58.73, 1);
  });

  it("Crude oil NO: entry 87¢, resolved NO (YES=0)", () => {
    const { pnl, pnlPct } = calcPnl("NO", 87, 0, 500);
    expect(pnl).toBeCloseTo(74.71, 1);
    expect(pnlPct).toBeCloseTo(14.94, 1);
  });

  it("Crude oil YES: entry 55¢, resolved NO (YES=0)", () => {
    const { pnl, pnlPct } = calcPnl("YES", 55, 0, 130.17);
    expect(pnl).toBeCloseTo(-130.17, 1);
    expect(pnlPct).toBeCloseTo(-100, 0);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("zero notional → pnl is 0", () => {
    const { pnl } = calcPnl("YES", 55, 75, 0);
    expect(pnl).toBe(0);
  });

  it("entryPrice=0 (guard) → pnl is 0, no division by zero", () => {
    const { pnl } = calcPnl("YES", 0, 75, 500);
    expect(pnl).toBe(0);
    expect(Number.isNaN(pnl)).toBe(false);
  });

  it("no change in price → pnl is 0", () => {
    const { pnl } = calcPnl("YES", 60, 60, 500);
    expect(pnl).toBe(0);
  });

  it("pnl is always rounded to cents (2 decimal places)", () => {
    const { pnl } = calcPnl("NO", 89, 7, 500);
    expect(pnl * 100 % 1).toBeCloseTo(0, 5);
  });
});
