"use client";

import { useState, useEffect, useCallback } from "react";
import type { MarketStore, TrackedMarket, ScanEvent } from "@/lib/types";
import type { PaperPosition } from "@/lib/paper-trading";
import { MarketCard } from "./MarketCard";

type EdgeFilter = "all" | "high" | "medium" | "low";
type SortKey = "edge" | "days" | "confidence";
type MainTab = "markets" | "trades";
type TriggerFilter = "all" | "news_triggered";

interface ModelStatus { trained: boolean; version: string; updatedAt: string }
interface TrainStats { totalSnapshots: number; resolvedSnapshots: number; usableSnapshots: number; readyToTrain: boolean; samplesNeeded: number }

const CATEGORIES = ["All", "Saved", "Politics", "Crypto", "Sports", "Economics", "Science", "Other"];
const POLL_INTERVAL = 5 * 60 * 1000;

interface DashboardProps {
  initialData: MarketStore;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function confRank(c?: string) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

export function Dashboard({ initialData }: DashboardProps) {
  const [store, setStore] = useState<MarketStore>(initialData);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanEvent | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("markets");
  const [category, setCategory] = useState("All");
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("edge");
  const [showResolved, setShowResolved] = useState(false);
  const [tradeFilter, setTradeFilter] = useState<"all" | "open" | "closed" | "stopped">("all");
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [newsAlertCount, setNewsAlertCount] = useState<number>(0);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [trainStats, setTrainStats] = useState<TrainStats | null>(null);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/model").then(r => r.ok ? r.json() : null).then(setModelStatus).catch(() => {});
    fetch("/api/alerts").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.total != null) setNewsAlertCount(d.total);
    }).catch(() => {});
    fetch("/api/train").then(r => r.ok ? r.json() : null).then(setTrainStats).catch(() => {});
  }, []);

  const handleRetrain = async () => {
    setTraining(true);
    setTrainResult(null);
    try {
      const res = await fetch("/api/train", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTrainResult(`✓ Trained on ${data.samplesUsed} samples · loss ${data.initialLoss} → ${data.finalLoss} (${data.lossImprovement > 0 ? "+" : ""}${data.lossImprovement}%) · ${data.weightsVersion}`);
        setModelStatus({ trained: true, version: data.weightsVersion, updatedAt: data.updatedAt });
        setTrainStats(prev => prev ? { ...prev, readyToTrain: true } : prev);
      } else {
        setTrainResult(`✗ ${data.error}`);
      }
    } catch (err) {
      setTrainResult(`✗ ${(err as Error).message}`);
    } finally {
      setTraining(false);
    }
  };

  const handleToggleSave = useCallback(async (id: string) => {
    setStore((prev) => ({
      ...prev,
      markets: prev.markets.map((m) =>
        m.id === id ? { ...m, saved: !m.saved } : m
      ),
    }));
    await fetch(`/api/markets/${id}`, { method: "PATCH" });
  }, []);

  const fetchStore = useCallback(async () => {
    try {
      const res = await fetch("/api/markets", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        // Ensure markets is always an array even if the response is malformed
        if (!Array.isArray(data?.markets)) data.markets = [];
        setStore(data);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    const id = setInterval(fetchStore, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchStore]);

  const handleScan = async () => {
    setScanError(null);
    setScanning(true);
    setScanProgress(null);
    try {
      // Send stored scan key (if any) — server ignores it when SCAN_SECRET is not set
      const storedKey = typeof window !== "undefined"
        ? localStorage.getItem("scanKey") ?? ""
        : "";
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: storedKey ? { Authorization: `Bearer ${storedKey}` } : {},
      });
      // If unauthorized, prompt for password and retry once
      if (res.status === 401) {
        const key = window.prompt("Enter scan password:");
        if (!key) { setScanning(false); return; }
        localStorage.setItem("scanKey", key);
        const retry = await fetch("/api/scan", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
        });
        if (retry.status === 401) {
          localStorage.removeItem("scanKey");
          setScanError("Wrong password.");
          setScanning(false);
          return;
        }
        // Re-assign res to retry for the stream reading below
        return void handleScanStream(retry);
      }
      await handleScanStream(res);
    } catch (err) {
      setScanError((err as Error).message);
      setScanning(false);
      setScanProgress(null);
    }
  };

  const handleScanStream = async (res: Response) => {
    try {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Server error ${res.status}`);
      }
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, "");
          if (!data) continue;
          try {
            const event: ScanEvent = JSON.parse(data);
            setScanProgress(event);
            if (event.phase === "error") setScanError(event.message ?? "Scan failed");
            if (event.phase === "done") await fetchStore();
          } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (err) {
      setScanError((err as Error).message);
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  };

  // Filter + sort markets
  const markets: TrackedMarket[] = (Array.isArray(store.markets) ? store.markets : [])
    .filter((m) => {
      if (!showResolved && m.resolved) return false;
      if (category === "Saved") return !!m.saved;
      if (category !== "All" && m.category !== category) return false;
      if (edgeFilter !== "all" && m.edgeLevel !== edgeFilter) return false;
      if (triggerFilter === "news_triggered" && m.lastTriggerType !== "news_triggered") return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "edge") return Math.abs(b.edge) - Math.abs(a.edge);
      if (sortKey === "days") return a.daysUntilResolution - b.daysUntilResolution;
      if (sortKey === "confidence") return confRank(b.confidence) - confRank(a.confidence);
      return 0;
    });

  const safeMarkets = Array.isArray(store.markets) ? store.markets : [];
  const activeMarkets = safeMarkets.filter((m) => !m.resolved);
  const highEdgeCount = activeMarkets.filter((m) => m.edgeLevel === "high").length;
  const avgEdge = activeMarkets.reduce((s, m) => s + Math.abs(m.edge), 0) /
    Math.max(1, activeMarkets.length);
  const soonCount = activeMarkets.filter((m) => m.daysUntilResolution <= 7).length;

  const pt = store.paperTrading;
  const allPositions = pt?.positions ?? [];

  // Index open positions by marketId for card display
  const openPositionsByMarket = new Map(
    allPositions
      .filter(p => p.status === "open")
      .map(p => [p.marketId, p])
  );
  const openPositions = allPositions.filter(p => p.status === "open");
  const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const closedPositions = allPositions.filter(p => p.status === "closed");
  const stoppedPositions = allPositions.filter(p => p.status === "stopped");
  const filteredPositions = tradeFilter === "open" ? openPositions
    : tradeFilter === "closed" ? closedPositions
    : tradeFilter === "stopped" ? stoppedPositions
    : allPositions;

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="header">
        <div>
          <h1 className="site-title">Polymarket Signal</h1>
          <p className="site-sub">
            Markets 10–90% · ≤90 days · Signal extraction + scoring · Paper trading
            {modelStatus && (
              <span className={`model-badge ${modelStatus.trained ? "model-trained" : "model-untrained"}`}>
                {modelStatus.trained ? `Model ${modelStatus.version}` : "⚠ default weights"}
              </span>
            )}
          </p>
          {trainStats && (
            <div className="train-panel">
              <span className="train-progress">
                {trainStats.readyToTrain
                  ? `${trainStats.usableSnapshots} resolved samples — ready to train`
                  : `${trainStats.usableSnapshots}/20 resolved · ${trainStats.samplesNeeded} more needed`}
              </span>
              <button
                className="train-btn"
                onClick={handleRetrain}
                disabled={training || !trainStats.readyToTrain}
                title={!trainStats.readyToTrain ? `Need ${trainStats.samplesNeeded} more resolved markets` : "Run gradient descent on resolved signal snapshots"}
              >
                {training ? "Training…" : "Retrain"}
              </button>
              {trainResult && (
                <span className={`train-result ${trainResult.startsWith("✓") ? "train-ok" : "train-err"}`}>
                  {trainResult}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="header-right">
          <span className="last-updated">Updated {relativeTime(store.lastScanAt)}</span>
          <button
            className="scan-btn"
            onClick={handleScan}
            disabled={scanning}
          >
            {scanning ? "Scanning…" : "Run Scan"}
          </button>
        </div>
      </header>

      {/* Scan progress */}
      {scanning && scanProgress && (
        <div className="scan-progress">
          <div style={{ marginBottom: 6 }}>
            {scanProgress.phase === "fetching" && (scanProgress.message ?? "Fetching markets...")}
            {scanProgress.phase === "analyzing" && (
              <>
                Extracting signals {scanProgress.current}/{scanProgress.total}
                {scanProgress.market && <span style={{ color: "var(--muted)", marginLeft: 6 }}>"{scanProgress.market}"</span>}
              </>
            )}
            {scanProgress.phase === "consistency" && (scanProgress.message ?? "Scoring...")}
            {scanProgress.phase === "saving" && (scanProgress.message ?? "Saving...")}
            {scanProgress.phase === "done" && "Scan complete"}
          </div>
          {scanProgress.phase === "analyzing" && scanProgress.total && scanProgress.current && (
            <div className="progress-bar-wrap">
              <div className="progress-bar-fill" style={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}
      {scanning && !scanProgress && (
        <div className="scan-progress">Connecting to scan pipeline...</div>
      )}
      {scanError && (
        <div className="scan-error">{scanError}</div>
      )}
      {store.scanHealth && store.scanHealth.length > 0 && !scanning && (
        <details className="scan-health">
          <summary className="scan-health-summary">
            Scan Health: {store.scanHealth.length} warning{store.scanHealth.length !== 1 ? "s" : ""}
          </summary>
          <ul className="scan-health-list">
            {store.scanHealth.map((e, i) => (
              <li key={i}><strong>{e.source}</strong>: {e.message}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Summary stats */}
      {store.markets.length > 0 && (
        <div className="stats-bar">
          <div className="stat">
            <span className="stat-value">{activeMarkets.length}</span>
            <span className="stat-label">tracked</span>
          </div>
          <div className="stat">
            <span className="stat-value" style={{ color: "var(--green)" }}>{highEdgeCount}</span>
            <span className="stat-label">high edge</span>
          </div>
          <div className="stat">
            <span className="stat-value">{avgEdge.toFixed(1)}pp</span>
            <span className="stat-label">avg edge</span>
          </div>
          <div className="stat">
            <span className="stat-value" style={{ color: "var(--accent)" }}>{soonCount}</span>
            <span className="stat-label">resolve &le;7d</span>
          </div>
          {newsAlertCount > 0 && (
            <>
              <div className="stat-divider" />
              <div className="stat" title="News alerts fired since last reset">
                <span className="stat-value" style={{ color: "var(--yellow)" }}>{newsAlertCount}</span>
                <span className="stat-label">news alerts</span>
              </div>
            </>
          )}
          {pt && allPositions.length > 0 && (
            <>
              <div className="stat-divider" />
              <div className="stat" title="Paper trading P&L (hypothetical)">
                <span className="stat-value" style={{
                  color: pt.totalPnl > 0 ? "var(--green)" : pt.totalPnl < 0 ? "var(--red)" : "var(--muted)"
                }}>
                  {pt.totalPnl >= 0 ? "+" : ""}${pt.totalPnl.toFixed(0)}
                </span>
                <span className="stat-label">paper P&L</span>
              </div>
              <div className="stat" title="Win rate of closed positions">
                <span className="stat-value">
                  {(pt.winRate * 100).toFixed(0)}%
                </span>
                <span className="stat-label">win rate</span>
              </div>
              <div className="stat" title="Open paper positions">
                <span className="stat-value">{openPositions.length}</span>
                <span className="stat-label">positions</span>
              </div>
            </>
          )}
          {store.calibration && store.calibration.totalResolved > 0 && (
            <>
              <div className="stat-divider" />
              <div className="stat" title="Brier score: lower = better. 0.25 = random">
                <span className="stat-value" style={{ color: store.calibration.brierScore < 0.2 ? "var(--green)" : store.calibration.brierScore < 0.25 ? "var(--accent)" : "var(--red)" }}>
                  {store.calibration.brierScore.toFixed(3)}
                </span>
                <span className="stat-label">brier</span>
              </div>
              <div className="stat" title="% of resolved markets where direction was correct">
                <span className="stat-value">
                  {(store.calibration.hitRate * 100).toFixed(0)}%
                </span>
                <span className="stat-label">hit rate ({store.calibration.totalResolved})</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Main tab bar */}
      <div className="main-tabs">
        <button
          className={`main-tab ${mainTab === "markets" ? "active" : ""}`}
          onClick={() => setMainTab("markets")}
        >
          Markets
          <span className="main-tab-count">{activeMarkets.length}</span>
        </button>
        <button
          className={`main-tab ${mainTab === "trades" ? "active" : ""}`}
          onClick={() => setMainTab("trades")}
        >
          Paper Trades
          {allPositions.length > 0 && (
            <span className="main-tab-count">{allPositions.length}</span>
          )}
        </button>
      </div>

      {/* ── Markets tab ── */}
      {mainTab === "markets" && (
        <>
          <div className="filters">
            <div className="filter-row">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  className={`filter-btn ${category === c ? "active" : ""}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="filter-row">
              <span className="filter-label">Edge:</span>
              {(["all", "high", "medium", "low"] as EdgeFilter[]).map((e) => (
                <button
                  key={e}
                  className={`filter-btn ${edgeFilter === e ? "active" : ""}`}
                  onClick={() => setEdgeFilter(e)}
                >
                  {e}
                </button>
              ))}
              <span className="filter-label" style={{ marginLeft: 16 }}>Sort:</span>
              {([["edge", "Edge"], ["days", "Days left"], ["confidence", "Confidence"]] as [SortKey, string][]).map(([k, label]) => (
                <button
                  key={k}
                  className={`filter-btn ${sortKey === k ? "active" : ""}`}
                  onClick={() => setSortKey(k)}
                >
                  {label}
                </button>
              ))}
              <button
                className={`filter-btn ${triggerFilter === "news_triggered" ? "active" : ""}`}
                onClick={() => setTriggerFilter(triggerFilter === "news_triggered" ? "all" : "news_triggered")}
                title="Show only markets re-analyzed due to breaking news"
              >
                News triggered
              </button>
              <label className="resolved-toggle">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                />
                Show resolved
              </label>
            </div>
          </div>

          {markets.length === 0 ? (
            <div className="empty-state">
              {store.markets.length === 0 ? (
                <>
                  <p className="empty-title">No data yet</p>
                  <p className="empty-sub">Run a scan to fetch markets and extract signals via Claude.</p>
                  <button className="scan-btn" onClick={handleScan} disabled={scanning}>
                    {scanning ? "Scanning…" : "Run First Scan"}
                  </button>
                </>
              ) : (
                <p className="empty-sub">No markets match the current filters.</p>
              )}
            </div>
          ) : (
            <div className="card-grid">
              {markets.map((m) => (
                <MarketCard
                  key={m.id}
                  market={m}
                  onToggleSave={handleToggleSave}
                  position={openPositionsByMarket.get(m.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Paper Trades tab ── */}
      {mainTab === "trades" && (
        <div className="trades-panel">
          {/* Portfolio summary */}
          {pt && allPositions.length > 0 && (
            <div className="trades-summary">
              <div className="trades-summary-row">
                <div className="trades-stat">
                  <span className="trades-stat-label">Bankroll</span>
                  <span className="trades-stat-value">${pt.currentBankroll.toFixed(0)}</span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">Realized P&L</span>
                  <span className="trades-stat-value" style={{
                    color: pt.totalPnl > 0 ? "var(--green)" : pt.totalPnl < 0 ? "var(--red)" : "var(--text)"
                  }}>
                    {pt.totalPnl >= 0 ? "+" : ""}${pt.totalPnl.toFixed(2)}
                  </span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">Unrealized P&L</span>
                  <span className="trades-stat-value" style={{
                    color: totalUnrealizedPnl > 0 ? "var(--green)" : totalUnrealizedPnl < 0 ? "var(--red)" : "var(--text)"
                  }}>
                    {totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}
                  </span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">ROI</span>
                  <span className="trades-stat-value" style={{
                    color: pt.totalPnl > 0 ? "var(--green)" : pt.totalPnl < 0 ? "var(--red)" : "var(--text)"
                  }}>
                    {((pt.currentBankroll - pt.bankroll) / pt.bankroll * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">Win Rate</span>
                  <span className="trades-stat-value">{(pt.winRate * 100).toFixed(0)}%</span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">Max Drawdown</span>
                  <span className="trades-stat-value" style={{ color: pt.maxDrawdown > 0.1 ? "var(--red)" : "var(--text)" }}>
                    {(pt.maxDrawdown * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="trades-stat">
                  <span className="trades-stat-label">Open / Closed</span>
                  <span className="trades-stat-value">{openPositions.length} / {closedPositions.length}</span>
                </div>
              </div>
            </div>
          )}

          {/* Trade filter */}
          <div className="filter-row" style={{ marginBottom: 12 }}>
            {(["all", "open", "closed", "stopped"] as const).map((f) => {
              const count = f === "open" ? openPositions.length
                : f === "closed" ? closedPositions.length
                : f === "stopped" ? stoppedPositions.length
                : allPositions.length;
              return (
                <button
                  key={f}
                  className={`filter-btn ${tradeFilter === f ? "active" : ""}`}
                  onClick={() => setTradeFilter(f)}
                >
                  {f} ({count})
                </button>
              );
            })}
          </div>

          {/* Trades table */}
          {filteredPositions.length === 0 ? (
            <div className="empty-state">
              <p className="empty-sub">
                {allPositions.length === 0
                  ? "No paper trades yet. Positions open automatically when the model detects edge >= 5pp."
                  : "No trades match this filter."}
              </p>
            </div>
          ) : (
            <div className="trades-table-wrap">
              <table className="trades-table">
                <thead>
                  <tr>
                    <th scope="col">Market</th>
                    <th scope="col">Side</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Now</th>
                    <th scope="col">Size</th>
                    <th scope="col">Edge</th>
                    <th scope="col">Kelly</th>
                    <th scope="col">Opened</th>
                    <th scope="col">Status</th>
                    <th scope="col">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPositions
                    .sort((a, b) => {
                      // Open first, then by timestamp desc
                      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
                      return (b.entryTimestamp ?? "").localeCompare(a.entryTimestamp ?? "");
                    })
                    .map((pos) => (
                      <TradeRow key={pos.id} pos={pos} />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <footer className="footer">
        Signal extraction via Claude · Scoring model v1.0 · News monitor every 5min · Paper trading active
      </footer>
    </div>
  );
}

function TradeRow({ pos }: { pos: PaperPosition }) {
  const sideColor = pos.side === "YES" ? "var(--green)" : "var(--red)";
  // Edge from the position's perspective: NO trades have negative edgePct (YES overpriced)
  // but the edge *for the position* is positive — flip sign for NO
  const directedEdge = pos.side === "NO" ? -pos.edgeAtEntry : pos.edgeAtEntry;
  const edgeSign = directedEdge >= 0 ? "+" : "";

  // For open positions, show unrealized P&L; for closed/stopped, show realized
  const displayPnl = pos.status === "open" ? (pos.unrealizedPnl ?? 0) : (pos.pnl ?? 0);
  const pnlColor = displayPnl > 0 ? "var(--green)" : displayPnl < 0 ? "var(--red)" : "var(--muted)";

  // Edge decay: compare current vs entry (direction-adjusted)
  const currentEdgeRaw = pos.currentEdge ?? pos.edgeAtEntry;
  const currentEdge = pos.side === "NO" ? -currentEdgeRaw : currentEdgeRaw;
  const edgeDecay = currentEdge - directedEdge;

  return (
    <tr className={pos.status !== "open" ? "trade-closed" : ""}>
      <td className="trade-question" title={pos.marketQuestion ?? ""}>
        {(pos.marketQuestion ?? "").slice(0, 60)}{(pos.marketQuestion ?? "").length > 60 ? "…" : ""}
      </td>
      <td>
        <span className="trade-side" style={{ color: sideColor }}>{pos.side}</span>
      </td>
      <td>{pos.entryPrice}%{pos.exitPrice != null && <span style={{ color: "var(--muted)", fontSize: 10 }}> → {pos.exitPrice}%</span>}</td>
      <td style={{
        color: pos.currentPrice == null ? "var(--muted)"
          : pos.side === "YES"
            ? (pos.currentPrice > pos.entryPrice ? "var(--green)" : pos.currentPrice < pos.entryPrice ? "var(--red)" : "var(--muted)")
            : (pos.currentPrice < pos.entryPrice ? "var(--green)" : pos.currentPrice > pos.entryPrice ? "var(--red)" : "var(--muted)"),
      }}>
        {pos.currentPrice != null ? `${pos.currentPrice}%` : "—"}
      </td>
      <td>${pos.notionalSize.toFixed(0)}</td>
      <td style={{ color: directedEdge > 10 ? "var(--green)" : "var(--muted)" }}>
        {edgeSign}{directedEdge.toFixed(1)}pp
        {pos.status === "open" && edgeDecay !== 0 && (
          <span style={{ fontSize: 10, marginLeft: 2, color: edgeDecay < 0 ? "var(--red)" : "var(--green)" }}>
            ({edgeDecay > 0 ? "+" : ""}{edgeDecay.toFixed(1)})
          </span>
        )}
      </td>
      <td style={{ color: "var(--muted)" }}>{(pos.kellyFraction * 100).toFixed(1)}%</td>
      <td style={{ color: "var(--muted)", fontSize: 11 }}>
        {shortDate(pos.entryTimestamp)}
      </td>
      <td>
        {pos.status === "open" ? (
          <span className="trade-status-open">OPEN</span>
        ) : (pos.status === "stopped" || pos.exitReason !== "resolution") ? (
          // stopped status OR old pre-fix closed trades that were actually edge_decay/stop_loss
          <span className="trade-status-stopped" title={pos.exitReason ?? "stopped"}>
            {pos.exitReason === "stop_loss" ? "STOP" : pos.exitReason === "take_profit" ? "TP" : pos.exitReason === "edge_decay" ? "DECAY" : "CLOSED"}
          </span>
        ) : (
          // resolution close — show actual market outcome
          <span className="trade-status-closed">
            {pos.outcome === 1 ? "YES" : pos.outcome === 0 ? "NO" : "—"}
          </span>
        )}
      </td>
      <td>
        <span style={{ color: pnlColor, fontWeight: 700 }}>
          {displayPnl >= 0 ? "+" : ""}${displayPnl.toFixed(2)}
          {pos.status === "open" && <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2 }}>unreal.</span>}
          {pos.pnlPct != null && pos.status !== "open" && (
            <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.7 }}>
              ({(pos.pnlPct ?? 0) >= 0 ? "+" : ""}{(pos.pnlPct ?? 0).toFixed(0)}%)
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}
