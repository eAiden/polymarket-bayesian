// Orchestrates the full scan pipeline using DB-backed approach.
// Replaces the old file + KV approach.

import type { ScanEvent, ScanError } from "./types";
import { fetchFilteredMarkets, fetchMarketPrice } from "./polymarket";
import { kellySize } from "./paper-trading";
import {
  acquireScanLock, releaseScanLock, upsertMarket,
  insertSignal, appendPriceHistory, touchMarketScan,
  getMarketStore, openTrade, getOpenTrades, closeTrade,
  updateMarketPrice,
} from "./db";
import { signalsToLikelihoodRatio, bayesianUpdate, credibleInterval } from "./bayesian";
import { fetchEnrichment, extractSignalsBatch } from "./signal-extraction";
import { processResolvedMarkets } from "./resolution";
import type { MarketEnrichment } from "./types";

export type ScanProgressCallback = (event: ScanEvent) => void;

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
      const confidence = absEdge >= 10 ? "high" : absEdge >= 5 ? "medium" : "low";

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

      // Append price history
      await appendPriceHistory(market.id, market.yesProbPct, posteriorProb);

      // Touch last_scan_at
      await touchMarketScan(market.id);

      // Edge decay stop: close trade if edge flipped or fell below 2pp
      const existingTrade = openTradesByMarket.get(market.id);
      if (existingTrade) {
        const edgeFlipped = (existingTrade.direction === "YES" && edgePct < 0) ||
                            (existingTrade.direction === "NO" && edgePct > 0);
        const edgeGone = absEdge < 2;
        if (edgeFlipped || edgeGone) {
          const currentSharePrice = existingTrade.direction === "YES" ? market.yesProbPct : 100 - market.yesProbPct;
          const entrySharePrice = existingTrade.direction === "YES" ? existingTrade.entryProb : 100 - existingTrade.entryProb;
          const pnl = entrySharePrice > 0
            ? Math.round(existingTrade.sizeUsd * (currentSharePrice - entrySharePrice) / entrySharePrice * 100) / 100
            : 0;
          await closeTrade(existingTrade.id, market.yesProbPct, pnl, "edge_decay");
          openTradesByMarket.delete(market.id);
          const reason = edgeFlipped ? "edge flipped" : "edge < 2pp";
          console.log(`[pipeline] Edge decay (${reason}): closed trade #${existingTrade.id} on "${market.question.slice(0, 40)}" (edge=${edgePct > 0 ? "+" : ""}${edgePct}pp, P&L=$${pnl})`);
        }
      }

      // Paper trading: open position if edge is actionable and none open
      if (absEdge >= 5 && confidence !== "low") {
        if (!openTradesByMarket.has(market.id)) {
          const { notional } = kellySize(edgePct, confidence, market.yesProbPct, 10_000);
          const sizeUsd = Math.max(1, notional); // at least $1 if Kelly rounds to 0
          await openTrade({
            marketId: market.id,
            direction,
            entryProb: market.yesProbPct,
            entryEdge: edgePct,
            sizeUsd,
          });
          openTradesByMarket.set(market.id, { marketId: market.id, direction } as any);
          console.log(`[pipeline] Opened paper trade: ${direction} on "${market.question.slice(0, 40)}" (edge=${edgePct > 0 ? "+" : ""}${edgePct}pp, size=$${sizeUsd})`);
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

    // 8. Update prices for markets NOT in this scan
    const scannedIds = new Set(filtered.map(m => m.id));
    const trackedStore = await getMarketStore();
    const unscanned = trackedStore.markets.filter(m => !scannedIds.has(m.id) && !m.resolved);

    if (unscanned.length > 0) {
      emit({ phase: "saving", message: `Updating prices for ${unscanned.length} other tracked markets...` });
      console.log(`[pipeline] Updating prices for ${unscanned.length} other tracked markets...`);

      const PRICE_BATCH = 5;
      for (let i = 0; i < unscanned.length; i += PRICE_BATCH) {
        const batch = unscanned.slice(i, i + PRICE_BATCH);
        await Promise.allSettled(batch.map(async m => {
          const price = await fetchMarketPrice(m.id);
          if (price !== null) {
            await updateMarketPrice(m.id, price);
            await appendPriceHistory(m.id, price);
          }
        }));
        if (i + PRICE_BATCH < unscanned.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
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
  const confidence = absEdge >= 10 ? "high" : absEdge >= 5 ? "medium" : "low";

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

  // Edge decay stop: close trade if edge flipped or fell below 2pp
  const openTrades = await getOpenTrades();
  const existingTrade = openTrades.find(t => t.marketId === marketId);
  if (existingTrade) {
    const edgeFlipped = (existingTrade.direction === "YES" && edgePct < 0) ||
                        (existingTrade.direction === "NO" && edgePct > 0);
    const edgeGone = absEdge < 2;
    if (edgeFlipped || edgeGone) {
      const currentSharePrice = existingTrade.direction === "YES" ? market.yesProbPct : 100 - market.yesProbPct;
      const entrySharePrice = existingTrade.direction === "YES" ? existingTrade.entryProb : 100 - existingTrade.entryProb;
      const pnl = entrySharePrice > 0
        ? Math.round(existingTrade.sizeUsd * (currentSharePrice - entrySharePrice) / entrySharePrice * 100) / 100
        : 0;
      await closeTrade(existingTrade.id, market.yesProbPct, pnl, "edge_decay");
      const reason = edgeFlipped ? "edge flipped" : "edge < 2pp";
      console.log(`[reanalyze] Edge decay (${reason}): closed trade #${existingTrade.id} (edge=${edgePct > 0 ? "+" : ""}${edgePct}pp, P&L=$${pnl})`);
      return; // don't re-open on same reanalysis that triggered the close
    }
  }

  // Open paper trade on news-triggered re-analysis too
  if (absEdge >= 5 && confidence !== "low") {
    const alreadyOpen = openTrades.some(t => t.marketId === marketId);
    if (!alreadyOpen) {
      const { notional } = kellySize(edgePct, confidence, market.yesProbPct, 10_000);
      await openTrade({
        marketId,
        direction,
        entryProb: market.yesProbPct,
        entryEdge: edgePct,
        sizeUsd: Math.max(1, notional),
      });
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
