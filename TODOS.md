# TODOS

Items deferred from plan review. Context captured so future sessions can pick these up.

---

## TODO: Retroactive test coverage for core lib/ modules

**What:** Add vitest unit tests for the existing untested modules:
- `lib/paper-trading.ts` — Kelly sizing, P&L math (win/loss calculation, stop-loss, unrealized P&L), position state machine
- `lib/features.ts` — Feature vector computation for each of the 17 fields, edge cases (null orderbook, no trade data)
- `lib/scoring.ts` — scoreMarket() with default weights, edge clamping, top contributors
- `lib/signal-log.ts` — appendSignalSnapshot, load/save with corrupt data

**Why:** The P&L math in paper-trading.ts was silently wrong (dividing by 100 instead of entryPrice) and was only caught by manual review. Without tests, that class of regression can return. Feature engineering has 17 computed fields each with range assumptions that should be verified.

**When:** After Phase 2 gate is hit (20+ resolved positions). Before model training phase begins.

**Where to start:** `vitest.config.ts` will exist by then. Add `__tests__/existing-modules/` alongside the new tests.

**Context:** Plan review (2026-04-01) identified this as the highest-priority deferred item. The codebase had zero tests before this plan.

---

## TODO: Revisit ablation baseline direction independence

**What:** The current ablation baseline always uses the full model's direction (YES/NO). This means the baseline can never disagree directionally — it only tests whether the 17-feature model improves SIZING over a 3-feature heuristic. A scientifically stronger ablation needs an independent direction signal.

**Options for independent baseline direction:**
1. Always bet YES (simplest possible null hypothesis)
2. Bet the price momentum direction (`priceMomentum3d > 0 → YES, else NO`)
3. Bet the order flow direction (`buySellRatio > 1 → YES, else NO`)

**Why:** If ablation results after 20+ positions are ambiguous (baseline and full model have similar P&L), it may be because they always agree on direction. An independent direction baseline would reveal whether the model's DIRECTION detection adds any value at all.

**When:** After first ablation comparison (Phase 2 gate). Only revisit if results are ambiguous.

**Context:** Flagged during outside voice review (2026-04-01). Acceptable for MVP.

