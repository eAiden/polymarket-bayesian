// News monitor: polls for new headlines relevant to tracked markets.
// Triggers fast re-analysis when significant new news is detected.
// Designed to run every 5 minutes via cron.

import type { TrackedMarket, NewsAlert } from "./types";
import { fetchNewsForMarket } from "./news";
import { getMarketStore, insertNewsAlert, getNewsAlerts } from "./db";
import { runFastReanalysis } from "./pipeline";

const NEWS_RELEVANCE_THRESHOLD = 50;
const MAX_MARKETS_TO_MONITOR = 10;

// ─── In-memory seen headlines (resets on restart — acceptable since DB tracks alerts) ──

const seenHeadlines = new Set<string>();

// ─── Select markets to monitor ──────────────────────────────────────────────

function selectMarketsToMonitor(markets: TrackedMarket[]): TrackedMarket[] {
  return markets
    .filter(m => !m.resolved)
    .sort((a, b) => {
      // Politics first
      const aPol = a.category === "Politics" ? 1 : 0;
      const bPol = b.category === "Politics" ? 1 : 0;
      if (aPol !== bPol) return bPol - aPol;
      // Then by absolute edge
      return Math.abs(b.edge) - Math.abs(a.edge);
    })
    .slice(0, MAX_MARKETS_TO_MONITOR);
}

// ─── Load alerts (from DB) ──────────────────────────────────────────────────

export async function loadAlertsAsync(): Promise<NewsAlert[]> {
  return getNewsAlerts(200);
}

// Keep sync version as no-op for any remaining callers
export function loadAlerts(): NewsAlert[] {
  return [];
}

// ─── Core monitor function ──────────────────────────────────────────────────

export async function runNewsMonitor(): Promise<{
  marketsChecked: number;
  alertsFound: number;
  marketsReanalyzed: number;
}> {
  // Pre-populate seenHeadlines from DB on first run so we don't re-fire
  // every past headline as "new" after a Railway restart/redeploy.
  if (seenHeadlines.size === 0) {
    const recent = await getNewsAlerts(500);
    for (const a of recent) {
      seenHeadlines.add(`${a.headline}|${a.source}`.toLowerCase());
    }
    if (recent.length > 0) {
      console.log(`[news-monitor] Pre-loaded ${seenHeadlines.size} seen headlines from DB`);
    }
  }

  const store = await getMarketStore();
  if (store.markets.length === 0) {
    return { marketsChecked: 0, alertsFound: 0, marketsReanalyzed: 0 };
  }

  const monitored = selectMarketsToMonitor(store.markets);
  const marketsToReanalyze: string[] = [];
  let alertsFound = 0;

  console.log(`[news-monitor] Checking ${monitored.length} markets for new headlines...`);

  for (const market of monitored) {
    try {
      const headlines = await fetchNewsForMarket(market.title, market.daysUntilResolution, []);

      for (const h of headlines) {
        const fingerprint = `${h.title}|${h.source}`.toLowerCase();
        if (seenHeadlines.has(fingerprint)) continue;

        seenHeadlines.add(fingerprint);

        if ((h.score ?? 0) >= NEWS_RELEVANCE_THRESHOLD) {
          await insertNewsAlert({
            marketId: market.id,
            marketQuestion: market.title,
            headline: h.title,
            source: h.source ?? "Unknown",
            relevanceScore: h.score ?? 0,
          });

          alertsFound++;

          if (!marketsToReanalyze.includes(market.id)) {
            marketsToReanalyze.push(market.id);
          }
        }
      }
    } catch (err) {
      console.warn(`[news-monitor] Failed to check "${market.title.slice(0, 40)}": ${err}`);
    }

    // Small delay between markets to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  // Keep seenHeadlines from growing unbounded (cap at 2000)
  if (seenHeadlines.size > 2000) {
    const arr = [...seenHeadlines].slice(-2000);
    seenHeadlines.clear();
    arr.forEach(h => seenHeadlines.add(h));
  }

  if (alertsFound > 0) {
    console.log(`[news-monitor] ${alertsFound} new alerts found for ${marketsToReanalyze.length} markets`);

    const result = await runFastReanalysis(marketsToReanalyze);
    console.log(`[news-monitor] Re-analyzed ${result.marketsReanalyzed} markets`);

    return {
      marketsChecked: monitored.length,
      alertsFound,
      marketsReanalyzed: result.marketsReanalyzed,
    };
  }

  console.log(`[news-monitor] No new relevant headlines found`);
  return { marketsChecked: monitored.length, alertsFound: 0, marketsReanalyzed: 0 };
}
