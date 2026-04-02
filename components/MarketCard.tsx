"use client";

import { useState } from "react";
import type { TrackedMarket, DailySnapshot } from "@/lib/types";
import type { PaperPosition } from "@/lib/paper-trading";
import { Sparkline } from "./Sparkline";

interface MarketCardProps {
  market: TrackedMarket;
  onToggleSave?: (id: string) => void;
  position?: PaperPosition; // open paper position for this market, if any
}

function daysLabel(days: number): string {
  if (days <= 0) return "Resolves today";
  if (days === 1) return "1 day left";
  return `${days}d left`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
}

function priceMovement(history: TrackedMarket["history"]): { delta: number; label: string } | null {
  if (!Array.isArray(history) || history.length < 2) return null;
  const prev = history[history.length - 2].marketProb;
  const curr = history[history.length - 1].marketProb;
  const delta = curr - prev;
  if (delta === 0) return null;
  const sign = delta > 0 ? "+" : "";
  return { delta, label: `${sign}${delta}pp` };
}

function algoHistory(history: DailySnapshot[]): DailySnapshot[] {
  if (!Array.isArray(history)) return [];
  return history.filter(s => s.fairProb != null).reverse();
}

export function MarketCard({ market, onToggleSave, position }: MarketCardProps) {
  const [analysisTab, setAnalysisTab] = useState<"current" | "past">("current");

  const move = priceMovement(market.history);
  const edgeSign = market.edge >= 0 ? "+" : "";
  const edgeColor =
    market.edgeLevel === "high"
      ? "var(--green)"
      : market.edgeLevel === "medium"
      ? "var(--accent)"
      : "var(--muted)";

  const directionColor = market.direction === "YES" ? "var(--green)" : "var(--red)";
  const pastAlgo = algoHistory(market.history);

  // Parse signal data from reasoning (v2 format: "Signal-based edge: ...")
  const isSignalBased = market.reasoning?.startsWith("Signal-based edge:");

  // News freshness
  const newsAgeBadge = market.newsAge === "breaking"
    ? { label: "Breaking", cls: "news-badge-breaking" }
    : market.newsAge === "recent"
    ? { label: "Recent", cls: "news-badge-recent" }
    : market.newsAge === "stale"
    ? { label: "Stale", cls: "news-badge-stale" }
    : null;

  // Paper P&L for open position
  const unrealizedPnl = position?.unrealizedPnl ?? null;

  // Edge bar: zero-centered, -30 to +30
  const edgeBarPct = Math.min(100, Math.max(0, (market.edge + 30) / 60 * 100));

  return (
    <div
      className="market-card"
      style={{
        borderLeft: `3px solid ${edgeColor}`,
        opacity: market.resolved ? 0.6 : 1,
      }}
    >
      {/* Header */}
      <div className="card-header">
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="category-badge">{market.category}</span>
          {newsAgeBadge && (
            <span className={`news-badge ${newsAgeBadge.cls}`}>{newsAgeBadge.label}</span>
          )}
          {market.lastTriggerType === "news_triggered" && (
            <span className="trigger-badge">⚡ News</span>
          )}
        </div>
        <div className="card-meta">
          {market.resolved && <span className="resolved-badge">Resolved</span>}
          {unrealizedPnl !== null && (
            <span
              className="pnl-badge"
              style={{ color: unrealizedPnl >= 0 ? "var(--green)" : "var(--red)" }}
              title={`Open position: $${position?.notionalSize?.toFixed(0)} ${position?.side}`}
            >
              {unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(2)}
            </span>
          )}
          <span style={{ color: "var(--muted)", fontSize: 11 }}>
            {daysLabel(market.daysUntilResolution)}
          </span>
          {onToggleSave && (
            <button
              className="save-btn"
              onClick={() => onToggleSave(market.id)}
              title={market.saved ? "Unsave" : "Save"}
              aria-label={market.saved ? "Unsave market" : "Save market"}
            >
              {market.saved ? "★" : "☆"}
            </button>
          )}
        </div>
      </div>

      {/* Title */}
      <a
        href={market.url ?? `https://polymarket.com`}
        target="_blank"
        rel="noopener noreferrer"
        className="market-title"
      >
        {market.title}
      </a>

      {/* Edge bar — zero-centered */}
      <div className="edge-bar-wrap">
        <div className="edge-bar">
          <div className="edge-bar-center" />
          <div
            className="edge-bar-fill"
            style={{
              left: market.edge >= 0 ? "50%" : `${edgeBarPct}%`,
              width: `${Math.abs(market.edge) / 60 * 100}%`,
              background: edgeColor,
            }}
          />
        </div>
        <div className="edge-bar-labels">
          <span>-30pp</span>
          <span style={{ color: edgeColor, fontWeight: 700 }}>
            {edgeSign}{market.edge.toFixed(1)}pp
          </span>
          <span>+30pp</span>
        </div>
      </div>

      {/* Market price + direction */}
      <div className="card-badges">
        <span style={{ fontSize: 12 }}>
          Market: <strong>{market.marketProb}%</strong>
          {move && (
            <strong
              style={{
                marginLeft: 4,
                fontSize: 10,
                color: move.delta > 0 ? "var(--red)" : "var(--green)",
              }}
            >
              {move.label}
            </strong>
          )}
        </span>
        <span className="direction-badge" style={{ background: directionColor }}>
          BUY {market.direction}
        </span>
        {market.confidence && (
          <span className="confidence-badge">{market.confidence} conf.</span>
        )}
        <span style={{ color: "var(--muted)", fontSize: 11 }}>{market.volume}</span>
      </div>

      {/* Sparkline */}
      <div className="sparkline-wrap">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="sparkline-label">Price history</span>
          {Array.isArray(market.history) && market.history.length >= 2 && (() => {
            const first = market.history[0].marketProb;
            const last = market.history[market.history.length - 1].marketProb;
            const total = last - first;
            const sign = total >= 0 ? "+" : "";
            return (
              <span style={{ fontSize: 10, color: total > 0 ? "var(--red)" : total < 0 ? "var(--green)" : "var(--muted)" }}>
                {sign}{total}pp since tracked
              </span>
            );
          })()}
        </div>
        <Sparkline history={market.history} />
      </div>

      {/* ── Analysis Tabs ── */}
      <div className="fv-tabs">
        <div className="fv-tab-bar">
          <button
            className={`fv-tab-btn ${analysisTab === "current" ? "active" : ""}`}
            onClick={() => setAnalysisTab("current")}
          >
            Signals
          </button>
          <button
            className={`fv-tab-btn ${analysisTab === "past" ? "active" : ""}`}
            onClick={() => setAnalysisTab("past")}
          >
            History
            {pastAlgo.length > 0 && (
              <span className="fv-tab-count">{pastAlgo.length}</span>
            )}
          </button>
        </div>

        {/* Current: signals + key factors */}
        {analysisTab === "current" && (
          <div className="fv-panel">
            {/* Top contributors (scoring drivers) */}
            {market.topContributors && market.topContributors.length > 0 && (
              <div className="contributors">
                {market.topContributors.map((c, i) => (
                  <div key={i} className="contributor-row">
                    <span className="contributor-feature">{c.feature}</span>
                    <span
                      className="contributor-bar"
                      style={{
                        width: `${Math.min(100, Math.abs(c.contribution) / 10 * 100)}%`,
                        background: c.contribution >= 0 ? "var(--green)" : "var(--red)",
                        opacity: 0.7,
                      }}
                    />
                    <span
                      className="contributor-value"
                      style={{ color: c.contribution >= 0 ? "var(--green)" : "var(--red)" }}
                    >
                      {c.contribution >= 0 ? "+" : ""}{c.contribution.toFixed(1)}pp
                    </span>
                  </div>
                ))}
              </div>
            )}

            {market.keyFactors &&
              ((market.keyFactors.bullish?.length ?? 0) > 0 || (market.keyFactors.bearish?.length ?? 0) > 0) && (
                <div className="key-factors">
                  {(market.keyFactors.bullish ?? []).map((f, i) => (
                    <span key={`b${i}`} className="signal-chip signal-yes">{f}</span>
                  ))}
                  {(market.keyFactors.bearish ?? []).map((f, i) => (
                    <span key={`r${i}`} className="signal-chip signal-no">{f}</span>
                  ))}
                </div>
              )}

            {market.reasoning && (
              <div className="reasoning">
                <p>{market.reasoning}</p>
                {(market.sources?.length ?? 0) > 0 && (
                  <div className="sources">
                    {(market.sources ?? []).map((s, i) => (
                      <span key={i} className="source-tag">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Past estimates */}
        {analysisTab === "past" && (
          <div className="fv-panel">
            {pastAlgo.length === 0 ? (
              <p style={{ fontSize: 11, color: "var(--muted)", margin: 0 }}>
                No past estimates yet.
              </p>
            ) : (
              <table className="algo-history-table">
                <thead>
                  <tr>
                    <th>Scan time</th>
                    <th>Fair est.</th>
                    <th>Market</th>
                    <th>Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {pastAlgo.map((snap, i) => {
                    const snapEdge = snap.fairProb! - snap.marketProb;
                    const snapSign = snapEdge >= 0 ? "+" : "";
                    const snapCol = Math.abs(snapEdge) > 15
                      ? "var(--green)"
                      : Math.abs(snapEdge) > 8
                      ? "var(--accent)"
                      : "var(--muted)";
                    return (
                      <tr key={snap.date} style={{ opacity: i === 0 ? 1 : 0.75 }}>
                        <td style={{ color: "var(--muted)" }}>
                          {shortDate(snap.date)}
                          {i === 0 && <span className="latest-badge">latest</span>}
                        </td>
                        <td><strong style={{ color: "var(--green)" }}>{snap.fairProb}%</strong></td>
                        <td>{snap.marketProb}%</td>
                        <td style={{ color: snapCol }}><strong>{snapSign}{snapEdge.toFixed(0)}pp</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="card-footer">
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          Updated {relativeTime(market.lastUpdated)} · Ends {market.endDate}
        </span>
        <a
          href={market.url ?? "https://polymarket.com"}
          target="_blank"
          rel="noopener noreferrer"
          className="pm-link"
        >
          View on Polymarket
        </a>
      </div>
    </div>
  );
}
