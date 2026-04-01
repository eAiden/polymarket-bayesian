export interface RawPMMarket {
  id: string;
  question: string;
  slug: string;
  description?: string;       // resolution criteria / rules
  resolutionSource?: string;  // resolution source (e.g., "Associated Press")
  outcomePrices: string;
  outcomes: string;
  volumeNum?: number;
  volume?: string;
  endDateIso?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  events?: Array<{ slug: string }>;
  // CLOB fields
  clobTokenIds?: string;    // JSON-encoded array of token IDs
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  volume24hr?: number;
  liquidity?: number;
}

export interface FilteredMarket {
  id: string;
  question: string;
  description?: string;       // resolution criteria (truncated to 500 chars)
  resolutionSource?: string;
  url?: string;
  category: string;
  yesProbPct: number;    // 20-80
  volume: string;
  endDate: string;
  endDateIso: string;
  daysUntilResolution: number;
  // CLOB microstructure
  clobTokenIds?: string[];  // parsed token IDs (YES token is first)
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  volume24hr?: number;
  liquidity?: number;
}

// Order book data from CLOB API
export interface OrderBookData {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  spread: number;
  midPrice: number;
  bidDepth: number;    // total $ within 5% of mid
  askDepth: number;
  totalLiquidity: number;
}

// Recent trade data from CLOB API
export interface TradeData {
  totalTrades: number;
  largeTrades: number;       // trades > $500
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
  avgTradeSize: number;
  recentTrend: "buying" | "selling" | "balanced";
}

// FRED economic data
export interface FredData {
  cpiYoY?: number;           // CPI year-over-year %
  unemploymentRate?: number;
  fedFundsRate?: number;
  gdpGrowth?: number;
  fetchedAt: string;
}

// Crypto price data
export interface CryptoPrices {
  bitcoin?: { usd: number; usd_24h_change: number };
  ethereum?: { usd: number; usd_24h_change: number };
  solana?: { usd: number; usd_24h_change: number };
  fetchedAt: string;
}

// Enrichment data bundle passed to analysis
export interface MarketEnrichment {
  orderBook?: OrderBookData | null;
  trades?: TradeData | null;
  fred?: FredData | null;
  crypto?: CryptoPrices | null;
  priceHistory?: DailySnapshot[];       // past snapshots for trend context
  calibrationBias?: CategoryBias | null; // calibration feedback for debiasing
}

// Category-level calibration bias from past predictions
export interface CategoryBias {
  category: string;
  avgEdgeBias: number;     // mean (predicted edge - actual edge) in pp — positive = overconfident
  sampleSize: number;
  message: string;          // human-readable summary for prompt injection
}

export interface DailySnapshot {
  date: string;          // ISO datetime string (full timestamp per refresh)
  marketProb: number;    // YES price from Polymarket at this snapshot
  fairProb?: number;     // Bayesian estimate (only present on full scan refreshes)
}

export interface AnalyzedMarket {
  id: string;
  title: string;
  url?: string;
  category: string;
  marketProb: number;
  fairProb: number;
  edge: number;          // fairProb - marketProb
  edgeLevel: "high" | "medium" | "low";
  direction: "YES" | "NO";
  confidence?: "high" | "medium" | "low";
  confidenceInterval?: [number, number]; // 90% CI [low, high]
  keyFactors?: { bullish: string[]; bearish: string[] };
  volume: string;
  endDate: string;
  endDateIso?: string;
  daysUntilResolution: number;
  reasoning: string;
  sources: string[];
  topFact?: string;       // top news signal fact for leaderboard/edgeHistory headline
  newsAge?: "stale" | "recent" | "breaking"; // freshness of news signals
  topContributors?: Array<{ feature: string; contribution: number }>; // top 3 scoring drivers
  lastTriggerType?: "full_scan" | "news_triggered" | "manual"; // what triggered this analysis
}

export interface TrackedMarket extends AnalyzedMarket {
  firstSeen: string;     // ISO date
  lastUpdated: string;   // ISO date
  history: DailySnapshot[];
  resolved: boolean;
  resolutionOutcome?: "correct" | "incorrect" | "unknown";
  saved?: boolean;
}

export interface ScanEvent {
  phase: "fetching" | "analyzing" | "consistency" | "saving" | "done" | "error";
  current?: number;     // market being analyzed
  total?: number;       // total markets to analyze
  market?: string;      // current market question (truncated)
  message?: string;     // status text
  result?: { marketsScanned: number; analyzed: number; totalTracked: number };
}

export interface ScanError {
  source: string;     // "news" | "crossmarket" | "analysis" | "polymarket" | "storage"
  message: string;
  timestamp: string;
}

export interface MarketStore {
  lastScanAt: string | null;
  markets: TrackedMarket[];
  calibration?: import("./calibration").CalibrationSummary;
  scanHealth?: ScanError[];
  paperTrading?: import("./paper-trading").PaperTradingState;
}

// ─── Signal-based analysis types (v2) ──────────────────────────────────────

export interface NewsSignal {
  fact: string;                   // max 150 chars — the concrete fact
  direction: "YES" | "NO";       // does this push toward YES or NO?
  strength: "strong" | "moderate" | "weak";
  recency: "breaking" | "today" | "this_week" | "older";
  source: string;
}

export interface ExtractedSignal {
  newsSignals: NewsSignal[];
  resolution: {
    daysLeft: number;
    ambiguityRisk: "high" | "medium" | "low";
    criticalDate?: string;
    resolutionNote?: string;      // max 150 chars
  };
  crossMarketDisagreement: number; // 0-100
  newsAge: "stale" | "recent" | "breaking";
  informationCompleteness: "high" | "medium" | "low";
  domainSignals?: {
    keyMetric?: string;
    trendDirection?: "up" | "down" | "flat";
    volatilityAssessment?: "high" | "normal" | "low";
  };
}

export interface FeatureVector {
  // From signal extraction
  netNewsDirection: number;       // -1 to +1
  strongSignalCount: number;
  breakingNewsPresent: number;    // 0 or 1
  newsAge: number;                // 0 / 0.5 / 1.0
  informationCompleteness: number; // 0 / 0.5 / 1.0
  resolutionAmbiguity: number;    // 0 / 0.5 / 1.0

  // From market microstructure
  buySellImbalance: number;       // -1 to +1
  volumeSpike: number;            // ratio (>1 = spike)
  spreadPct: number;
  liquidityRatio: number;         // bid/ask depth ratio

  // From price dynamics
  priceMomentum3d: number;        // pp change
  priceMomentum7d: number;        // pp change

  // From cross-market
  crossMarketSpread: number;      // max spread across platforms (pp)
  polymarketVsConsensus: number;  // signed pp

  // Time
  daysToResolution: number;
  urgency: number;                // 1/sqrt(days)

  // Calibration
  categoryBias: number;           // historical bias (pp)

  // Metadata
  timestamp: string;
  marketProbAtExtraction: number;
}

export interface ModelWeights {
  netNewsDirection: number;
  strongSignalCount: number;
  breakingNewsPresent: number;
  newsAge: number;
  informationCompleteness: number;
  resolutionAmbiguity: number;
  buySellImbalance: number;
  volumeSpike: number;
  spreadPct: number;
  liquidityRatio: number;
  priceMomentum3d: number;
  priceMomentum7d: number;
  crossMarketSpread: number;
  polymarketVsConsensus: number;
  daysToResolution: number;
  urgency: number;
  categoryBias: number;
  intercept: number;
  version: string;
  updatedAt: string;
}

export interface ScoringResult {
  rawEdge: number;
  edge: number;                   // clamped to [-30, +30] pp
  confidence: "high" | "medium" | "low";
  direction: "YES" | "NO" | "HOLD";
  topContributors: Array<{
    feature: string;
    contribution: number;         // signed pp
  }>;
}

export interface SignalSnapshot {
  id: string;
  marketId: string;
  timestamp: string;
  triggerType: "full_scan" | "news_triggered" | "manual";
  marketProbAtAnalysis: number;
  extractedSignal: ExtractedSignal;
  featureVector: FeatureVector;
  scoringResult: ScoringResult;
  modelVersion: string;
  baselineScore?: number;    // ablation: simple heuristic score (0-1) at analysis time
  resolved: boolean;
  outcome?: 1 | 0;
  resolvedAt?: string;
  marketProbAtResolution?: number;
}

export interface NewsAlert {
  marketId: string;
  marketQuestion: string;
  headline: string;
  source: string;
  relevanceScore: number;
  triggeredAt: string;
}
