import { runScanPipeline } from "@/lib/pipeline";
import { migrate, sql } from "@/lib/db";
import type { ScanProgressCallback } from "@/lib/pipeline";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Gate behind SCAN_SECRET if set (prevents public visitors from burning API credits)
  const secret = process.env.SCAN_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const encoder = new TextEncoder();

  // Ensure DB is migrated before streaming starts
  try {
    await migrate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `DB not ready: ${msg}` }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify DB connectivity with a quick ping
  try {
    await sql()`SELECT 1`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `DB unreachable: ${msg}` }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const send: ScanProgressCallback = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    writer.write(encoder.encode(data)).catch(() => {});
  };

  // Heartbeat: SSE comment every 15s so browsers/proxies don't time out the
  // connection during long Claude batches (which can stall progress for 1–2 min).
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(": ping\n\n")).catch(() => {});
  }, 15_000);

  runScanPipeline(send)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[scan route] Pipeline error:", err);
      send({ phase: "error", message: msg });
    })
    .finally(() => {
      clearInterval(heartbeat);
      writer.close().catch(() => {});
    });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
