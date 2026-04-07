import { NextResponse } from "next/server";
import { getTrainReadiness } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await getTrainReadiness();
  return NextResponse.json(readiness);
}

export async function POST() {
  const readiness = await getTrainReadiness();
  if (!readiness.readyToTrain) {
    return NextResponse.json(
      { error: `Not enough training data. Need ${readiness.samplesNeeded} more resolved markets.` },
      { status: 400 },
    );
  }
  // Trainer not yet implemented — placeholder until 20 resolved markets accumulate.
  return NextResponse.json(
    { error: "Trainer not yet implemented." },
    { status: 501 },
  );
}
