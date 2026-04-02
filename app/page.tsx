import { getMarketStore } from "@/lib/db";
import { Dashboard } from "@/components/Dashboard";
import Link from "next/link";
import type { MarketStore } from "@/lib/types";

// Re-render from cache every hour; manual scans trigger client-side polls
export const revalidate = 3600;
export const dynamic = "force-dynamic";

const emptyStore: MarketStore = { lastScanAt: null, markets: [] };

export default async function Home() {
  let store: MarketStore = emptyStore;
  try {
    store = await getMarketStore();
  } catch (err) {
    console.error("[page] getMarketStore failed:", err);
  }
  return (
    <>
      <nav style={{
        position: "fixed", top: 0, right: 0,
        padding: "8px 16px", zIndex: 50,
        display: "flex", gap: 12, alignItems: "center",
        fontSize: 11, fontFamily: "var(--font)",
      }}>
        <Link
          href="/leaderboard"
          style={{
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "4px 10px",
            textDecoration: "none",
            transition: "color 0.15s",
          }}
        >
          📊 Leaderboard
        </Link>
      </nav>
      <Dashboard initialData={store} />
    </>
  );
}
