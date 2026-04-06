// Orchestrates the full scan pipeline using DB-backed approach.
// Replaces the old file + KV approach.

import type { ScanEvent, ScanError } from "./types";
import { fetchFilteredMarkets, fetchMarketPrice } from "./polymarket";
import { kellySize } from "./paper-trading";
import {
  acquireScanLock, releaseScanLock, upsertMarket,
  insertSignal, appendPriceHistory, batchAppendPriceHistory,
  touchMarketScan, batchTouchMarketScan,
  getMarketStore, openTrade, getOpenTrades, closeTrade,
  updateMarketPrice, insertTradeFeatures, updateTradeExitSnapshot,
} from "./db";
import { signalsToLikelihoodRatio, bayesianUpdate, credibleInterval } from "./bayesian";
import { fetchEnrichment, extractSignalsBatch } from "./signal-extraction";
import { computeFeatures } from "./features";
import { processResolvedMarkets } from "./resolution";
import type { MarketEnrichment, ExtractedSignal } from "./types";
import type { CrossMarketMatch } from "./crossmarket";
import {
  NEAR_RESOLUTION_LONG_PCT,
  NEAR_RESOLUTION_SHORT_PCT,
  EDGE_DECAY_THRESHOLD_PP,
  EDGE_OPEN_THRESHOLD_PP,
  STALE_THESIS_EDGE_PP,
  STALE_THESIS_DAYS,
  edgeToConfidence,
} from "./constants";

export type ScanProgressCallback = (event: ScanEvent) => void;

// ─── Exit rule helpers ────────────────────────────────────────────────────────

interface OpenTradeRef {
  id: number;
  marketId: string;
  direction: string;
  entryProb: number;
  entryEdge: number;
  sizeUsd: number;
  openedAt: string;
}

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

  // 1. Near-resolution take profit: lock in win when market moved strongly in our favour
  //    before the formal resolution threshold fires.
  const nearResolution =
    (trade.direction === "NO" && currentYesProb <= NEAR_RESOLUTION_SHORT_PCT) ||
    (trade.direction === "YES" && currentYesProb >= NEAR_RESOLUTION_LONG_PCT);
  if (nearResolution) {
    return { shouldExit: true, reason: "take_profit", exitLabel: "near-resolution take profit" };
  }

  // 2. Edge decay: model lost conviction (edge flipped direction or fell below threshold)
  const edgeFlipped =
    (trade.direction === "YES" && edgePct < 0) ||
    (trade.direction === "NO" && edgePct > 0);
  const edgeGone = absEdge < EDGE_DECAY_THRESHOLD_PP;
  if (edgeFlipped || edgeGone) {
    const label = edgeFlipped ? "edge flipped" : `edge < ${EDGE_DECAY_THRESHOLD_PP}pp`;
    return { shouldExit: true, reason: "edge_decay", exitLabel: label };
  }

  // 3. Time-based stop: thesis is stale (open >STALE_THESIS_DAYS with weak edge)
  const ageDays = (Date.now() - new Date(trade.openedAt).getTime()) / 86_400_000;
  if (ageDays > STALE_THESIS_DAYS && absEdge < STALE_THESIS_EDGE_PP) {
    return { shouldExit: true, reason: "stop_loss", exitLabel: `stale thesis (${Math.round(ageDays)}d, edge=${edgePct > 0 ? "+" : ""}${edgePct}pp)` };
  }

  return null;
}

// Shared helper — saves feature vector for model training at trade-open time.
// Wrapped in try/catch so a feature-save failure never blocks the trade open.
async function saveTradeFeatures(
  tradeId: number,
  marketId: string,
  signal: ExtractedSignal,
  yesProbPct: number,
  enrichment: MarketEnrichment,
  crossMatches: CrossMarketMatch[],
  edgePct: number,
  direction: string,
  logPrefix: string,
): Promise<void> {
  try {
    const features = computeFeatures(
      signal, yesProbPct, enrichment,
      crossMatches, enrichment.calibrationBias?.avgEdgeBias ?? 0,
    );
    await insertTradeFeatures(tradeId, marketId, features as unknown as Record<string, unknown>, edgePct, direction, yesProbPct);
  } catch (e) {
    console.warn(`[${logPrefix}] Failed to save trade features for trade #${tradeId}:`, e);
  }
}

// Saves a second feature snapshot at exit time for model-driven stops.
// Lets the training pipeline compare what changed between open and close.
// Resolution exits are intentionally excluded — no model decision was made.
async function saveExitSnapshot(
  tradeId: number,
  signal: ExtractedSignal,
  yesProbPct: number,
  enrichment: MarketEnrichment,
  crossMatches: CrossMarketMatch[],
  edgePct: number,
  closeReason: string,
  logPrefix: string,
): Promise<void> {
  try {
    const features = computeFeatures(
      signal, yesProbPct, enrichment,
      crossMatches, enrichment.calibrationBias?.avgEdgeBias ?? 0,
    );
    await updateTradeExitSnapshot(
      tradeId,
      features as unknown as Record<string, unknown>,
      edgePct,
      yesProbPct,
      closeReason,
    );
  } catch (e) {
    console.warn(`[${logPrefix}] Failed to save exit snapshot for trade #${tradeId}:`, e);
  }
}

export async function runScanPipeline(onProgress?: ScanProgressCallback): Promise<{
  marketsScanned: number;
  analyzed: number;
  totalTracked: number;
}> {
  const emit = onProgress ?? (() => {});

  // Acquire Postgres advisory lock
  const acquired = await acquireScanLock();
  if (!acquired) {
    const msg = "Scan already in progress. Please wait.";
    emit({ phase: "error", message: msg });
    throw new Error(msg);
  }

  try {
    const scanErrors: ScanError[] = [];

    // 1. Process resolutions first
    emit({ phase: "fetching", message: "Checking for resolved markets..." });
    try {
      const resResult = await processResolvedMarkets();
      if (resResult.resolved > 0) {
        console.log(`[pipeline] Resolved ${resResult.resolved} markets`);
      }
    } catch (err) {
      console.error("[pipeline] Resolution check failed:", err);
    }

    // 2. Fetch markets
    emit({ phase: "fetching", message: "Fetching Polymarket markets (10-90%, ≤90 days)..." });
    console.log("[pipeline] Fetching Polymarket markets...");
    const filtered = await fetchFilteredMarkets(scanErrors);
    console.log(`[pipeline] Found ${filtered.length} qualifying markets`);
    emit({ phase: "fetching", message: `Found ${filtered.length} qualifying markets`, total: filtered.length });

    if (filtered.length === 0) {
      const store = await getMarketStore();
      const result = { marketsScanned: 0, analyzed: 0, totalTracked: store.markets.length };
      emit({ phase: "done", result });
      return result;
    }

    // 3. Upsert all markets
    await Promise.all(filtered.map(m => upsertMarket(m)));

    // 4. Load existing price history for context
    const store = await getMarketStore();
    const existingHistoryMap = new Map(
      store.markets.map(m => [m.id, m.history])
    );

    emit({ phase: "analyzing", current: 0, total: filtered.length, message: "Fetching enrichment data..." });

    // 5. Fetch enrichment per market (orderbook, FRED, crypto) concurrently
    const enrichmentMap = new Map<string, MarketEnrichment>();
    const ENRICHMENT_CONCURRENCY = 5;
    for (let i = 0; i < filtered.length; i += ENRICHMENT_CONCURRENCY) {
      const batch = filtered.slice(i, i + ENRICHMENT_CONCURRENCY);
      await Promise.all(batch.map(async m => {
        const history = existingHistoryMap.get(m.id);
        const enrichment = await fetchEnrichment(m, history);
        enrichmentMap.set(m.id, enrichment);
      }));
    }

    emit({ phase: "analyzing", current: 0, total: filtered.length, message: "Running batched Claude analysis..." });
    console.log(`[pipeline] Running batched signal extraction (${filtered.length} markets, 10/batch)...`);

    // 6. Extract signals in batches of 10
    const signalResults = await extractSignalsBatch(filtered, enrichmentMap, scanErrors);
    console.log(`[pipeline] Got ${signalResults.size} signal results`);

    let analyzed = 0;

    // 7. Pre-fetch all open trades once for edge decay checks
    const allOpenTrades = await getOpenTrades();
    const openTradesByMarket = new Map(allOpenTrades.map(t => [t.marketId, t]));

    // 8. Process each signal result
    const priceHistoryBatch: Array<{ marketId: string; marketProb: number; fairProb?: number }> = [];
    const touchedMarketIds: string[] = [];

    for (const market of filtered) {
      const result = signalResults.get(market.id);
      if (!result) continue;

      // Compute Bayesian posterior
      const lr = signalsToLikelihoodRatio(result.signal.newsSignals);
      const posteriorProb = bayesianUpdate(market.yesProbPct, lr);
      const edgePct = Math.round((posteriorProb - market.yesProbPct) * 10) / 10;
      const ci = credibleInterval(posteriorProb, result.signal.newsSignals.length);

      const direction = edgePct >= 0 ? "YES" : "NO";
      const absEdge = Math.abs(edgePct);
      const confidence = edgeToConfidence(absEdge);

      // Insert signal
      await insertSignal({
        marketId: market.id,
        priorProb: market.yesProbPct,
        posteriorProb,
        likelihoodRatio: lr,
        edgePct,
        direction,
        confidence,
        reasoning: result.reasoning,
        keyFactors: result.keyFactors,
        newsSignals: result.signal.newsSignals,
        newsAge: result.newsAge,
        topFact: result.topFact,
        sources: result.sources,
        triggerType: "full_scan",
      });

      // Collect for batch flushes after the loop
      priceHistoryBatch.push({ marketId: market.id, marketProb: market.yesProbPct, fairProb: posteriorProb });
      touchedMarketIds.push(market.id);

      // Exit rules: take profit / edge decay / time-based stop
      const existingTrade = openTradesByMarket.get(market.id);
      if (existingTrade) {
        const exit = checkExitRules(existingTrade, edgePct, market.yesProbPct);
        if (exit) {
          const pnl = computePnl(existingTrade, market.yesProbPct);
          await closeTrade(existingTrade.id, market.yesProbPct, pnl, exit.reason);
          openTradesByMarket.delete(market.id);
          console.log(`[pipeline] Exit (${exit.exitLabel}): closed trade #${existingTrade.id} on "${market.question.slice(0, 40)}" (P&L=$${pnl})`);
          // Save exit snapshot for training — captures what the model saw when it lost conviction
          await saveExitSnapshot(
            existingTrade.id, result.signal, market.yesProbPct,
            enrichmentMap.get(market.id) ?? {}, result.crossMatches,
            edgePct, exit.reason, "pipeline",
          );
          // Don't reopen on the same scan cycle that triggered the close
          continue;
        }
      }

      // Paper trading: open position if edge is actionable and none open
      if (absEdge >= EDGE_OPEN_THRESHOLD_PP && confidence !== "low") {
        if (!openTradesByMarket.has(market.id)) {
          const { notional } = kellySize(edgePct, confidence, market.yesProbPct, 10_000);
          const sizeUsd = Math.max(1, notional); // at least $1 if Kelly rounds to 0
          const tradeId = await openTrade({
            marketId: market.id,
            direction,
            entryProb: market.yesProbPct,
            entryEdge: edgePct,
            sizeUsd,
          });
          openTradesByMarket.set(market.id, {
            id: tradeId,
            marketId: market.id,
            direction,
            entryProb: market.yesProbPct,
            entryEdge: edgePct,
            sizeUsd,
            openedAt: new Date().toISOString(),
          });
          console.log(`[pipeline] Opened paper trade: ${direction} on "${market.question.slice(0, 40)}" (edge=${edgePct > 0 ? "+" : ""}${edgePct}pp, size=$${sizeUsd})`);

          // Save feature vector for model training
          await saveTradeFeatures(
            tradeId, market.id, result.signal, market.yesProbPct,
            enrichmentMap.get(market.id) ?? {}, result.crossMatches,
            edgePct, direction, "pipeline",
          );
        }
      }

      analyzed++;
      emit({
        phase: "analyzing",
        current: analyzed,
        total: filtered.length,
        market: market.question.slice(0, 60),
        message: `Analyzed ${analyzed}/${filtered.length}`,
      });

      void ci; // credible interval available but not stored in this schema version
    }

    // Flush batched writes (2 queries for price history, 1 for scan timestamps)
    await batchAppendPriceHistory(priceHistoryBatch);
    await batchTouchMarketScan(touchedMarketIds);

    // 9. Update prices for markets NOT in this scan
    const scannedIds = new Set(filtered.map(m => m.id));
    const trackedStore = await getMarketStore();
    const unscanned = trackedStore.markets.filter(m => !scannedIds.has(m.id) && !m.resolved);

    if (unscanned.length > 0) {
      emit({ phase: "saving", message: `Updating prices for ${unscanned.length} other tracked markets...` });
      console.log(`[pipeline] Updating prices for ${unscanned.length} other tracked markets...`);

      const PRICE_BATCH = 5;
      const unscannedPriceBatch: Array<{ marketId: string; marketProb: number }> = [];

      for (let i = 0; i < unscanned.length; i += PRICE_BATCH) {
        const batch = unscanned.slice(i, i + PRICE_BATCH);
        await Promise.allSettled(batch.map(async m => {
          const price = await fetchMarketPrice(m.id);
          if (price !== null) {
            await updateMarketPrice(m.id, price);
            unscannedPriceBatch.push({ marketId: m.id, marketProb: price });
          }
        }));
        if (i + PRICE_BATCH < unscanned.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Batch-insert all collected price history in one shot
      await batchAppendPriceHistory(unscannedPriceBatch);
    }

    const finalStore = await getMarketStore();
    const result = {
      marketsScanned: filtered.length,
      analyzed,
      totalTracked: finalStore.markets.length,
    };

    if (scanErrors.length > 0) {
      console.log(`[pipeline] Scan completed with ${scanErrors.length} warnings:`,
        scanErrors.map(e => `${e.source}: ${e.message}`).join("; "));
    }
    console.log(`[pipeline] Done. Tracking ${finalStore.markets.length} markets total.`);

    emit({ phase: "done", result });
    return result;
  } finally {
    await releaseScanLock();
  }
}

// ─── Fast re-analysis for news-triggered updates ──────────────────────────────

export async function reanalyzeMarket(marketId: string): Promise<void> {
  const store = await getMarketStore();
  const tracked = store.markets.find(m => m.id === marketId);
  if (!tracked || tracked.resolved) return;

  const market = {
    id: tracked.id,
    question: tracked.title,
    description: undefined as string | undefined,
    resolutionSource: undefined as string | undefined,
    url: tracked.url,
    category: tracked.category,
    yesProbPct: tracked.marketProb,
    volume: tracked.volume,
    endDate: tracked.endDate,
    endDateIso: tracked.endDateIso ?? "",
    daysUntilResolution: tracked.daysUntilResolution,
  };

  const enrichment = await fetchEnrichment(market, tracked.history);
  const errors: ScanError[] = [];
  const batchResults = await extractSignalsBatch([market], new Map([[market.id, enrichment]]), errors);
  const result = batchResults.get(marketId);
  if (!result) return;

  const lr = signalsToLikelihoodRatio(result.signal.newsSignals);
  const posteriorProb = bayesianUpdate(market.yesProbPct, lr);
  const edgePct = Math.round((posteriorProb - market.yesProbPct) * 10) / 10;
  const direction = edgePct >= 0 ? "YES" : "NO";
  const absEdge = Math.abs(edgePct);
  const confidence = edgeToConfidence(absEdge);

  await insertSignal({
    marketId,
    priorProb: market.yesProbPct,
    posteriorProb,
    likelihoodRatio: lr,
    edgePct,
    direction,
    confidence,
    reasoning: result.reasoning,
    keyFactors: result.keyFactors,
    newsSignals: result.signal.newsSignals,
    newsAge: result.newsAge,
    topFact: result.topFact,
    sources: result.sources,
    triggerType: "news_triggered",
  });

  await appendPriceHistory(marketId, market.yesProbPct, posteriorProb);
  await touchMarketScan(marketId);

  // Exit rules: take profit / edge decay / time-based stop
  const openTrades = await getOpenTrades();
  const existingTrade = openTrades.find(t => t.marketId === marketId);
  if (existingTrade) {
    const exit = checkExitRules(existingTrade, edgePct, market.yesProbPct);
    if (exit) {
      const pnl = computePnl(existingTrade, market.yesProbPct);
      await closeTrade(existingTrade.id, market.yesProbPct, pnl, exit.reason);
      console.log(`[reanalyze] Exit (${exit.exitLabel}): closed trade #${existingTrade.id} (P&L=$${pnl})`);
      // Save exit snapshot for training
      await saveExitSnapshot(
        existingTrade.id, result.signal, market.yesProbPct,
        enrichment, result.crossMatches,
        edgePct, exit.reason, "reanalyze",
      );
      return; // don't re-open on same cycle that triggered the close
    }
  }

  // Open paper trade on news-triggered re-analysis too
  if (absEdge >= EDGE_OPEN_THRESHOLD_PP && confidence !== "low") {
    const alreadyOpen = openTrades.some(t => t.marketId === marketId);
    if (!alreadyOpen) {
      const { notional } = kellySize(edgePct, confidence, market.yesProbPct, 10_000);
      const tradeId = await openTrade({
        marketId,
        direction,
        entryProb: market.yesProbPct,
        entryEdge: edgePct,
        sizeUsd: Math.max(1, notional),
      });

      // Save feature vector for model training
      await saveTradeFeatures(
        tradeId, marketId, result.signal, market.yesProbPct,
        enrichment, result.crossMatches,
        edgePct, direction, "reanalyze",
      );
    }
  }

  console.log(`[reanalyze] ${market.question.slice(0, 40)}: edge=${edgePct > 0 ? "+" : ""}${edgePct}pp (lr=${lr.toFixed(2)})`);
}

// Keep old name for news-monitor compat
export async function runFastReanalysis(marketIds: string[]): Promise<{ marketsReanalyzed: number }> {
  let marketsReanalyzed = 0;
  for (const id of marketIds) {
    try {
      await reanalyzeMarket(id);
      marketsReanalyzed++;
    } catch (err) {
      console.error(`[fast-reanalysis] Error for market ${id}:`, err);
    }
  }
  return { marketsReanalyzed };
}
