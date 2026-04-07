import { NextResponse } from "next/server";
import { getRecentScanRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await getRecentScanRuns(10);
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), runs: [] },
      { status: 500 },
    );
  }
}
