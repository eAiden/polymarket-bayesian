// Public leaderboard — paper trading P&L, equity curve, open + closed positions.
// No auth required. force-dynamic so live data is served on every request.

import Link from "next/link";
import type { PaperTradingState, PaperPosition } from "@/lib/paper-trading";
import { getPaperTradingState, defaultPaperTradingState } from "@/lib/db";

export const dynamic = "force-dynamic";

const loadPaperTradingAsync = getPaperTradingState;

// ─── Design tokens (mirrors globals.css Operator theme) ───────────────────────
const T = {
  bg:      "#0d1117",
  surface: "#161b22",
  border:  "#21262d",
  text:    "#e6edf3",
  muted:   "#8b949e",
  dim:     "#484f58",
  green:   "#3fb950",
  red:     "#f85149",
  accent:  "#10b981",
  yellow:  "#e3b341",
  sans:    "Inter, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono:    "ui-monospace, 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
} as const;

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

function EquityCurve({ positions }: { positions: PaperPosition[] }) {
  const settled = positions
    .filter(p => (p.status === "closed" || p.status === "stopped") && p.exitTimestamp)
    .sort((a, b) => (a.exitTimestamp ?? "").localeCompare(b.exitTimestamp ?? ""));

  if (settled.length === 0) {
    return (
      <svg viewBox="0 -10 100 30" preserveAspectRatio="none" style={{ width: "100%", height: "120px", display: "block" }}>
        <line x1="0" y1="0" x2="100" y2="0" stroke={T.border} strokeWidth="1" />
        <text x="50" y="-3" textAnchor="middle" fill={T.dim} fontSize="3" fontFamily={T.sans}>
          No closed positions yet — check back soon.
        </text>
      </svg>
    );
  }

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
  const last = points[points.length - 1];
  const label = `${last.cum >= 0 ? "+" : ""}$${Math.abs(last.cum).toFixed(0)}`;

  return (
    <svg viewBox={viewBox} preserveAspectRatio="none" style={{ width: "100%", height: "160px", display: "block" }}>
      <line x1="0" y1="0" x2={N + 1} y2="0" stroke={T.border} strokeWidth="0.5" strokeDasharray="2,2" />
      <polyline
        points={polyline}
        fill="none"
        stroke={T.accent}
        strokeWidth={Math.max(0.4, (N + 1) / 300)}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {points.length > 1 && (
        <text
          x={last.x}
          y={last.y - 2}
          textAnchor={last.x > N * 0.8 ? "end" : "start"}
          fill={last.cum >= 0 ? T.green : T.red}
          fontSize={Math.max(1.5, (maxGain + maxLoss) / 15)}
          fontFamily={T.mono}
        >{label}</text>
      )}
    </svg>
  );
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
};

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "6px 10px", fontWeight: 600,
  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em",
  color: T.muted, fontFamily: T.sans, whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 10px", borderBottom: `1px solid rgba(255,255,255,0.04)`,
  verticalAlign: "middle", fontFamily: T.mono, whiteSpace: "nowrap",
};

const sectionHeading: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, marginBottom: 14, color: T.text,
  fontFamily: T.sans,
  textTransform: "uppercase", letterSpacing: "0.06em",
};

// ─── Page component ───────────────────────────────────────────────────────────

export default async function LeaderboardPage({ searchParams }: { searchParams?: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const joined = params?.joined === "1";
  const state = await loadPaperTradingAsync().catch(() => defaultPaperTradingState());
  const { positions, bankroll, currentBankroll, totalPnl, winRate, maxDrawdown } = state;

  const open = positions.filter(p => p.status === "open");
  const closed = positions
    .filter(p => p.status === "closed" || p.status === "stopped")
    .sort((a, b) => (b.exitTimestamp ?? "").localeCompare(a.exitTimestamp ?? ""));

  const unrealizedPnl = open.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const pnlPct = bankroll > 0 ? totalPnl / bankroll : 0;
  const settled = positions.filter(p => p.status === "closed" || p.status === "stopped");

  const stats = [
    { label: "Realized P&L",   value: fmt$(totalPnl),      color: totalPnl >= 0 ? T.green : T.red },
    { label: "Return",          value: fmtPct(pnlPct),      color: pnlPct >= 0 ? T.green : T.red },
    { label: "Unrealized P&L", value: fmt$(unrealizedPnl),  color: unrealizedPnl >= 0 ? T.green : T.red },
    { label: "Win Rate",        value: settled.length > 0 ? `${(winRate * 100).toFixed(0)}%` : "—", color: T.text },
    { label: "Max Drawdown",    value: maxDrawdown > 0 ? `-${(maxDrawdown * 100).toFixed(1)}%` : "0%", color: maxDrawdown > 0.1 ? T.red : T.text },
    { label: "Positions",       value: `${open.length} open / ${settled.length} closed`, color: T.muted },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px 80px", fontFamily: T.sans, fontSize: 13, color: T.text, background: T.bg, minHeight: "100vh" }}>

      {/* Google Fonts — same as dashboard */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');`}</style>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.4px", fontFamily: T.sans }}>
            Polymarket Signal — Leaderboard
          </h1>
          <Link
            href="/"
            style={{
              fontSize: 11, color: T.muted, fontWeight: 500,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: "4px 10px",
              textDecoration: "none", fontFamily: T.sans,
            }}
          >
            ← Dashboard
          </Link>
        </div>
        <p style={{ color: T.muted, fontSize: 12, lineHeight: 1.6 }}>
          Paper trading P&L — hypothetical positions taken on detected mispricings. No real money.
          Every trade shown, including losers.
        </p>
      </div>

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 24 }}>
        {stats.map(s => (
          <div key={s.label} style={{ ...card, padding: "14px 16px" }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, fontFamily: T.sans }}>{s.label}</div>
            <div style={{ color: s.color, fontSize: 16, fontWeight: 700, fontFamily: T.mono }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={{ ...card, padding: "16px 20px", marginBottom: 28 }}>
        <div style={{ color: T.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 12, fontFamily: T.sans }}>
          Cumulative Realized P&L
        </div>
        <EquityCurve positions={positions} />
        <div style={{ display: "flex", justifyContent: "space-between", color: T.dim, fontSize: 10, marginTop: 6, fontFamily: T.mono }}>
          <span>Trade #0</span>
          {settled.length > 0 && <span>Trade #{settled.length}</span>}
        </div>
      </div>

      {/* Open positions */}
      <div style={{ marginBottom: 28 }}>
        <div style={sectionHeading}>Open Positions <span style={{ color: T.muted, fontWeight: 400 }}>({open.length})</span></div>
        {open.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12, padding: "16px 0" }}>No open positions.</div>
        ) : (
          <div style={{ overflowX: "auto", ...card }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Market", "Side", "Edge at Entry", "Entry Price", "Notional", "Unrealized P&L", "Last Signal"].map(h => (
                    <th key={h} scope="col" style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.map(p => {
                  const lastUpdate = p.edgeHistory?.[p.edgeHistory.length - 1];
                  const headline = lastUpdate?.headline ?? (lastUpdate ? `edge ${lastUpdate.edge > 0 ? "+" : ""}${lastUpdate.edge.toFixed(1)}pp` : "—");
                  return (
                    <tr key={p.id}>
                      <td style={{ ...tdStyle, fontFamily: T.sans, maxWidth: 320 }}>
                        <div style={{ color: T.text, lineHeight: 1.4 }}>{p.marketQuestion.slice(0, 100)}{p.marketQuestion.length > 100 ? "…" : ""}</div>
                        <div style={{ color: T.dim, fontSize: 11, marginTop: 2, fontFamily: T.mono }}>{fmtDate(p.entryTimestamp)}</div>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: p.side === "YES" ? T.green : T.red, fontWeight: 700 }}>{p.side}</span>
                      </td>
                      <td style={{ ...tdStyle, color: p.edgeAtEntry >= 0 ? T.green : T.red }}>
                        {p.edgeAtEntry > 0 ? "+" : ""}{p.edgeAtEntry.toFixed(1)}pp
                      </td>
                      <td style={{ ...tdStyle, color: T.muted }}>{p.entryPrice.toFixed(1)}¢</td>
                      <td style={{ ...tdStyle, color: T.muted }}>${p.notionalSize.toFixed(2)}</td>
                      <td style={{ ...tdStyle, color: (p.unrealizedPnl ?? 0) >= 0 ? T.green : T.red }}>
                        {fmt$(p.unrealizedPnl ?? 0)}
                      </td>
                      <td style={{ ...tdStyle, color: T.muted, maxWidth: 200, fontSize: 11, fontFamily: T.sans }}>
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
        <div style={sectionHeading}>Closed Positions <span style={{ color: T.muted, fontWeight: 400 }}>({closed.length})</span></div>
        {closed.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12, padding: "16px 0" }}>No closed positions yet.</div>
        ) : (
          <div style={{ overflowX: "auto", ...card }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Market", "Side", "Entry", "Exit", "P&L", "Reason", "Closed"].map(h => (
                    <th key={h} scope="col" style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map(p => (
                  <tr key={p.id} style={{ opacity: 0.85 }}>
                    <td style={{ ...tdStyle, fontFamily: T.sans, maxWidth: 320 }}>
                      <div style={{ color: T.text, lineHeight: 1.4 }}>{p.marketQuestion.slice(0, 100)}{p.marketQuestion.length > 100 ? "…" : ""}</div>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: p.side === "YES" ? T.green : T.red, fontWeight: 700 }}>{p.side}</span>
                    </td>
                    <td style={{ ...tdStyle, color: T.muted }}>{p.entryPrice.toFixed(1)}¢</td>
                    <td style={{ ...tdStyle, color: T.muted }}>{p.exitPrice !== undefined ? `${p.exitPrice.toFixed(1)}¢` : "—"}</td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: (p.pnl ?? 0) >= 0 ? T.green : T.red }}>
                      {fmt$(p.pnl ?? 0)}
                    </td>
                    <td style={{ ...tdStyle, color: T.muted, fontSize: 11, fontFamily: T.sans }}>
                      {p.exitReason ?? "—"}
                    </td>
                    <td style={{ ...tdStyle, color: T.dim, fontSize: 11, fontFamily: T.mono }}>
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
      <div style={{ ...card, padding: "28px 32px", maxWidth: 540 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, fontFamily: T.sans }}>Get the daily signal digest</h3>
        <p style={{ color: T.muted, fontSize: 12, marginBottom: 18, lineHeight: 1.6, fontFamily: T.sans }}>
          Top 3 edge opportunities each morning before the market opens. Free while in beta.
          We email when notable positions close, not daily noise.
        </p>
        {joined ? (
          <div style={{ color: T.green, fontSize: 13, padding: "10px 14px", background: "rgba(16,185,129,0.08)", border: `1px solid rgba(16,185,129,0.25)`, borderRadius: 8, fontFamily: T.sans }}>
            You&apos;re on the list. We&apos;ll reach out when the signal quality threshold is hit.
          </div>
        ) : (
          <WaitlistForm />
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 48, color: T.dim, fontSize: 11, lineHeight: 1.8, fontFamily: T.sans }}>
        <p>Paper trading only. No real money. Past performance does not predict future results.</p>
        <p>Bankroll: ${bankroll.toLocaleString()} starting. Quarter-Kelly sizing. Max 5% per position.</p>
      </div>
    </div>
  );
}

// ─── Waitlist form (server component — plain HTML form, works without JS) ────

function WaitlistForm() {
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
        placeholder="you@example.com"
        className="waitlist-input"
      />
      <button
        type="submit"
        style={{
          background: "#10b981",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "9px 20px",
          fontWeight: 600,
          fontSize: 13,
          fontFamily: "Inter, system-ui, -apple-system, sans-serif",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Join waitlist
      </button>
    </form>
  );
}
