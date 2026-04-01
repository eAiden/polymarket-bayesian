import { NextResponse } from "next/server";
import { loadStoreAsync } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const store = await loadStoreAsync();
    return NextResponse.json(store);
  } catch (err) {
    console.error("[GET /api/markets]", err);
    return NextResponse.json({ error: "Failed to load market data" }, { status: 500 });
  }
}
