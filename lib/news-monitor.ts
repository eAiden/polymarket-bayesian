// News monitor: polls for new headlines relevant to tracked markets.
// Triggers fast re-analysis when significant new news is detected.
// Designed to run every 5 minutes via cron.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import type { TrackedMarket, NewsAlert } from "./types";
import { fetchNewsForMarket } from "./news";
import { loadStore } from "./storage";
import { runFastReanalysis } from "./pipeline";
import { kvGet, kvSet } from "./kv";

const DATA_DIR = join(process.cwd(), "data");
const SEEN_FILE = join(DATA_DIR, "seen-headlines.json");
const ALERTS_FILE = join(DATA_DIR, "news-alerts.json");

const NEWS_RELEVANCE_THRESHOLD = 50;
const MAX_MARKETS_TO_MONITOR = 10;
const MAX_ALERTS_STORED = 200;

// ─── Seen headlines tracking ────────────────────────────────────────────────

function loadSeenHeadlines(): Set<string> {
  try {
    if (!existsSync(SEEN_FILE)) return new Set();
    const arr = JSON.parse(readFileSync(SEEN_FILE, "utf-8")) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeenHeadlines(seen: Set<string>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // Keep only last 2000 headlines to prevent unbounded growth
  const arr = [...seen].slice(-2000);
  const tmp = SEEN_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(arr), "utf-8");
  renameSync(tmp, SEEN_FILE);
}

// ─── Alerts storage ─────────────────────────────────────────────────────────

export function loadAlerts(): NewsAlert[] {
  try {
    if (!existsSync(ALERTS_FILE)) return [];
    return JSON.parse(readFileSync(ALERTS_FILE, "utf-8")) as NewsAlert[];
  } catch {
    return [];
  }
}

export async function loadAlertsAsync(): Promise<NewsAlert[]> {
  const kv = await kvGet<NewsAlert[]>("news-alerts");
  if (kv) return kv;
  return loadAlerts();
}

function appendAlerts(newAlerts: NewsAlert[]): void {
  if (newAlerts.length === 0) return;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const existing = loadAlerts();
  const all = [...existing, ...newAlerts].slice(-MAX_ALERTS_STORED);
  const tmp = ALERTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 2), "utf-8");
  renameSync(tmp, ALERTS_FILE);
  kvSet("news-alerts", all);
}

// ─── Select markets to monitor ──────────────────────────────────────────────

function selectMarketsToMonitor(markets: TrackedMarket[]): TrackedMarket[] {
  // Filter: unresolved, politics first (MVP focus), then by edge magnitude
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

// ─── Core monitor function ──────────────────────────────────────────────────

export async function runNewsMonitor(): Promise<{
  marketsChecked: number;
  alertsFound: number;
  marketsReanalyzed: number;
}> {
  const store = loadStore();
  if (store.markets.length === 0) {
    return { marketsChecked: 0, alertsFound: 0, marketsReanalyzed: 0 };
  }

  const monitored = selectMarketsToMonitor(store.markets);
  const seen = loadSeenHeadlines();
  const alerts: NewsAlert[] = [];
  const marketsToReanalyze: string[] = [];

  console.log(`[news-monitor] Checking ${monitored.length} markets for new headlines...`);

  for (const market of monitored) {
    try {
      const headlines = await fetchNewsForMarket(market.title, market.daysUntilResolution, []);

      for (const h of headlines) {
        // Create a fingerprint from title + source
        const fingerprint = `${h.title}|${h.source}`.toLowerCase();
        if (seen.has(fingerprint)) continue;

        seen.add(fingerprint);

        // Check relevance
        if ((h.score ?? 0) >= NEWS_RELEVANCE_THRESHOLD) {
          alerts.push({
            marketId: market.id,
            marketQuestion: market.title,
            headline: h.title,
            source: h.source ?? "Unknown",
            relevanceScore: h.score ?? 0,
            triggeredAt: new Date().toISOString(),
          });

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

  saveSeenHeadlines(seen);

  if (alerts.length > 0) {
    appendAlerts(alerts);
    console.log(`[news-monitor] ${alerts.length} new alerts found for ${marketsToReanalyze.length} markets`);

    // Trigger fast re-analysis
    const result = await runFastReanalysis(marketsToReanalyze);
    console.log(`[news-monitor] Re-analyzed ${result.marketsReanalyzed} markets`);

    return {
      marketsChecked: monitored.length,
      alertsFound: alerts.length,
      marketsReanalyzed: result.marketsReanalyzed,
    };
  }

  console.log(`[news-monitor] No new relevant headlines found`);
  return { marketsChecked: monitored.length, alertsFound: 0, marketsReanalyzed: 0 };
}
