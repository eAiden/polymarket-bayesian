// Public leaderboard — paper trading P&L, equity curve, open + closed positions.
// No auth required. force-dynamic so live data is served on every request.

import Link from "next/link";
import type { PaperTradingState, PaperPosition } from "@/lib/paper-trading";
import { loadPaperTradingAsync } from "@/lib/paper-trading";

export const dynamic = "force-dynamic";

function defaultState(): PaperTradingState {
  return { bankroll: 10_000, currentBankroll: 10_000, positions: [], totalPnl: 0, winRate: 0, maxDrawdown: 0 };
}


// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt$(n: number, prefix = true): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n).toFixed(2);
  const formatted = Number(abs).toLocaleString("en-US", { minimumFractionDigits: 2 });
  return prefix ? `${sign}$${formatted}` : `$${formatted}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─── Equity curve SVG ────────────────────────────────────────────────────────
// y = -cumulativePnl so gains go upward in visual space.
// ViewBox: "0 -(maxGain+10) (N+1) (maxGain+maxLoss+20)"

function EquityCurve({ positions }: { positions: PaperPosition[] }) {
  const settled = positions
    .filter(p => (p.status === "closed" || p.status === "stopped") && p.exitTimestamp)
    .sort((a, b) => (a.exitTimestamp ?? "").localeCompare(b.exitTimestamp ?? ""));

  if (settled.length === 0) {
    return (
      <svg viewBox="0 -10 100 30" preserveAspectRatio="none" style={{ width: "100%", height: "120px", display: "block" }}>
        <line x1="0" y1="0" x2="100" y2="0" stroke="#333" strokeWidth="1" />
        <text x="50" y="-3" textAnchor="middle" fill="#666" fontSize="3" fontFamily="monospace">
          No closed positions yet — check back soon.
        </text>
      </svg>
    );
  }

  // Build cumulative P&L series
  const points: Array<{ x: number; y: number; cum: number }> = [{ x: 0, y: 0, cum: 0 }];
  let cum = 0;
  for (let i = 0; i < settled.length; i++) {
    cum += settled[i].pnl ?? 0;
    points.push({ x: i + 1, y: -cum, cum });
  }

  const maxGain = Math.max(0, ...points.map(p => p.cum));
  const maxLoss = Math.max(0, ...points.map(p => -p.cum));
  const N = settled.length;
  const viewBox = `0 ${-(maxGain + 10)} ${N + 1} ${maxGain + maxLoss + 20}`;

  const polyline = points.map(p => `${p.x},${p.y}`).join(" ");

  // Zero line y position in this coordinate system
  const zeroY = 0;

  return (
    <svg viewBox={viewBox} preserveAspectRatio="none" style={{ width: "100%", height: "160px", display: "block" }}>
      {/* Zero baseline */}
      <line x1="0" y1={zeroY} x2={N + 1} y2={zeroY} stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
      {/* Equity curve */}
      <polyline
        points={polyline}
        fill="none"
        stroke="#1a7a40"
        strokeWidth={Math.max(0.4, (N + 1) / 300)}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Final value label */}
      {points.length > 1 && (() => {
        const last = points[points.length - 1];
        const label = `${last.cum >= 0 ? "+" : ""}$${Math.abs(last.cum).toFixed(0)}`;
        return (
          <text
            x={last.x}
            y={last.y - 2}
            textAnchor={last.x > N * 0.8 ? "end" : "start"}
            fill={last.cum >= 0 ? "#4ade80" : "#f87171"}
            fontSize={Math.max(1.5, (maxGain + maxLoss) / 15)}
            fontFamily="monospace"
          >{label}</text>
        );
      })()}
    </svg>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default async function LeaderboardPage({ searchParams }: { searchParams?: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const joined = params?.joined === "1";
  const state = await loadPaperTradingAsync().catch(() => defaultState());
  const { positions, bankroll, currentBankroll, totalPnl, winRate, maxDrawdown } = state;

  const open = positions.filter(p => p.status === "open");
  const closed = positions
    .filter(p => p.status === "closed" || p.status === "stopped")
    .sort((a, b) => (b.exitTimestamp ?? "").localeCompare(a.exitTimestamp ?? ""));

  const unrealizedPnl = open.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const pnlPct = bankroll > 0 ? totalPnl / bankroll : 0;
  const settled = positions.filter(p => p.status === "closed" || p.status === "stopped");

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px 80px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13, color: "#e0e0e0", background: "#0a0a0a", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>
            Polymarket Signal Leaderboard
          </h1>
          <Link
            href="/"
            style={{
              fontSize: 11, color: "#666",
              background: "#111", border: "1px solid #222",
              borderRadius: 5, padding: "4px 10px",
              textDecoration: "none",
            }}
          >
            ← Dashboard
          </Link>
        </div>
        <p style={{ color: "#666", fontSize: 12 }}>
          Paper trading P&L — hypothetical positions taken on detected mispricings. No real money.
          Every trade shown, including losers.
        </p>
      </div>

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 28 }}>
        {[
          { label: "Realized P&L", value: fmt$(totalPnl), color: totalPnl >= 0 ? "#4ade80" : "#f87171" },
          { label: "Return", value: fmtPct(pnlPct), color: pnlPct >= 0 ? "#4ade80" : "#f87171" },
          { label: "Unrealized P&L", value: fmt$(unrealizedPnl), color: unrealizedPnl >= 0 ? "#4ade80" : "#f87171" },
          { label: "Win Rate", value: settled.length > 0 ? `${(winRate * 100).toFixed(0)}%` : "—", color: "#e0e0e0" },
          { label: "Max Drawdown", value: maxDrawdown > 0 ? `-${(maxDrawdown * 100).toFixed(1)}%` : "0%", color: maxDrawdown > 0.1 ? "#f87171" : "#e0e0e0" },
          { label: "Positions", value: `${open.length} open / ${settled.length} closed`, color: "#666" },
        ].map(s => (
          <div key={s.label} style={{ background: "#111", border: "1px solid #222", borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ color: "#666", fontSize: 11, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
            <div style={{ color: s.color, fontSize: 16, fontWeight: 700 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={{ background: "#111", border: "1px solid #222", borderRadius: 8, padding: "16px 20px", marginBottom: 28 }}>
        <div style={{ color: "#666", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
          Cumulative Realized P&L
        </div>
        <EquityCurve positions={positions} />
        <div style={{ display: "flex", justifyContent: "space-between", color: "#444", fontSize: 11, marginTop: 6 }}>
          <span>Trade #0</span>
          {settled.length > 0 && <span>Trade #{settled.length}</span>}
        </div>
      </div>

      {/* Open positions */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, color: "#e0e0e0" }}>
          Open Positions ({open.length})
        </h2>
        {open.length === 0 ? (
          <div style={{ color: "#444", fontSize: 12, padding: "16px 0" }}>No open positions.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#555", fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #222" }}>
                  {["Market", "Side", "Edge at Entry", "Entry Price", "Notional", "Unrealized P&L", "Last Signal"].map(h => (
                    <th key={h} scope="col" style={{ textAlign: "left", padding: "6px 10px", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.map(p => {
                  const lastUpdate = p.edgeHistory?.[p.edgeHistory.length - 1];
                  const headline = lastUpdate?.headline ?? (lastUpdate ? `edge ${lastUpdate.edge > 0 ? "+" : ""}${lastUpdate.edge.toFixed(1)}pp` : "—");
                  return (
                    <tr key={p.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                      <td style={{ padding: "10px 10px", maxWidth: 320 }}>
                        <div style={{ color: "#e0e0e0", lineHeight: 1.4 }}>{p.marketQuestion.slice(0, 100)}{p.marketQuestion.length > 100 ? "…" : ""}</div>
                        <div style={{ color: "#444", fontSize: 11, marginTop: 2 }}>{fmtDate(p.entryTimestamp)}</div>
                      </td>
                      <td style={{ padding: "10px 10px" }}>
                        <span style={{ color: p.side === "YES" ? "#4ade80" : "#f87171", fontWeight: 700 }}>{p.side}</span>
                      </td>
                      <td style={{ padding: "10px 10px", color: p.edgeAtEntry >= 0 ? "#4ade80" : "#f87171" }}>
                        {p.edgeAtEntry > 0 ? "+" : ""}{p.edgeAtEntry.toFixed(1)}pp
                      </td>
                      <td style={{ padding: "10px 10px", color: "#aaa" }}>
                        {p.entryPrice.toFixed(1)}¢
                      </td>
                      <td style={{ padding: "10px 10px", color: "#aaa" }}>
                        ${p.notionalSize.toFixed(2)}
                      </td>
                      <td style={{ padding: "10px 10px", color: (p.unrealizedPnl ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                        {fmt$(p.unrealizedPnl ?? 0)}
                      </td>
                      <td style={{ padding: "10px 10px", color: "#666", maxWidth: 200, fontSize: 11 }}>
                        {headline.length > 80 ? headline.slice(0, 80) + "…" : headline}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Closed positions */}
      <div style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, color: "#e0e0e0" }}>
          Closed Positions ({closed.length})
        </h2>
        {closed.length === 0 ? (
          <div style={{ color: "#444", fontSize: 12, padding: "16px 0" }}>No closed positions yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#555", fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #222" }}>
                  {["Market", "Side", "Entry", "Exit", "P&L", "Reason", "Closed"].map(h => (
                    <th key={h} scope="col" style={{ textAlign: "left", padding: "6px 10px", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map(p => (
                  <tr key={p.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "10px 10px", maxWidth: 320 }}>
                      <div style={{ color: "#e0e0e0", lineHeight: 1.4 }}>{p.marketQuestion.slice(0, 100)}{p.marketQuestion.length > 100 ? "…" : ""}</div>
                    </td>
                    <td style={{ padding: "10px 10px" }}>
                      <span style={{ color: p.side === "YES" ? "#4ade80" : "#f87171", fontWeight: 700 }}>{p.side}</span>
                    </td>
                    <td style={{ padding: "10px 10px", color: "#aaa" }}>{p.entryPrice.toFixed(1)}¢</td>
                    <td style={{ padding: "10px 10px", color: "#aaa" }}>{p.exitPrice !== undefined ? `${p.exitPrice.toFixed(1)}¢` : "—"}</td>
                    <td style={{ padding: "10px 10px", fontWeight: 600, color: (p.pnl ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                      {fmt$(p.pnl ?? 0)}
                    </td>
                    <td style={{ padding: "10px 10px", color: "#666", fontSize: 11 }}>
                      {p.exitReason ?? "—"}
                    </td>
                    <td style={{ padding: "10px 10px", color: "#555", fontSize: 11 }}>
                      {fmtDate(p.exitTimestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Waitlist CTA */}
      <div style={{ background: "#111", border: "1px solid #222", borderRadius: 10, padding: "28px 32px", maxWidth: 540 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Get the daily signal digest</h3>
        <p style={{ color: "#666", fontSize: 12, marginBottom: 18, lineHeight: 1.6 }}>
          Top 3 edge opportunities each morning before the market opens. Free while in beta.
          We email when notable positions close, not daily noise.
        </p>
        {joined ? (
          <div style={{ color: "#4ade80", fontSize: 13, padding: "10px 14px", background: "#0d1f0d", border: "1px solid #1a4a1a", borderRadius: 6 }}>
            You&apos;re on the list. We&apos;ll reach out when the signal quality threshold is hit.
          </div>
        ) : (
          <WaitlistForm />
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 48, color: "#444", fontSize: 11, lineHeight: 1.8 }}>
        <p>Paper trading only. No real money. Past performance does not predict future results.</p>
        <p>Bankroll: $10,000 starting. Quarter-Kelly sizing. Max 5% per position.</p>
      </div>
    </div>
  );
}

// ─── Waitlist form (client component) ────────────────────────────────────────

function WaitlistForm() {
  // This is a server component file, so we use a plain HTML form with action
  // pointing to the waitlist API. Works without JS.
  return (
    <form
      action="/api/waitlist"
      method="POST"
      style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
    >
      <input
        type="email"
        name="email"
        required
        autoComplete="email"
        placeholder="you@example.com…"
        className="waitlist-input"
      />
      <button
        type="submit"
        style={{
          background: "#818cf8",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "9px 20px",
          fontWeight: 600,
          fontSize: 13,
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Join waitlist
      </button>
    </form>
  );
}
