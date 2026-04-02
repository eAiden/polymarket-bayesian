import type { OrderBookData, TradeData } from "./types";

const CLOB_BASE = "https://clob.polymarket.com";

// ─── Order Book ──────────────────────────────────────────────────────────────

export async function fetchOrderBook(tokenId: string): Promise<OrderBookData | null> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    try {
      const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`, {
        cache: "no-store",
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();

      const bids: Array<{ price: number; size: number }> = (Array.isArray(data.bids) ? data.bids : [])
        .map((b: { price: string; size: string }) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .filter((b: { price: number; size: number }) => !isNaN(b.price) && !isNaN(b.size));
      const asks: Array<{ price: number; size: number }> = (Array.isArray(data.asks) ? data.asks : [])
        .map((a: { price: string; size: string }) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .filter((a: { price: number; size: number }) => !isNaN(a.price) && !isNaN(a.size));

      if (bids.length === 0 && asks.length === 0) return null;

      const bestBid = bids.length > 0 ? Math.max(...bids.map(b => b.price)) : 0;
      const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => a.price)) : 1;
      const midPrice = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;

      // Depth within 5% of mid price
      const depthRange = 0.05;
      const bidDepth = bids
        .filter(b => b.price >= midPrice - depthRange)
        .reduce((sum, b) => sum + b.price * b.size, 0);
      const askDepth = asks
        .filter(a => a.price <= midPrice + depthRange)
        .reduce((sum, a) => sum + a.price * a.size, 0);

      return {
        bids: bids.slice(0, 5),
        asks: asks.slice(0, 5),
        spread: Math.round(spread * 10000) / 100, // as percentage
        midPrice: Math.round(midPrice * 100),
        bidDepth: Math.round(bidDepth),
        askDepth: Math.round(askDepth),
        totalLiquidity: Math.round(bidDepth + askDepth),
      };
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return null;
  }
}

// ─── Recent Trades ───────────────────────────────────────────────────────────

interface RawTrade {
  side: string;
  price: string;
  size: string;
  timestamp: string;
}

export async function fetchRecentTrades(tokenId: string): Promise<TradeData | null> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    try {
      const res = await fetch(`${CLOB_BASE}/trades?token_id=${tokenId}&limit=50`, {
        cache: "no-store",
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();

      const trades: RawTrade[] = Array.isArray(data) ? data : (Array.isArray(data.trades) ? data.trades : []);
      if (trades.length === 0) return null;

      let buyVolume = 0;
      let sellVolume = 0;
      let largeTrades = 0;
      let totalSize = 0;

      for (const t of trades) {
        const price = parseFloat(t.price);
        const size = parseFloat(t.size);
        if (isNaN(price) || isNaN(size)) continue;
        const notional = price * size;
        totalSize += notional;

        if (notional > 500) largeTrades++;

        if (t.side?.toLowerCase() === "buy") {
          buyVolume += notional;
        } else {
          sellVolume += notional;
        }
      }

      const total = buyVolume + sellVolume;
      const ratio = total > 0 ? buyVolume / total : 0.5;

      return {
        totalTrades: trades.length,
        largeTrades,
        buyVolume: Math.round(buyVolume),
        sellVolume: Math.round(sellVolume),
        buySellRatio: Math.round(ratio * 100) / 100,
        avgTradeSize: trades.length > 0 ? Math.round(totalSize / trades.length) : 0,
        recentTrend: ratio > 0.6 ? "buying" : ratio < 0.4 ? "selling" : "balanced",
      };
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return null;
  }
}

// ─── Format for prompt ───────────────────────────────────────────────────────

export function formatOrderBookForPrompt(ob: OrderBookData | null, trades: TradeData | null): string {
  if (!ob && !trades) return "No order book data available.";

  const parts: string[] = [];

  if (ob) {
    parts.push(`Order Book: spread=${ob.spread}%, mid=${ob.midPrice}¢`);
    parts.push(`  Bid depth (within 5%): $${ob.bidDepth} | Ask depth: $${ob.askDepth} | Total liquidity: $${ob.totalLiquidity}`);
    if (ob.totalLiquidity < 1000) {
      parts.push(`  ⚠ Thin liquidity — price may not reflect true probability`);
    }
  }

  if (trades) {
    parts.push(`Recent Trades (last 50): ${trades.totalTrades} trades, ${trades.largeTrades} large (>$500)`);
    parts.push(`  Buy/sell ratio: ${trades.buySellRatio} (${trades.recentTrend}) | Avg size: $${trades.avgTradeSize}`);
  }

  return parts.join("\n");
}
