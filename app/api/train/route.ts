import { NextResponse } from "next/server";
import { trainModel, getTrainingStatsAsync } from "@/lib/model-training";

// GET: training readiness stats
export async function GET() {
  const stats = await getTrainingStatsAsync();
  return NextResponse.json(stats);
}

// POST: trigger retraining
// Body: { force?: boolean } — force=true skips the MIN_SAMPLES guard (for dev/testing)
export async function POST(req: Request) {
  let force = false;
  try {
    const body = await req.json();
    force = body?.force === true;
  } catch { /* no body */ }

  const result = trainModel({ force });

  if ("error" in result) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result);
}
