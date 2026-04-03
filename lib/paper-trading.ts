// Paper trading types and pure functions.
// Persistence is handled by lib/db.ts (Postgres). No file I/O here.

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
  currentPrice?: number;        // current YES probability % (live from markets table)
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

// ─── Default state ───────────────────────────────────────────────────────────

export function defaultPaperTradingState(): PaperTradingState {
  return {
    bankroll: DEFAULT_BANKROLL,
    currentBankroll: DEFAULT_BANKROLL,
    positions: [],
    totalPnl: 0,
    winRate: 0,
    maxDrawdown: 0,
  };
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
