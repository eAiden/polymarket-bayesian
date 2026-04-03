// Database layer — replaces file-based JSON storage + Upstash KV.
// Uses postgres.js (tagged template syntax).

import postgres from "postgres";
import type { FilteredMarket, TrackedMarket, MarketStore, NewsAlert } from "./types";
import type { CalibrationSummary } from "./calibration";
import type { PaperTradingState, PaperPosition } from "./paper-trading";
import type { NewsHeadline } from "./news";

const DATABASE_URL = process.env.DATABASE_URL;

// Lazy singleton — created on first use
let _sql: ReturnType<typeof postgres> | null = null;

export function sql(): ReturnType<typeof postgres> {
  if (!_sql) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
    _sql = postgres(DATABASE_URL, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  }
  return _sql;
}

// ─── Migration ────────────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  const db = sql();

  await db`
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      description TEXT,
      resolution_source TEXT,
      url TEXT,
      category TEXT NOT NULL DEFAULT 'Other',
      yes_prob_pct REAL NOT NULL,
      volume TEXT,
      end_date TEXT,
      end_date_iso TEXT,
      days_until_resolution INTEGER,
      best_bid REAL,
      best_ask REAL,
      spread REAL,
      last_trade_price REAL,
      volume_24hr REAL,
      liquidity REAL,
      last_scan_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      resolved_outcome SMALLINT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      saved BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      prior_prob REAL NOT NULL,
      posterior_prob REAL NOT NULL,
      likelihood_ratio REAL NOT NULL DEFAULT 1.0,
      edge_pct REAL NOT NULL,
      direction TEXT NOT NULL,
      confidence TEXT NOT NULL,
      reasoning TEXT,
      key_factors JSONB NOT NULL DEFAULT '{"bullish":[],"bearish":[]}',
      news_signals JSONB NOT NULL DEFAULT '[]',
      news_age TEXT,
      top_fact TEXT,
      sources TEXT[] NOT NULL DEFAULT '{}',
      trigger_type TEXT NOT NULL DEFAULT 'full_scan'
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      market_prob REAL NOT NULL,
      fair_prob REAL
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      market_id TEXT NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      direction TEXT NOT NULL,
      entry_prob REAL NOT NULL,
      entry_edge REAL NOT NULL,
      exit_prob REAL,
      size_usd REAL NOT NULL,
      pnl_usd REAL,
      close_reason TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS calibration (
      id SERIAL PRIMARY KEY,
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      category TEXT NOT NULL,
      predicted_prob REAL NOT NULL,
      resolved_outcome REAL NOT NULL,
      brier_score REAL NOT NULL,
      direction_correct BOOLEAN NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS news_alerts (
      id SERIAL PRIMARY KEY,
      market_id TEXT,
      market_question TEXT,
      headline TEXT NOT NULL,
      source TEXT,
      relevance_score INTEGER,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS news_cache (
      cache_key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;

  // Indexes for performance
  await db`CREATE INDEX IF NOT EXISTS idx_signals_market_id ON signals(market_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_signals_scanned_at ON signals(scanned_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS idx_price_history_market_id ON price_history(market_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades(market_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`;
  await db`CREATE INDEX IF NOT EXISTS idx_news_alerts_triggered ON news_alerts(triggered_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS idx_news_cache_expires ON news_cache(expires_at)`;
}

// ─── Markets ─────────────────────────────────────────────────────────────────

export async function upsertMarket(m: FilteredMarket): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO markets (
      id, question, description, resolution_source, url, category,
      yes_prob_pct, volume, end_date, end_date_iso, days_until_resolution,
      best_bid, best_ask, spread, last_trade_price, volume_24hr, liquidity,
      last_updated
    ) VALUES (
      ${m.id}, ${m.question}, ${m.description ?? null}, ${m.resolutionSource ?? null},
      ${m.url ?? null}, ${m.category}, ${m.yesProbPct}, ${m.volume},
      ${m.endDate}, ${m.endDateIso}, ${m.daysUntilResolution},
      ${m.bestBid ?? null}, ${m.bestAsk ?? null}, ${m.spread ?? null},
      ${m.lastTradePrice ?? null}, ${m.volume24hr ?? null}, ${m.liquidity ?? null},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      question = EXCLUDED.question,
      description = EXCLUDED.description,
      resolution_source = EXCLUDED.resolution_source,
      url = EXCLUDED.url,
      category = EXCLUDED.category,
      yes_prob_pct = EXCLUDED.yes_prob_pct,
      volume = EXCLUDED.volume,
      end_date = EXCLUDED.end_date,
      end_date_iso = EXCLUDED.end_date_iso,
      days_until_resolution = EXCLUDED.days_until_resolution,
      best_bid = EXCLUDED.best_bid,
      best_ask = EXCLUDED.best_ask,
      spread = EXCLUDED.spread,
      last_trade_price = EXCLUDED.last_trade_price,
      volume_24hr = EXCLUDED.volume_24hr,
      liquidity = EXCLUDED.liquidity,
      last_updated = NOW()
  `;
}

export async function updateMarketPrice(marketId: string, yesProbPct: number): Promise<void> {
  const db = sql();
  await db`
    UPDATE markets SET yes_prob_pct = ${yesProbPct}, last_updated = NOW()
    WHERE id = ${marketId}
  `;
}

export async function touchMarketScan(marketId: string): Promise<void> {
  const db = sql();
  await db`UPDATE markets SET last_scan_at = NOW() WHERE id = ${marketId}`;
}

export async function markResolved(marketId: string, outcome: 0 | 1): Promise<void> {
  const db = sql();
  await db`
    UPDATE markets SET resolved_outcome = ${outcome}, resolved_at = NOW(), last_updated = NOW()
    WHERE id = ${marketId}
  `;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export async function insertSignal(s: {
  marketId: string;
  priorProb: number;
  posteriorProb: number;
  likelihoodRatio: number;
  edgePct: number;
  direction: string;
  confidence: string;
  reasoning: string;
  keyFactors: { bullish: string[]; bearish: string[] };
  newsSignals: unknown[];
  newsAge: string;
  topFact: string;
  sources: string[];
  triggerType: string;
}): Promise<number> {
  const db = sql();
  const rows = await db`
    INSERT INTO signals (
      market_id, prior_prob, posterior_prob, likelihood_ratio, edge_pct,
      direction, confidence, reasoning, key_factors, news_signals,
      news_age, top_fact, sources, trigger_type
    ) VALUES (
      ${s.marketId}, ${s.priorProb}, ${s.posteriorProb}, ${s.likelihoodRatio}, ${s.edgePct},
      ${s.direction}, ${s.confidence}, ${s.reasoning},
      ${JSON.stringify(s.keyFactors)}::jsonb, ${JSON.stringify(s.newsSignals)}::jsonb,
      ${s.newsAge}, ${s.topFact ?? null}, ${s.sources}, ${s.triggerType}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function getLatestSignal(marketId: string): Promise<{
  priorProb: number;
  posteriorProb: number;
  edgePct: number;
  direction: string;
  confidence: string;
  reasoning: string;
  keyFactors: { bullish: string[]; bearish: string[] };
  newsSignals: unknown[];
  newsAge: string;
  topFact: string | null;
  sources: string[];
  triggerType: string;
} | null> {
  const db = sql();
  const rows = await db`
    SELECT * FROM signals WHERE market_id = ${marketId}
    ORDER BY scanned_at DESC LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    priorProb: r.prior_prob as number,
    posteriorProb: r.posterior_prob as number,
    edgePct: r.edge_pct as number,
    direction: r.direction as string,
    confidence: r.confidence as string,
    reasoning: r.reasoning as string,
    keyFactors: (() => {
      const raw = r.key_factors;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const kf = raw as Record<string, unknown>;
        return {
          bullish: Array.isArray(kf.bullish) ? kf.bullish as string[] : [],
          bearish: Array.isArray(kf.bearish) ? kf.bearish as string[] : [],
        };
      }
      return { bullish: [], bearish: [] };
    })(),
    newsSignals: (() => {
      const raw = r.news_signals;
      if (typeof raw === "string") { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
      return Array.isArray(raw) ? raw as unknown[] : [];
    })(),
    newsAge: r.news_age as string,
    topFact: r.top_fact as string | null,
    sources: r.sources as string[],
    triggerType: r.trigger_type as string,
  };
}

// ─── Price History ────────────────────────────────────────────────────────────

export async function appendPriceHistory(marketId: string, marketProb: number, fairProb?: number): Promise<void> {
  const db = sql();
  // Only append if price changed from last entry
  const last = await db`
    SELECT market_prob FROM price_history WHERE market_id = ${marketId}
    ORDER BY recorded_at DESC LIMIT 1
  `;
  if (last.length > 0 && last[0].market_prob === marketProb) return;

  await db`
    INSERT INTO price_history (market_id, market_prob, fair_prob)
    VALUES (${marketId}, ${marketProb}, ${fairProb ?? null})
  `;
}

// ─── Market Store (UI data) ───────────────────────────────────────────────────

export async function getMarketStore(): Promise<MarketStore> {
  const db = sql();

  // Fetch all markets — if tables don't exist yet (pre-migration), return empty store
  let markets: postgres.RowList<postgres.Row[]>;
  try {
    markets = await db`SELECT * FROM markets ORDER BY last_updated DESC`;
  } catch {
    return { lastScanAt: null, markets: [] };
  }

  if (markets.length === 0) {
    return { lastScanAt: null, markets: [] };
  }

  const marketIds = markets.map(m => m.id as string);

  // Latest signal per market (DISTINCT ON)
  const latestSignals = await db`
    SELECT DISTINCT ON (market_id) *
    FROM signals
    WHERE market_id = ANY(${marketIds})
    ORDER BY market_id, scanned_at DESC
  `;
  const signalMap = new Map(latestSignals.map(s => [s.market_id as string, s]));

  // Price history: last 60 rows per market
  const historyRows = await db`
    SELECT ph.*
    FROM price_history ph
    INNER JOIN (
      SELECT market_id, MAX(id) as max_id
      FROM (
        SELECT market_id, id FROM price_history
        WHERE market_id = ANY(${marketIds})
        ORDER BY market_id, recorded_at DESC
      ) sub
      GROUP BY market_id
    ) latest ON ph.market_id = latest.market_id
    WHERE ph.market_id = ANY(${marketIds})
    ORDER BY ph.market_id, ph.recorded_at ASC
  `;

  // Build history map: last 60 per market
  const historyMap = new Map<string, Array<{ date: string; marketProb: number; fairProb?: number }>>();
  // Fetch properly
  const historyRaw = await db`
    SELECT market_id, recorded_at, market_prob, fair_prob
    FROM price_history
    WHERE market_id = ANY(${marketIds})
    ORDER BY market_id, recorded_at ASC
  `;
  for (const row of historyRaw) {
    const mid = row.market_id as string;
    if (!historyMap.has(mid)) historyMap.set(mid, []);
    historyMap.get(mid)!.push({
      date: (row.recorded_at as Date).toISOString(),
      marketProb: row.market_prob as number,
      ...(row.fair_prob != null ? { fairProb: row.fair_prob as number } : {}),
    });
  }
  // Trim to last 60
  for (const [mid, hist] of historyMap) {
    historyMap.set(mid, hist.slice(-60));
  }

  // Get calibration and paper trading
  const [calibration, paperTrading] = await Promise.all([
    getCalibrationSummary(),
    getPaperTradingState(),
  ]);

  // Find lastScanAt = max of all last_scan_at
  let lastScanAt: string | null = null;
  for (const m of markets) {
    if (m.last_scan_at) {
      const iso = (m.last_scan_at as Date).toISOString();
      if (!lastScanAt || iso > lastScanAt) lastScanAt = iso;
    }
  }

  const trackedMarkets: TrackedMarket[] = markets.map(m => {
    const signal = signalMap.get(m.id as string);
    const history = historyMap.get(m.id as string) ?? [];

    const marketProb = m.yes_prob_pct as number;
    const edgePct = signal ? (signal.edge_pct as number) : 0;
    const posteriorProb = signal ? (signal.posterior_prob as number) : marketProb;
    const fairProb = Math.max(1, Math.min(99, Math.round(posteriorProb)));
    const edge = Math.round(edgePct * 10) / 10;
    const absEdge = Math.abs(edge);
    const edgeLevel: TrackedMarket["edgeLevel"] = absEdge >= 10 ? "high" : absEdge >= 5 ? "medium" : "low";
    const direction = (signal?.direction ?? "YES") as "YES" | "NO";
    const confidence = (signal?.confidence ?? "low") as "high" | "medium" | "low";
    const resolved = m.resolved_outcome != null;
    const resolutionOutcome = resolved
      ? ((m.resolved_outcome as number) === 1 ? "correct" : "incorrect")
      : undefined;

    const rawKF = signal?.key_factors as { bullish?: unknown; bearish?: unknown } | undefined | null;
    const keyFactors: { bullish: string[]; bearish: string[] } = {
      bullish: Array.isArray(rawKF?.bullish) ? (rawKF!.bullish as string[]) : [],
      bearish: Array.isArray(rawKF?.bearish) ? (rawKF!.bearish as string[]) : [],
    };
    const sources = (signal?.sources ?? []) as string[];
    const topFact = (signal?.top_fact ?? undefined) as string | undefined;
    const newsAge = (signal?.news_age ?? "stale") as "stale" | "recent" | "breaking";
    const triggerType = (signal?.trigger_type ?? "full_scan") as "full_scan" | "news_triggered" | "manual";
    const reasoning = (signal?.reasoning ?? "") as string;

    return {
      id: m.id as string,
      title: m.question as string,
      url: (m.url ?? undefined) as string | undefined,
      category: m.category as string,
      marketProb,
      fairProb,
      edge,
      edgeLevel,
      direction,
      confidence,
      keyFactors,
      volume: (m.volume ?? "—") as string,
      endDate: (m.end_date ?? "—") as string,
      endDateIso: (m.end_date_iso ?? undefined) as string | undefined,
      daysUntilResolution: (m.days_until_resolution ?? 0) as number,
      reasoning,
      sources,
      topFact,
      newsAge,
      topContributors: [],
      lastTriggerType: triggerType,
      firstSeen: (m.first_seen as Date).toISOString(),
      lastUpdated: (m.last_updated as Date).toISOString(),
      history,
      resolved,
      resolutionOutcome: resolutionOutcome as TrackedMarket["resolutionOutcome"],
      saved: (m.saved ?? false) as boolean,
    };
  });

  void historyRows; // suppress unused variable warning

  return {
    lastScanAt,
    markets: trackedMarkets,
    calibration,
    paperTrading,
  };
}

// ─── Trades (paper trading) ───────────────────────────────────────────────────

export interface OpenTrade {
  id: number;
  marketId: string;
  direction: string;
  entryProb: number;
  entryEdge: number;
  sizeUsd: number;
  openedAt: string;
}

export async function openTrade(t: {
  marketId: string;
  direction: string;
  entryProb: number;
  entryEdge: number;
  sizeUsd: number;
}): Promise<number> {
  const db = sql();
  const rows = await db`
    INSERT INTO trades (market_id, direction, entry_prob, entry_edge, size_usd, status)
    VALUES (${t.marketId}, ${t.direction}, ${t.entryProb}, ${t.entryEdge}, ${t.sizeUsd}, 'open')
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function closeTrade(tradeId: number, exitProb: number, pnlUsd: number, reason: string): Promise<void> {
  const db = sql();
  await db`
    UPDATE trades SET
      closed_at = NOW(), exit_prob = ${exitProb}, pnl_usd = ${pnlUsd},
      close_reason = ${reason}, status = 'closed'
    WHERE id = ${tradeId}
  `;
}

export async function getOpenTrades(): Promise<OpenTrade[]> {
  const db = sql();
  const rows = await db`SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at ASC`;
  return rows.map(r => ({
    id: r.id as number,
    marketId: r.market_id as string,
    direction: r.direction as string,
    entryProb: r.entry_prob as number,
    entryEdge: r.entry_edge as number,
    sizeUsd: r.size_usd as number,
    openedAt: (r.opened_at as Date).toISOString(),
  }));
}

export function defaultPaperTradingState(): PaperTradingState {
  return { bankroll: DEFAULT_BANKROLL, currentBankroll: DEFAULT_BANKROLL, positions: [], totalPnl: 0, winRate: 0, maxDrawdown: 0 };
}

const DEFAULT_BANKROLL = 10_000;

export async function getPaperTradingState(): Promise<PaperTradingState> {
  const db = sql();

  // JOIN trades with markets to get market question + current price for mark-to-market
  const rows = await db`
    SELECT t.*, m.question AS market_question, m.yes_prob_pct
    FROM trades t
    LEFT JOIN markets m ON m.id = t.market_id
    ORDER BY t.opened_at ASC
  `;

  const closed = rows.filter(r => r.status === 'closed');
  const open = rows.filter(r => r.status === 'open');

  const totalPnl = closed.reduce((sum, r) => sum + ((r.pnl_usd as number) ?? 0), 0);
  const wins = closed.filter(r => ((r.pnl_usd as number) ?? 0) > 0);
  // Store as 0–1 fraction — Dashboard renders (pt.winRate * 100)
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;

  // Compute max drawdown from starting bankroll
  let peak = DEFAULT_BANKROLL;
  let running = DEFAULT_BANKROLL;
  let maxDrawdown = 0;
  for (const r of closed) {
    running += (r.pnl_usd as number) ?? 0;
    if (running > peak) peak = running;
    const dd = peak > 0 ? (peak - running) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Map to PaperPosition shape for the UI
  const toPosition = (r: Record<string, unknown>): PaperPosition => {
    const edgeAtEntry = r.entry_edge as number;
    const entryProb = r.entry_prob as number;
    const sizeUsd = r.size_usd as number;
    const direction = (r.direction as string).toUpperCase() as "YES" | "NO";
    const kellyFraction = Math.round((sizeUsd / DEFAULT_BANKROLL) * 10000) / 10000;

    // Mark-to-market unrealized P&L for open positions
    // Uses current yes_prob_pct from the markets JOIN
    const currentPrice = r.yes_prob_pct != null ? (r.yes_prob_pct as number) : undefined;
    let unrealizedPnl: number | undefined;
    if (r.status === "open" && currentPrice != null) {
      const currentProb = currentPrice;
      // Entry share price: YES side pays entryProb cents per share, NO side pays (100-entryProb) cents
      const entrySharePrice = direction === "YES" ? entryProb : 100 - entryProb;
      // Current share price: YES share worth currentProb, NO share worth (100-currentProb)
      const currentSharePrice = direction === "YES" ? currentProb : 100 - currentProb;
      if (entrySharePrice > 0) {
        unrealizedPnl = Math.round(sizeUsd * (currentSharePrice - entrySharePrice) / entrySharePrice * 100) / 100;
      }
    }

    return {
      id: String(r.id),
      marketId: r.market_id as string,
      marketQuestion: (r.market_question as string | null) ?? "",
      side: direction,
      entryPrice: entryProb,
      entryTimestamp: (r.opened_at as Date).toISOString(),
      edgeAtEntry,
      kellyFraction,
      notionalSize: sizeUsd,
      status: r.status as "open" | "closed" | "stopped",
      exitPrice: r.exit_prob != null ? (r.exit_prob as number) : undefined,
      exitTimestamp: r.closed_at ? (r.closed_at as Date).toISOString() : undefined,
      exitReason: r.close_reason ? "resolution" as const : undefined,
      pnl: r.pnl_usd != null ? (r.pnl_usd as number) : undefined,
      currentPrice,
      unrealizedPnl,
    };
  };

  return {
    bankroll: DEFAULT_BANKROLL,
    currentBankroll: DEFAULT_BANKROLL + totalPnl,
    positions: [...open.map(toPosition), ...closed.map(toPosition)],
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: Math.round(winRate * 1000) / 1000, // 0–1 fraction
    maxDrawdown: Math.round(maxDrawdown * 10000) / 10000,
  };
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export async function insertCalibration(c: {
  marketId: string;
  question: string;
  category: string;
  predictedProb: number;
  resolvedOutcome: number;
  brierScore: number;
  directionCorrect: boolean;
}): Promise<void> {
  const db = sql();
  // Avoid duplicates — one record per market resolution
  const existing = await db`SELECT id FROM calibration WHERE market_id = ${c.marketId} LIMIT 1`;
  if (existing.length > 0) return;

  await db`
    INSERT INTO calibration (market_id, question, category, predicted_prob, resolved_outcome, brier_score, direction_correct)
    VALUES (${c.marketId}, ${c.question}, ${c.category}, ${c.predictedProb}, ${c.resolvedOutcome}, ${c.brierScore}, ${c.directionCorrect})
  `;
}

export async function getCalibrationSummary(): Promise<CalibrationSummary> {
  const db = sql();
  const rows = await db`SELECT * FROM calibration ORDER BY recorded_at ASC`;

  if (rows.length === 0) {
    return {
      totalResolved: 0,
      brierScore: 0,
      brierBaseline: 0.25,
      brierSkill: 0,
      hitRate: 0,
      records: [],
    };
  }

  const total = rows.length;
  const meanBrier = rows.reduce((s, r) => s + (r.brier_score as number), 0) / total;
  const brierBaseline = 0.25;
  const brierSkill = Math.max(0, (brierBaseline - meanBrier) / brierBaseline);
  const dirCorrect = rows.filter(r => r.direction_correct).length;
  const hitRate = dirCorrect / total;

  // Build records array for UI (CalibrationRecord shape)
  const records = rows.map(r => ({
    marketId: r.market_id as string,
    question: r.question as string,
    fairProb: r.predicted_prob as number,
    marketProb: r.predicted_prob as number,
    outcome: Math.round(r.resolved_outcome as number) as 1 | 0,
    resolvedAt: (r.recorded_at as Date).toISOString(),
    brierScore: r.brier_score as number,
    direction: "YES" as const,
    directionCorrect: r.direction_correct as boolean,
  }));

  return {
    totalResolved: total,
    brierScore: Math.round(meanBrier * 1000) / 1000,
    brierBaseline,
    brierSkill: Math.round(brierSkill * 1000) / 1000,
    hitRate: Math.round(hitRate * 1000) / 1000,
    records,
  };
}

// ─── News Alerts ─────────────────────────────────────────────────────────────

export async function insertNewsAlert(a: {
  marketId?: string;
  marketQuestion?: string;
  headline: string;
  source?: string;
  relevanceScore?: number;
}): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO news_alerts (market_id, market_question, headline, source, relevance_score)
    VALUES (${a.marketId ?? null}, ${a.marketQuestion ?? null}, ${a.headline}, ${a.source ?? null}, ${a.relevanceScore ?? null})
  `;
}

export async function getNewsAlerts(limit = 50): Promise<NewsAlert[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM news_alerts ORDER BY triggered_at DESC LIMIT ${limit}
  `;
  return rows.map(r => ({
    marketId: (r.market_id ?? "") as string,
    marketQuestion: (r.market_question ?? "") as string,
    headline: r.headline as string,
    source: (r.source ?? "Unknown") as string,
    relevanceScore: (r.relevance_score ?? 0) as number,
    triggeredAt: (r.triggered_at as Date).toISOString(),
  }));
}

// ─── News Cache ───────────────────────────────────────────────────────────────

export async function getNewsCache(key: string): Promise<NewsHeadline[] | null> {
  const db = sql();
  const rows = await db`
    SELECT data FROM news_cache WHERE cache_key = ${key} AND expires_at > NOW()
  `;
  if (rows.length === 0) return null;
  const raw = rows[0].data;
  // postgres.js returns JSONB as a parsed JS value; guard against legacy
  // double-encoded strings (stored as JSON string instead of JSON array)
  if (typeof raw === "string") {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  }
  return Array.isArray(raw) ? (raw as NewsHeadline[]) : null;
}

export async function setNewsCache(key: string, data: NewsHeadline[], ttlSec: number): Promise<void> {
  const db = sql();
  // Cleanup expired entries
  await db`DELETE FROM news_cache WHERE expires_at < NOW()`;
  // Use ::jsonb cast so Postgres parses the JSON string into a real JSONB value.
  // This avoids potential double-encoding that can occur if postgres.js also
  // tries to JSON-serialize a string parameter destined for a JSONB column.
  await db`
    INSERT INTO news_cache (cache_key, data, expires_at)
    VALUES (${key}, ${JSON.stringify(data)}::jsonb, NOW() + (${ttlSec} * interval '1 second'))
    ON CONFLICT (cache_key) DO UPDATE SET
      data = EXCLUDED.data,
      expires_at = EXCLUDED.expires_at
  `;
}

// ─── Scan Lock (Postgres advisory lock) ──────────────────────────────────────

const LOCK_KEY = 42;

export async function acquireScanLock(): Promise<boolean> {
  const db = sql();
  const rows = await db`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired`;
  return rows[0].acquired as boolean;
}

export async function releaseScanLock(): Promise<void> {
  const db = sql();
  await db`SELECT pg_advisory_unlock(${LOCK_KEY})`;
}
