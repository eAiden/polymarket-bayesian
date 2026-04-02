// Paper trading: hypothetical P&L tracking with Kelly criterion position sizing.
// No real money — tracks what we would have made if we traded every signal.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const PT_FILE = join(DATA_DIR, "paper-trading.json");

const DEFAULT_BANKROLL = 10_000;

export interface EdgeUpdate {
  timestamp: string;
  marketPrice: number;
  edge: number;
  confidence: "high" | "medium" | "low";
  headline?: string;    // top news signal fact at time of update (for leaderboard display)
}

export interface PaperPosition {
  id: string;
  marketId: string;
  marketQuestion: string;
  side: "YES" | "NO";
  entryPrice: number;           // price of the share bought (YES price for YES, NO price for NO)
  entryTimestamp: string;
  edgeAtEntry: number;          // model's predicted edge (pp)
  currentEdge?: number;         // latest edge estimate (updated on re-analysis)
  kellyFraction: number;        // fraction of bankroll risked
  notionalSize: number;         // $ amount
  status: "open" | "closed" | "stopped";
  exitPrice?: number;
  exitTimestamp?: string;
  exitReason?: "resolution" | "stop_loss" | "edge_decay" | "take_profit";
  pnl?: number;
  pnlPct?: number;
  outcome?: 1 | 0;
  edgeHistory?: EdgeUpdate[];   // track how edge evolves over time
  unrealizedPnl?: number;       // mark-to-market P&L while open
}

export interface PaperTradingState {
  bankroll: number;
  currentBankroll: number;
  positions: PaperPosition[];
  totalPnl: number;
  winRate: number;
  maxDrawdown: number;
}

let idCounter = 0;
function generateId(): string {
  return `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}_${++idCounter}`;
}

// ─── Load / Save ────────────────────────────────────────────────────────────

export function loadPaperTrading(): PaperTradingState {
  try {
    if (!existsSync(PT_FILE)) return defaultState();
    const raw = JSON.parse(readFileSync(PT_FILE, "utf-8")) as PaperTradingState;
    if (!Array.isArray(raw.positions)) return defaultState();
    return raw;
  } catch {
    return defaultState();
  }
}

function defaultState(): PaperTradingState {
  return {
    bankroll: DEFAULT_BANKROLL,
    currentBankroll: DEFAULT_BANKROLL,
    positions: [],
    totalPnl: 0,
    winRate: 0,
    maxDrawdown: 0,
  };
}

function savePaperTrading(state: PaperTradingState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, PT_FILE);
}

export async function loadPaperTradingAsync(): Promise<PaperTradingState> {
  return loadPaperTrading();
}

// ─── Kelly criterion sizing ─────────────────────────────────────────────────
// Quarter Kelly: conservative sizing for imperfect edge estimates.

export function kellySize(
  edgePp: number,
  confidence: "high" | "medium" | "low",
  marketProb: number,
  bankroll: number,
): { fraction: number; notional: number } {
  const absEdge = Math.abs(edgePp) / 100;
  const p = marketProb / 100; // probability of YES outcome per market

  // For YES side: odds = (1-p)/p, for NO side: odds = p/(1-p)
  const isYes = edgePp > 0;
  const odds = isYes ? (1 - p) / p : p / (1 - p);

  // Kelly: f = edge / odds
  let kelly = odds > 0 ? absEdge / odds : 0;

  // Quarter Kelly for safety
  kelly *= 0.25;

  // Confidence discount
  const confMultiplier = { high: 1.0, medium: 0.6, low: 0.3 };
  kelly *= confMultiplier[confidence];

  // Cap at 5% of bankroll
  const fraction = Math.max(0, Math.min(0.05, kelly));
  const notional = Math.round(fraction * bankroll * 100) / 100;

  return { fraction, notional };
}

// ─── Open position ──────────────────────────────────────────────────────────

export function openPosition(
  marketId: string,
  marketQuestion: string,
  side: "YES" | "NO",
  entryPrice: number,
  edgePp: number,
  confidence: "high" | "medium" | "low",
): PaperPosition | null {
  // Require minimum edge and confidence
  if (Math.abs(edgePp) < 5) return null;
  if (confidence === "low") return null;

  const state = loadPaperTrading();

  // Don't open duplicate position for same market
  if (state.positions.some(p => p.marketId === marketId && p.status === "open")) {
    return null;
  }

  const { fraction, notional } = kellySize(edgePp, confidence, entryPrice, state.currentBankroll);
  if (notional < 1) return null; // too small

  // Store the price of the actual share bought, not always the YES price
  const sharePrice = side === "NO" ? 100 - entryPrice : entryPrice;

  const position: PaperPosition = {
    id: generateId(),
    marketId,
    marketQuestion: marketQuestion.slice(0, 200),
    side,
    entryPrice: sharePrice,
    entryTimestamp: new Date().toISOString(),
    edgeAtEntry: edgePp,
    kellyFraction: Math.round(fraction * 10000) / 10000,
    notionalSize: notional,
    status: "open",
  };

  state.positions.push(position);
  savePaperTrading(state);

  console.log(`[paper] Opened ${side} position on "${marketQuestion.slice(0, 40)}" — $${notional} (${(fraction * 100).toFixed(1)}% Kelly)`);
  return position;
}

// ─── Update position on re-analysis ────────────────────────────────────────
// Called when the model re-scores a market. Tracks edge decay and triggers
// stop-loss / take-profit / edge-decay exits.

// Thresholds
const STOP_LOSS_PP = 15;        // close if market moves 15pp against us
const TAKE_PROFIT_PP = 20;      // close if market moves 20pp in our favor
const EDGE_DECAY_THRESHOLD = 2; // close if edge drops below 2pp (no longer worth holding)

export function updatePosition(
  marketId: string,
  currentMarketPrice: number,
  newEdge: number,
  confidence: "high" | "medium" | "low",
  headline?: string,
): { action: "updated" | "stopped" | "none"; position?: PaperPosition; reason?: string } {
  const state = loadPaperTrading();
  const pos = state.positions.find(p => p.marketId === marketId && p.status === "open");
  if (!pos) return { action: "none" };

  const now = new Date().toISOString();

  // Track edge history (include headline if provided)
  if (!pos.edgeHistory) pos.edgeHistory = [];
  const entry: EdgeUpdate = { timestamp: now, marketPrice: currentMarketPrice, edge: newEdge, confidence };
  if (headline) entry.headline = headline;
  pos.edgeHistory.push(entry);
  // Keep last 50 updates
  if (pos.edgeHistory.length > 50) pos.edgeHistory = pos.edgeHistory.slice(-50);

  pos.currentEdge = newEdge;

  // Current share price: YES price for YES positions, NO price for NO positions
  const currentSharePrice = pos.side === "YES" ? currentMarketPrice : 100 - currentMarketPrice;

  // Unrealized P&L (mark-to-market): shares × currentSharePrice - notional
  // shares = notional / entryPrice (both in same units now)
  pos.unrealizedPnl = pos.entryPrice > 0
    ? Math.round(pos.notionalSize * (currentSharePrice - pos.entryPrice) / pos.entryPrice * 100) / 100
    : 0;

  // Check stop-loss / take-profit: movement in share price (positive = good for us)
  const priceMove = currentSharePrice - pos.entryPrice;

  if (priceMove <= -STOP_LOSS_PP) {
    return closePositionEarly(state, pos, currentMarketPrice, "stop_loss",
      `Market moved ${Math.abs(priceMove).toFixed(0)}pp against position`);
  }

  // Check take-profit: market moved in our favor
  if (priceMove >= TAKE_PROFIT_PP) {
    return closePositionEarly(state, pos, currentMarketPrice, "take_profit",
      `Market moved ${priceMove.toFixed(0)}pp in favor, taking profit`);
  }

  // Check edge decay: model no longer sees edge
  if (Math.abs(newEdge) < EDGE_DECAY_THRESHOLD && pos.edgeHistory.length >= 2) {
    return closePositionEarly(state, pos, currentMarketPrice, "edge_decay",
      `Edge decayed to ${newEdge.toFixed(1)}pp (was ${pos.edgeAtEntry.toFixed(1)}pp at entry)`);
  }

  savePaperTrading(state);
  return { action: "updated", position: pos };
}

function closePositionEarly(
  state: PaperTradingState,
  pos: PaperPosition,
  currentPrice: number,
  reason: "stop_loss" | "edge_decay" | "take_profit",
  logMsg: string,
): { action: "stopped"; position: PaperPosition; reason: string } {
  pos.status = "stopped";
  pos.exitPrice = currentPrice;
  pos.exitTimestamp = new Date().toISOString();
  pos.exitReason = reason;

  // P&L: sell at current share price (entryPrice is already in share-price terms)
  const exitSharePrice = pos.side === "YES" ? currentPrice : 100 - currentPrice;
  pos.exitPrice = exitSharePrice;  // store as share price for consistency
  pos.pnl = pos.entryPrice > 0
    ? Math.round(pos.notionalSize * (exitSharePrice - pos.entryPrice) / pos.entryPrice * 100) / 100
    : 0;
  pos.pnlPct = pos.notionalSize > 0 ? Math.round((pos.pnl / pos.notionalSize) * 10000) / 100 : 0;

  state.currentBankroll += pos.pnl;
  state.totalPnl = Math.round((state.currentBankroll - state.bankroll) * 100) / 100;
  recomputeStats(state);
  savePaperTrading(state);

  console.log(`[paper] STOPPED ${pos.side} on "${pos.marketQuestion.slice(0, 40)}" — ${reason}: ${logMsg}. P&L: $${pos.pnl >= 0 ? "+" : ""}${pos.pnl}`);
  return { action: "stopped", position: pos, reason: logMsg };
}

// ─── Close position on resolution ───────────────────────────────────────────

export function closePosition(
  marketId: string,
  outcome: 1 | 0,
  exitPrice: number,
): PaperPosition | null {
  const state = loadPaperTrading();
  const pos = state.positions.find(p => p.marketId === marketId && p.status === "open");
  if (!pos) return null;

  pos.status = "closed";
  pos.exitTimestamp = new Date().toISOString();
  pos.exitReason = "resolution";
  pos.outcome = outcome;

  // Resolution: share pays $1 if we win, $0 if we lose.
  // entryPrice is always the share price (YES price for YES, NO price for NO).
  // Win condition: YES wins outcome=1, NO wins outcome=0.
  const won = pos.side === "YES" ? outcome === 1 : outcome === 0;
  pos.exitPrice = won ? 100 : 0;  // share settles at 100 or 0
  pos.pnl = won
    ? Math.round(pos.notionalSize * (100 - pos.entryPrice) / pos.entryPrice * 100) / 100
    : -pos.notionalSize;
  pos.pnl = Math.round(pos.pnl * 100) / 100;
  pos.pnlPct = pos.notionalSize > 0 ? Math.round((pos.pnl / pos.notionalSize) * 10000) / 100 : 0;

  state.currentBankroll += pos.pnl;
  state.totalPnl = Math.round((state.currentBankroll - state.bankroll) * 100) / 100;
  recomputeStats(state);
  savePaperTrading(state);

  console.log(`[paper] Closed ${pos.side} on "${pos.marketQuestion.slice(0, 40)}" → P&L: $${pos.pnl > 0 ? "+" : ""}${pos.pnl}`);
  return pos;
}

// ─── Recompute aggregate stats ─────────────────────────────────────────────

function recomputeStats(state: PaperTradingState): void {
  const settled = state.positions.filter(p => p.status === "closed" || p.status === "stopped");
  const wins = settled.filter(p => (p.pnl ?? 0) > 0);
  state.winRate = settled.length > 0 ? Math.round((wins.length / settled.length) * 1000) / 1000 : 0;

  let peak = state.bankroll;
  let maxDD = 0;
  let running = state.bankroll;
  for (const p of settled.sort((a, b) => (a.exitTimestamp ?? "").localeCompare(b.exitTimestamp ?? ""))) {
    running += p.pnl ?? 0;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  state.maxDrawdown = Math.round(maxDD * 10000) / 10000;
}
