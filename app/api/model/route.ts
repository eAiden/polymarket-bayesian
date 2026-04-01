import { NextResponse } from "next/server";
import { isModelTrained } from "@/lib/scoring";
import { kvGet } from "@/lib/kv";
import type { ModelWeights } from "@/lib/types";

export async function GET() {
  // Try KV first (Vercel doesn't have local weights file)
  const kvWeights = await kvGet<ModelWeights>("model-weights");
  if (kvWeights) {
    return NextResponse.json({
      trained: kvWeights.version !== "v1.0-default",
      version: kvWeights.version,
      updatedAt: kvWeights.updatedAt,
    });
  }
  return NextResponse.json(isModelTrained());
}
