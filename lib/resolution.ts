// Detect and process resolved markets — price crosses 98% or 2%.
// Called at the start of each scan pipeline run.

import { sql, markResolved, insertCalibration, getLatestSignal, getOpenTrades, closeTrade, backfillTradeOutcomes } from "./db";
import { fetchMarketPrice } from "./polymarket";
import { RESOLUTION_YES_PCT, RESOLUTION_NO_PCT } from "./constants";

export async function processResolvedMarkets(): Promise<{ resolved: number; errors: string[] }> {
  const db = sql();
  const errors: string[] = [];
  let resolved = 0;

  // Find markets that have passed their end date but haven't been marked resolved
  const candidates = await db`
    SELECT id, question, category, end_date_iso, yes_prob_pct
    FROM markets
    WHERE end_date_iso IS NOT NULL
      AND end_date_iso::timestamptz < NOW()
      AND resolved_outcome IS NULL
  `;

  if (candidates.length === 0) {
    console.log("[resolution] No unresolved past-deadline markets found");
    return { resolved: 0, errors: [] };
  }

  console.log(`[resolution] Checking ${candidates.length} past-deadline markets for resolution...`);

  for (const market of candidates) {
    try {
      const price = await fetchMarketPrice(market.id as string);
      if (price === null) {
        // Can't fetch price — skip
        continue;
      }

      let outcome: 0 | 1 | null = null;
      if (price >= RESOLUTION_YES_PCT) {
        outcome = 1; // YES resolved
      } else if (price <= RESOLUTION_NO_PCT) {
        outcome = 0; // NO resolved
      } else {
        // Not yet fully resolved — skip
        continue;
      }

      // Mark resolved in DB first — this is the authoritative state change
      await markResolved(market.id as string, outcome);
      console.log(`[resolution] "${(market.question as string).slice(0, 50)}" → outcome=${outcome} (price=${price}%)`);

      // Backfill training labels onto feature vectors — non-critical, must not block trade closure
      try {
        await backfillTradeOutcomes(market.id as string, outcome, price);
      } catch (backfillErr) {
        console.error(`[resolution] backfillTradeOutcomes failed for ${market.id as string}:`, backfillErr instanceof Error ? backfillErr.message : backfillErr);
      }

      // Get latest signal for calibration
      const signal = await getLatestSignal(market.id as string);
      if (signal) {
        const predictedProb = signal.posteriorProb;
        const brierScore = Math.pow(predictedProb / 100 - outcome, 2);
        const directionCorrect =
          (signal.direction === "YES" && outcome === 1) ||
          (signal.direction === "NO" && outcome === 0);

        await insertCalibration({
          marketId: market.id as string,
          question: market.question as string,
          category: (market.category ?? "Other") as string,
          predictedProb,
          resolvedOutcome: outcome,
          brierScore,
          directionCorrect,
          direction: (signal.direction === "NO" ? "NO" : "YES") as "YES" | "NO",
        });
        console.log(`[resolution] Calibration recorded: brier=${brierScore.toFixed(4)}, correct=${directionCorrect}`);
      }

      // Close any open paper trades for this market
      const openTrades = await getOpenTrades();
      const marketTrades = openTrades.filter(t => t.marketId === market.id);
      for (const trade of marketTrades) {
        // Store 100 or 0 — not the live mid-quote — so exit_prob is consistent with pnl_usd
        // (which already assumes the share settles at 100 or 0 on resolution)
        const won = (trade.direction === "YES" && outcome === 1) || (trade.direction === "NO" && outcome === 0);
        const exitProb = outcome === 1 ? 100 : 0;
        const exitSharePrice = won ? 100 : 0;
        const entrySharePrice = trade.direction === "YES" ? trade.entryProb : 100 - trade.entryProb;
        const pnl = entrySharePrice > 0
          ? Math.round(trade.sizeUsd * (exitSharePrice - entrySharePrice) / entrySharePrice * 100) / 100
          : 0;

        await closeTrade(trade.id, exitProb, pnl, "resolution");
        console.log(`[resolution] Closed trade #${trade.id}: P&L=$${pnl}`);
      }

      resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Market ${market.id}: ${msg}`);
      console.error(`[resolution] Error processing market ${market.id}:`, msg);
    }
  }

  console.log(`[resolution] Resolved ${resolved} markets`);
  return { resolved, errors };
}
