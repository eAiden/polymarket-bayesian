// One-shot backfill script: for every open trade that has no trade_features row
// (or whose features pre-date the calibration-bias wiring), recompute features
// from current enrichment and upsert a fresh snapshot.
//
// Usage: npx tsx scripts/backfill-trade-features.ts
//
// Safe to re-run — skips trades that already have a matching row.

import { sql, getOpenTrades, insertTradeFeatures, getCalibrationSummary } from "../lib/db";
import { fetchEnrichment, extractSignalsBatch } from "../lib/signal-extraction";
import { computeFeatures } from "../lib/features";
import { computeCategoryBias } from "../lib/calibration";
import type { FilteredMarket, MarketEnrichment, ScanError } from "../lib/types";

const MARKET_CATEGORIES = ["Crypto", "Politics", "Sports", "Economics", "Science", "Other"] as const;

async function buildCategoryBiasMap(): Promise<Map<string, MarketEnrichment["calibrationBias"]>> {
  const summary = await getCalibrationSummary();
  const map = new Map<string, MarketEnrichment["calibrationBias"]>();
  for (const cat of MARKET_CATEGORIES) {
    const bias = computeCategoryBias(summary.records, cat);
    if (bias) map.set(cat, bias);
  }
  return map;
}

async function main() {
  const db = sql();
  const openTrades = await getOpenTrades();
  console.log(`[backfill] Found ${openTrades.length} open trades`);

  // Find which open trades have NO trade_features row
  const tradeIds = openTrades.map(t => t.id);
  if (tradeIds.length === 0) {
    console.log("[backfill] Nothing to do.");
    return;
  }
  const existing = await db`
    SELECT trade_id FROM trade_features WHERE trade_id = ANY(${tradeIds})
  `;
  const haveFeatures = new Set(existing.map(r => r.trade_id as number));
  const missing = openTrades.filter(t => !haveFeatures.has(t.id));
  console.log(`[backfill] ${missing.length} trades missing feature snapshots`);

  if (missing.length === 0) return;

  // Load current market state for each missing trade's market
  const marketIds = [...new Set(missing.map(t => t.marketId))];
  const marketRows = await db`
    SELECT * FROM markets WHERE id = ANY(${marketIds})
  `;
  const marketById = new Map<string, FilteredMarket>(
    marketRows.map(m => [m.id as string, {
      id: m.id as string,
      question: m.question as string,
      description: (m.description as string | null) ?? undefined,
      resolutionSource: (m.resolution_source as string | null) ?? undefined,
      url: (m.url as string | null) ?? undefined,
      category: m.category as string,
      yesProbPct: m.yes_prob_pct as number,
      volume: (m.volume as string | null) ?? "",
      endDate: (m.end_date as string | null) ?? "",
      endDateIso: (m.end_date_iso as string | null) ?? "",
      daysUntilResolution: (m.days_until_resolution as number | null) ?? 0,
      bestBid: (m.best_bid as number | null) ?? undefined,
      bestAsk: (m.best_ask as number | null) ?? undefined,
      spread: (m.spread as number | null) ?? undefined,
      lastTradePrice: (m.last_trade_price as number | null) ?? undefined,
      volume24hr: (m.volume_24hr as number | null) ?? undefined,
      liquidity: (m.liquidity as number | null) ?? undefined,
    }]),
  );

  const biasMap = await buildCategoryBiasMap();
  const errors: ScanError[] = [];

  let ok = 0, fail = 0;
  for (const trade of missing) {
    const market = marketById.get(trade.marketId);
    if (!market) { fail++; console.warn(`[backfill] trade #${trade.id}: market ${trade.marketId} not found`); continue; }

    try {
      const enrichment = await fetchEnrichment(market, undefined, biasMap);
      const results = await extractSignalsBatch([market], new Map([[market.id, enrichment]]), errors);
      const result = results.get(market.id);
      if (!result) { fail++; console.warn(`[backfill] trade #${trade.id}: no signal extracted`); continue; }

      const features = computeFeatures(
        result.signal,
        market.yesProbPct,
        enrichment,
        result.crossMatches,
        enrichment.calibrationBias?.avgEdgeBias ?? 0,
      );
      await insertTradeFeatures(
        trade.id,
        trade.marketId,
        features as unknown as Record<string, unknown>,
        trade.entryEdge,
        trade.direction,
        trade.entryProb,
        "v1.0-backfill",
      );
      ok++;
      console.log(`[backfill] ✓ trade #${trade.id} (${market.question.slice(0, 50)})`);
    } catch (e) {
      fail++;
      console.error(`[backfill] ✗ trade #${trade.id}:`, e);
    }
  }

  console.log(`[backfill] Done. ok=${ok} fail=${fail}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
