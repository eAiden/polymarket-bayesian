import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { kvGet, kvSet } from "./kv";
import type { MarketStore, TrackedMarket, AnalyzedMarket, DailySnapshot } from "./types";
import { fetchMarketPrice } from "./polymarket";
import {
  loadCalibrationRecords,
  appendCalibrationRecord,
  buildCalibrationRecord,
  computeSummary,
} from "./calibration";
import { markSnapshotsResolved } from "./signal-log";
import { closePosition, updatePosition, loadPaperTrading } from "./paper-trading";

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "markets.json");
const LOCK_FILE = join(DATA_DIR, ".scan-lock");
const MAX_HISTORY = 60;
const PRUNE_RESOLVED_AFTER_DAYS = 30;

// ─── Atomic write helper ─────────────────────────────────────────────────────
// Write to .tmp first, then rename. Rename is atomic on POSIX/NTFS — prevents
// corrupted JSON if the process crashes mid-write.

function atomicWriteJson(filePath: string, data: unknown): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

// ─── File-based scan lock ────────────────────────────────────────────────────
// Survives server restarts (unlike the old in-memory `let lastScanAt`).
// Lock expires after 10 minutes (if process died mid-scan without cleanup).

const LOCK_EXPIRY_MS = 10 * 60 * 1000;
const LOCK_COOLDOWN_MS = 60 * 1000;

export function acquireScanLock(): { acquired: boolean; reason?: string } {
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, "utf-8");
      const lock = JSON.parse(raw) as { pid: number; startedAt: number };
      const age = Date.now() - lock.startedAt;
      if (age < LOCK_EXPIRY_MS) {
        if (age < LOCK_COOLDOWN_MS) {
          return { acquired: false, reason: `Scan in progress (started ${Math.round(age / 1000)}s ago). Wait ${Math.round((LOCK_COOLDOWN_MS - age) / 1000)}s.` };
        }
        return { acquired: false, reason: `Scan already running (PID ${lock.pid}, ${Math.round(age / 1000)}s ago)` };
      }
      // Lock expired — stale from a crashed process. Take it over.
    }
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
    return { acquired: true };
  } catch {
    return { acquired: true }; // fail-open: better to allow scan than block forever
  }
}

export function releaseScanLock(): void {
  try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function emptyStore(): MarketStore {
  return { lastScanAt: null, markets: [] };
}

export function loadStore(): MarketStore {
  try {
    if (!existsSync(DATA_FILE)) return emptyStore();
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.markets)) return emptyStore();
    const store = parsed as MarketStore;
    // Attach live calibration summary and paper trading on every load
    store.calibration = computeSummary(loadCalibrationRecords());
    store.paperTrading = loadPaperTrading();
    return store;
  } catch {
    return emptyStore();
  }
}

// Async variant — reads from KV (Vercel) or falls back to local file (Railway/dev).
export async function loadStoreAsync(): Promise<MarketStore> {
  const kvStore = await kvGet<MarketStore>("markets");
  if (kvStore) return kvStore;
  return loadStore();
}

export function saveStore(store: MarketStore): void {
  try {
    atomicWriteJson(DATA_FILE, store);
    // Sync to KV: attach calibration + paper trading so Vercel gets the full payload
    const full: MarketStore = {
      ...store,
      calibration: computeSummary(loadCalibrationRecords()),
      paperTrading: loadPaperTrading(),
    };
    kvSet("markets", full);
  } catch (err) {
    console.error("[storage] Failed to save store:", err);
  }
}

export function mergeNewAnalysis(
  existing: MarketStore,
  newAnalysis: AnalyzedMarket[],
): MarketStore {
  const now = new Date().toISOString();

  const marketMap = new Map<string, TrackedMarket>(
    existing.markets.map((m) => [m.id, { ...m }])
  );

  for (const analyzed of newAnalysis) {
    const existing = marketMap.get(analyzed.id);
    const snapshot: DailySnapshot = {
      date: now,
      marketProb: analyzed.marketProb,
      fairProb: analyzed.fairProb,
    };

    if (existing) {
      // Update existing tracked market — always append new snapshot to capture movement
      const history = [...existing.history];
      const lastPrice = history.length > 0 ? history[history.length - 1].marketProb : null;
      if (lastPrice !== analyzed.marketProb) {
        history.push(snapshot);
      } else {
        // Price unchanged but update fairProb from new analysis
        history[history.length - 1] = snapshot;
      }

      marketMap.set(analyzed.id, {
        ...analyzed,
        firstSeen: existing.firstSeen,
        lastUpdated: now,
        history: history.slice(-MAX_HISTORY),
        resolved: existing.resolved,
        resolutionOutcome: existing.resolutionOutcome,
      });
    } else {
      // New market
      marketMap.set(analyzed.id, {
        ...analyzed,
        firstSeen: now,
        lastUpdated: now,
        history: [snapshot],
        resolved: false,
      });
    }
  }

  // Prune markets that have resolved (past end date) and are old enough
  const cutoff = Date.now() - PRUNE_RESOLVED_AFTER_DAYS * 86_400_000;
  const markets = Array.from(marketMap.values()).filter((m) => {
    if (!m.resolved) return true;
    const lastDate = new Date(m.lastUpdated).getTime();
    return lastDate > cutoff;
  });

  return {
    lastScanAt: now,
    markets,
  };
}

export function toggleSaved(id: string): boolean {
  const store = loadStore();
  const market = store.markets.find((m) => m.id === id);
  if (!market) return false;
  market.saved = !market.saved;
  saveStore(store);
  return true;
}

// Update current prices for all tracked markets without re-running AI analysis.
// Called daily for markets that weren't in the latest analysis batch.
export async function updatePricesOnly(store: MarketStore): Promise<MarketStore> {
  const now = new Date().toISOString();
  const updated: TrackedMarket[] = [];

  const BATCH = 5;
  for (let i = 0; i < store.markets.length; i += BATCH) {
    const batch = store.markets.slice(i, i + BATCH);
    const prices = await Promise.allSettled(batch.map((m) => fetchMarketPrice(m.id)));

    for (let j = 0; j < batch.length; j++) {
      const market = { ...batch[j] };
      const priceResult = prices[j];

      if (priceResult.status === "fulfilled" && priceResult.value !== null) {
        const newPrice = priceResult.value;

        // Detect fresh resolution — price just crossed threshold
        if (!market.resolved && (newPrice <= 2 || newPrice >= 98)) {
          market.resolved = true;
          const outcome: 1 | 0 = newPrice >= 98 ? 1 : 0;
          // Use the most recent fair estimate from scan history
          const lastFairSnap = [...market.history].reverse().find((s) => s.fairProb != null);
          if (lastFairSnap?.fairProb != null) {
            appendCalibrationRecord(
              buildCalibrationRecord(
                market.id,
                market.title,
                lastFairSnap.fairProb,
                lastFairSnap.marketProb,
                outcome,
                now,
                market.direction,
              )
            );
            console.log(`[calibration] Recorded: "${market.title.slice(0, 40)}" → outcome=${outcome}, fairProb=${lastFairSnap.fairProb}%`);
          }

          // Close paper trading position
          const closedPos = closePosition(market.id, outcome, newPrice);
          if (closedPos) {
            console.log(`[paper] Closed position on "${market.title.slice(0, 40)}" → P&L: $${closedPos.pnl}`);
          }

          // Backfill signal snapshots
          const snapshotsUpdated = markSnapshotsResolved(market.id, outcome, now, newPrice);
          if (snapshotsUpdated > 0) {
            console.log(`[signal-log] Resolved ${snapshotsUpdated} snapshots for "${market.title.slice(0, 40)}"`);
          }
        }

        // Always append a new snapshot on each refresh to track all movement
        const history = [...market.history];
        const lastPrice = history.length > 0 ? history[history.length - 1].marketProb : null;
        if (lastPrice !== newPrice) {
          // Only append if price actually changed (avoids duplicate identical entries)
          history.push({ date: now, marketProb: newPrice });
          market.history = history.slice(-MAX_HISTORY);
        }

        market.marketProb = newPrice;
        market.edge = market.fairProb - newPrice;
        market.lastUpdated = now;

        // Update open paper position with current price (tracks unrealized P&L, triggers stops)
        if (!market.resolved) {
          const posUpdate = updatePosition(market.id, newPrice, market.edge, market.confidence ?? "low", undefined);
          if (posUpdate.action === "stopped") {
            console.log(`[storage] Position stopped on "${market.title.slice(0, 40)}": ${posUpdate.reason}`);
          }
        }
      } else if (market.endDateIso && new Date(market.endDateIso) < new Date()) {
        // Market has passed its end date and we couldn't fetch price — mark as resolved
        market.resolved = true;
      }

      updated.push(market);
    }

    if (i + BATCH < store.markets.length) await new Promise((r) => setTimeout(r, 200));
  }

  return { ...store, markets: updated };
}
