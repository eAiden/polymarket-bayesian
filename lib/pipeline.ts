// Shared scan pipeline — used by both /api/scan and the daily cron scheduler.
// Also exports fast re-analysis for news-triggered updates.
import type { ScanEvent, ScanError } from "./types";
import { fetchFilteredMarkets } from "./polymarket";
import { analyzeMarkets } from "./analysis";
import { loadStore, mergeNewAnalysis, updatePricesOnly, saveStore, acquireScanLock, releaseScanLock } from "./storage";
import { appendSignalSnapshot } from "./signal-log";
import { openPosition, updatePosition } from "./paper-trading";
import { extractSignals, fetchEnrichment } from "./signal-extraction";
import { computeFeatures } from "./features";
import { scoreMarket, loadWeights } from "./scoring";
import { loadCalibrationRecords, computeCategoryBias } from "./calibration";
import type { MarketEnrichment } from "./types";

export type ScanProgressCallback = (event: ScanEvent) => void;

export async function runScanPipeline(onProgress?: ScanProgressCallback): Promise<{
  marketsScanned: number;
  analyzed: number;
  totalTracked: number;
}> {
  const emit = onProgress ?? (() => {});

  // File-based lock — survives server restarts
  const lock = acquireScanLock();
  if (!lock.acquired) {
    emit({ phase: "error", message: lock.reason });
    throw new Error(lock.reason ?? "Scan already in progress. Please wait.");
  }

  try {
    const scanErrors: ScanError[] = [];

    emit({ phase: "fetching", message: "Fetching Polymarket markets (20-80%, ≤30 days)..." });
    console.log("[pipeline] Fetching Polymarket markets (20-80%, ≤30 days)...");
    const filtered = await fetchFilteredMarkets(scanErrors);
    console.log(`[pipeline] Found ${filtered.length} qualifying markets`);
    emit({ phase: "fetching", message: `Found ${filtered.length} qualifying markets`, total: filtered.length });

    if (filtered.length === 0) {
      const store = loadStore();
      const updated = await updatePricesOnly(store);
      saveStore(updated);
      const result = { marketsScanned: 0, analyzed: 0, totalTracked: updated.markets.length };
      emit({ phase: "done", result });
      return result;
    }

    // Load existing market history for price trend context
    const existingStore = loadStore();
    const existingHistoryMap = new Map(
      existingStore.markets.map(m => [m.id, m.history])
    );

    emit({ phase: "analyzing", current: 0, total: filtered.length, message: "Starting signal extraction via Claude..." });
    console.log("[pipeline] Running signal extraction + scoring...");

    const analyzed = await analyzeMarkets(filtered, (current, market) => {
      emit({
        phase: "analyzing",
        current,
        total: filtered.length,
        market: market.slice(0, 60),
        message: `Analyzing market ${current}/${filtered.length}`,
      });
    }, scanErrors, existingHistoryMap);
    console.log(`[pipeline] Scoring complete: ${analyzed.length} markets with edge`);

    emit({ phase: "consistency", message: `Analysis complete. ${analyzed.length} markets with actionable edge.` });

    // Update existing positions + open new ones for new edges
    for (const m of analyzed) {
      const conf = m.confidence ?? "low";

      // First, update any existing open position (triggers stop-loss/take-profit/edge-decay)
      const posUpdate = updatePosition(m.id, m.marketProb, m.edge, conf, m.topFact);
      if (posUpdate.action === "stopped") {
        console.log(`[pipeline] Position stopped on "${m.title.slice(0, 40)}": ${posUpdate.reason}`);
      }

      // Open new position if no existing one and edge is strong enough
      if (posUpdate.action === "none" && conf !== "low" && Math.abs(m.edge) >= 5) {
        openPosition(m.id, m.title, m.direction, m.marketProb, m.edge, conf);
      }
    }

    // Reload store (may have changed during scan) and merge
    const freshStore = loadStore();
    const merged = mergeNewAnalysis(freshStore, analyzed);

    // Update prices for tracked markets not covered in this scan
    const analyzedIds = new Set(analyzed.map((m) => m.id));
    const notScanned = {
      ...merged,
      markets: merged.markets.filter((m) => !analyzedIds.has(m.id)),
    };

    let finalStore = merged;
    if (notScanned.markets.length > 0) {
      emit({ phase: "saving", message: `Updating prices for ${notScanned.markets.length} other tracked markets...` });
      console.log(`[pipeline] Updating prices for ${notScanned.markets.length} other tracked markets...`);
      const priceUpdated = await updatePricesOnly(notScanned);
      const updatedMap = new Map(priceUpdated.markets.map((m) => [m.id, m]));
      finalStore = {
        ...merged,
        markets: merged.markets.map((m) => updatedMap.get(m.id) ?? m),
      };
    }

    // Persist scan health errors (last scan only)
    finalStore.scanHealth = scanErrors.length > 0 ? scanErrors : undefined;
    saveStore(finalStore);
    if (scanErrors.length > 0) {
      console.log(`[pipeline] Scan completed with ${scanErrors.length} warnings:`, scanErrors.map(e => `${e.source}: ${e.message}`).join("; "));
    }
    console.log(`[pipeline] Done. Tracking ${finalStore.markets.length} markets total.`);

    const result = {
      marketsScanned: filtered.length,
      analyzed: analyzed.length,
      totalTracked: finalStore.markets.length,
    };
    emit({ phase: "done", result });
    return result;
  } finally {
    releaseScanLock();
  }
}

// ─── Fast re-analysis for news-triggered updates ────────────────────────────
// No market discovery, no consistency check. Just: extract → score → save.
// Target: <30s per market.

export async function runFastReanalysis(
  marketIds: string[],
): Promise<{ marketsReanalyzed: number }> {
  const store = loadStore();
  const scanErrors: ScanError[] = [];

  // Load calibration bias
  const calibRecords = loadCalibrationRecords();
  const categoryBiasMap = new Map<string, MarketEnrichment["calibrationBias"]>();
  for (const cat of ["Crypto", "Politics", "Sports", "Economics", "Science", "Other"]) {
    const bias = computeCategoryBias(calibRecords, cat);
    if (bias) categoryBiasMap.set(cat, bias);
  }

  const weights = loadWeights();
  let reanalyzed = 0;

  for (const id of marketIds) {
    const tracked = store.markets.find(m => m.id === id);
    if (!tracked || tracked.resolved) continue;

    // Build a FilteredMarket-like object from TrackedMarket
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

    const result = await extractSignals(market, scanErrors, tracked.history, categoryBiasMap);
    if (!result) continue;

    const catBias = categoryBiasMap.get(market.category)?.avgEdgeBias ?? 0;
    const features = computeFeatures(result.signal, market.yesProbPct, result.enrichment, result.crossMatches, catBias);
    const score = scoreMarket(features, weights);

    // Ablation baseline score (same formula as analyzeMarkets)
    const baselineScore = features.newsAge
      * Math.max(0, 1 - features.daysToResolution / 30)
      * Math.min(1, features.volumeSpike / 3);

    // Log signal snapshot
    appendSignalSnapshot(
      market.id, market.yesProbPct, "news_triggered",
      result.signal, features, score, weights.version, baselineScore,
    );

    // Top fact: strongest signal aligned with direction, else first signal
    const mappedDir = score.direction === "YES" || score.direction === "NO" ? score.direction : (score.edge >= 0 ? "YES" : "NO") as "YES" | "NO";
    const topFact =
      result.signal.newsSignals.find(s => s.direction === mappedDir && s.strength === "strong")?.fact ??
      result.signal.newsSignals.find(s => s.direction === mappedDir)?.fact ??
      result.signal.newsSignals[0]?.fact;

    // Update tracked market with new score
    tracked.edge = score.edge;
    tracked.fairProb = Math.max(1, Math.min(99, Math.round(market.yesProbPct + score.edge)));
    tracked.confidence = score.confidence;
    tracked.confidenceInterval = undefined;
    tracked.lastUpdated = new Date().toISOString();

    // Update existing position (checks stop-loss, take-profit, edge decay)
    const posUpdate = updatePosition(market.id, market.yesProbPct, score.edge, score.confidence, topFact);
    if (posUpdate.action === "stopped") {
      console.log(`[fast-reanalysis] Position stopped: ${posUpdate.reason}`);
    }

    // Open paper position if warranted (only if no existing open position)
    if (posUpdate.action === "none" && score.confidence !== "low" && Math.abs(score.edge) >= 5) {
      const dir = score.direction === "YES" ? "YES" as const : "NO" as const;
      openPosition(market.id, market.question, dir, market.yesProbPct, score.edge, score.confidence);
    }

    reanalyzed++;
    console.log(`[fast-reanalysis] ${market.question.slice(0, 40)}: edge=${score.edge > 0 ? "+" : ""}${score.edge}pp`);
  }

  if (reanalyzed > 0) {
    saveStore(store);
  }

  return { marketsReanalyzed: reanalyzed };
}
