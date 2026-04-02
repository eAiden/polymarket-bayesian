import { NextResponse } from "next/server";
import { getMarketStore } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const store = await getMarketStore();
    return NextResponse.json(store);
  } catch (err) {
    console.error("[api/markets]", err);
    return NextResponse.json({ lastScanAt: null, markets: [] }, { status: 500 });
  }
}
