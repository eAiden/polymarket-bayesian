import { NextResponse } from "next/server";
import { getCalibrationSummary } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const summary = await getCalibrationSummary();
  return NextResponse.json(summary);
}
