# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Next.js dev server (port 3000)
npm run build        # Production build
npm run test         # Run all tests (vitest)
npm run test:watch   # Watch mode tests
npx vitest run __tests__/scoring.test.ts  # Run a single test file
```

## Architecture

This is a **Bayesian prediction system for Polymarket** — it fetches prediction markets, extracts news signals via Claude, applies Bayesian updates to estimate fair probabilities, and paper-trades on the resulting edge.

### Data Pipeline Flow

```
Polymarket Gamma API → Filter Markets → Enrich (news, orderbook, economic data)
→ Batched Claude Signal Extraction → Likelihood Ratio → Bayesian Log-Odds Update
→ Scoring → Paper Trading (Kelly sizing) → Postgres Persist → Next.js UI
```

The pipeline is orchestrated by `lib/pipeline.ts::runScanPipeline()`, which acquires a Postgres advisory lock (`pg_try_advisory_lock(42)`) to prevent concurrent scans.

### Key Modules (lib/)

- **pipeline.ts** — Main orchestration entry point. Two modes: full scan and fast single-market reanalysis (news-triggered).
- **signal-extraction.ts** — Batched Claude Sonnet calls (10 markets/call). Three-tier news cache: DB (6h TTL) → in-memory L1 → Tavily/Google RSS fallback.
- **bayesian.ts** — Log-odds likelihood ratio updates. LR clamped to [0.25, 4.0], posterior to [1%, 99%]. 90% credible intervals via normal approximation.
- **scoring.ts** — 17 weighted features (news, microstructure, momentum, cross-market, time, calibration). Outputs edge estimate [-30, +30]pp with confidence level.
- **paper-trading.ts** — Quarter Kelly sizing with confidence discounting (high=1.0, medium=0.6, low=0.3), capped at 5% bankroll. Opens when edge >= 5pp.
- **db.ts** — Postgres via `postgres.js` tagged templates. Tables: markets, signals, price_history, trades, calibration, news_alerts, news_cache. Advisory locks for scan exclusivity.
- **calibration.ts** — Brier scores, per-category bias tracking, hit rate. Bias fed back into Claude prompts for debiasing.
- **features.ts** — Computes FeatureVector from enrichment data for the scoring model.
- **polymarket.ts** — Gamma API client. Filters: 10-90% YES probability, <=90 days to resolution, >$10k volume.

### Scheduling & Startup

`instrumentation.ts` runs on Next.js server startup via the `register()` hook:
1. Creates all DB tables/indexes (idempotent)
2. Schedules daily full scan at 00:00 UTC (08:00 Asia/Manila) and news monitor every 5 minutes via `setInterval`

There is no separate server process — scheduling is embedded in the Next.js server.

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scan` | POST | Triggers full pipeline scan; streams progress via SSE |
| `/api/markets` | GET | Returns market store (markets + calibration + paper trading) |
| `/api/markets/[id]` | GET | Single market detail |
| `/api/health` | GET | Health check (Railway) |
| `/api/alerts` | GET | News alerts history |
| `/api/model` | GET | Model version & weights |
| `/api/train` | POST | Model training (placeholder) |
| `/api/waitlist` | POST | Email capture |

### Deployment

Deployed on **Railway** via Docker multi-stage build. Health check at `/api/health`.

### Path Aliases

`@/*` maps to project root (configured in tsconfig.json and vitest.config.ts).

### External APIs

- **Anthropic Claude** (Sonnet 4.6) — signal extraction
- **Polymarket Gamma API** — market data
- **Polymarket CLOB API** — orderbook/trade data
- **Tavily Search** — news enrichment
- **FRED API** — economic indicators (CPI, unemployment, Fed funds)
- **Coingecko** — crypto prices
