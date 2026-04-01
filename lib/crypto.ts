import type { CryptoPrices } from "./types";

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true";

// Cache: crypto prices change fast but we don't need real-time during analysis
let cache: { data: CryptoPrices; expiry: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchCryptoPrices(): Promise<CryptoPrices | null> {
  if (cache && Date.now() < cache.expiry) {
    return cache.data;
  }

  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8_000);
    try {
      const res = await fetch(COINGECKO_URL, { cache: "no-store", signal: ac.signal });
      if (!res.ok) return null;
      const raw = await res.json();

      const data: CryptoPrices = {
        fetchedAt: new Date().toISOString(),
      };

      if (raw.bitcoin) {
        data.bitcoin = {
          usd: raw.bitcoin.usd,
          usd_24h_change: Math.round(raw.bitcoin.usd_24h_change * 100) / 100,
        };
      }
      if (raw.ethereum) {
        data.ethereum = {
          usd: raw.ethereum.usd,
          usd_24h_change: Math.round(raw.ethereum.usd_24h_change * 100) / 100,
        };
      }
      if (raw.solana) {
        data.solana = {
          usd: raw.solana.usd,
          usd_24h_change: Math.round(raw.solana.usd_24h_change * 100) / 100,
        };
      }

      cache = { data, expiry: Date.now() + CACHE_TTL };
      return data;
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return null;
  }
}

export function formatCryptoForPrompt(prices: CryptoPrices | null): string {
  if (!prices) return "";

  const parts: string[] = ["CURRENT CRYPTO PRICES (CoinGecko):"];
  if (prices.bitcoin) {
    parts.push(`  BTC: $${prices.bitcoin.usd.toLocaleString()} (${prices.bitcoin.usd_24h_change > 0 ? "+" : ""}${prices.bitcoin.usd_24h_change}% 24h)`);
  }
  if (prices.ethereum) {
    parts.push(`  ETH: $${prices.ethereum.usd.toLocaleString()} (${prices.ethereum.usd_24h_change > 0 ? "+" : ""}${prices.ethereum.usd_24h_change}% 24h)`);
  }
  if (prices.solana) {
    parts.push(`  SOL: $${prices.solana.usd.toLocaleString()} (${prices.solana.usd_24h_change > 0 ? "+" : ""}${prices.solana.usd_24h_change}% 24h)`);
  }

  return parts.length > 1 ? parts.join("\n") : "";
}
