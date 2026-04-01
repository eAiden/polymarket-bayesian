"use client";

import type { DailySnapshot } from "@/lib/types";

interface SparklineProps {
  history: DailySnapshot[];
  width?: number;
  height?: number;
}

export function Sparkline({ history, width = 140, height = 36 }: SparklineProps) {
  if (history.length < 2) {
    return (
      <div style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 10, color: "var(--muted)" }}>tracking…</span>
      </div>
    );
  }

  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;

  // Scale 0-100 to SVG coordinates
  const toY = (v: number) => pad + h - (v / 100) * h;
  const toX = (i: number) => pad + (i / (history.length - 1)) * w;

  // Market price polyline
  const marketPoints = history
    .map((d, i) => `${toX(i)},${toY(d.marketProb)}`)
    .join(" ");

  // Fair prob dots (only on days where we have Bayesian estimate)
  const fairDots = history.filter((d) => d.fairProb !== undefined);

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }} aria-hidden="true">
      {/* 50% reference line */}
      <line
        x1={pad} y1={toY(50)} x2={pad + w} y2={toY(50)}
        stroke="var(--border)" strokeWidth={1} strokeDasharray="3,3"
      />
      {/* Market price line */}
      <polyline
        points={marketPoints}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Fair prob dots */}
      {fairDots.map((d, i) => {
        const idx = history.findIndex((h) => h.date === d.date);
        return (
          <circle
            key={i}
            cx={toX(idx)}
            cy={toY(d.fairProb!)}
            r={2.5}
            fill="var(--green)"
            stroke="var(--bg)"
            strokeWidth={1}
          />
        );
      })}
      {/* Latest market price dot */}
      <circle
        cx={toX(history.length - 1)}
        cy={toY(history[history.length - 1].marketProb)}
        r={3}
        fill="var(--accent)"
        stroke="var(--bg)"
        strokeWidth={1}
      />
    </svg>
  );
}
