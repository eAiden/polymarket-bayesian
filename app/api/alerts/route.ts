import { NextResponse } from "next/server";
import { loadAlertsAsync, runNewsMonitor } from "@/lib/news-monitor";

// GET: return recent news alerts
export async function GET() {
  const alerts = await loadAlertsAsync();
  // Return last 50 alerts, newest first
  return NextResponse.json({
    alerts: alerts.slice(-50).reverse(),
    total: alerts.length,
  });
}

// POST: manually trigger news check
export async function POST() {
  try {
    const result = await runNewsMonitor();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "News monitor failed" },
      { status: 500 },
    );
  }
}
