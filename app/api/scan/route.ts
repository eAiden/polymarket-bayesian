import { runScanPipeline } from "@/lib/pipeline";
import { migrate, sql } from "@/lib/db";
import type { ScanProgressCallback } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function POST() {
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

  runScanPipeline(send)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[scan route] Pipeline error:", msg);
      send({ phase: "error", message: msg });
    })
    .finally(() => writer.close().catch(() => {}));

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
