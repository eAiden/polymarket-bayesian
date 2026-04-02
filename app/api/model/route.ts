import { NextResponse } from "next/server";
import { isModelTrained } from "@/lib/scoring";

export async function GET() {
  return NextResponse.json(isModelTrained());
}
