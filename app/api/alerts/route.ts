import { NextResponse } from "next/server";
import { getNewsAlerts } from "@/lib/db";
import { runNewsMonitor } from "@/lib/news-monitor";

export const dynamic = "force-dynamic";

export async function GET() {
  const alerts = await getNewsAlerts(50);
  return NextResponse.json(alerts);
}

export async function POST() {
  const result = await runNewsMonitor();
  return NextResponse.json(result);
}
