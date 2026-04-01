import { runScanPipeline } from "@/lib/pipeline";
import type { ScanEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 360; // 6 minutes for AI + news fetching

export async function POST() {
  const encoder = new TextEncoder();

  // When PIPELINE_SERVICE_URL is set (Vercel), proxy the SSE stream to Railway.
  const pipelineUrl = process.env.PIPELINE_SERVICE_URL;
  if (pipelineUrl) {
    const adminSecret = process.env.ADMIN_SECRET ?? "";
    const upstream = await fetch(`${pipelineUrl}/admin/scan`, {
      method: "POST",
      headers: adminSecret ? { Authorization: `Bearer ${adminSecret}` } : {},
    });

    if (!upstream.ok || !upstream.body) {
      const err = await upstream.text().catch(() => "Upstream error");
      return new Response(
        `data: ${JSON.stringify({ phase: "error", message: err })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }

    // Pipe Railway's SSE response directly to the client
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // No PIPELINE_SERVICE_URL — run locally (dev / Railway direct deploy)
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: ScanEvent) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        await runScanPipeline(send);
      } catch (err) {
        const msg = (err as Error).message || "Scan failed";
        console.error("[POST /api/scan]", err);
        send({ phase: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
