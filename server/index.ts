// Railway pipeline server — standalone Node.js HTTP server.
// Runs daily scan + news monitor via cron.
// Exposes health + admin endpoints (auth-gated with ADMIN_SECRET).

import http from "http";
import { schedule } from "node-cron";
import { runScanPipeline } from "../lib/pipeline";
import { runNewsMonitor } from "../lib/news-monitor";
import { trainModel } from "../lib/model-training";
import type { ScanProgressCallback } from "../lib/pipeline";

// ─── Config ───────────────────────────────────────────────────────────────────

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const PORT = parseInt(process.env.PORT ?? "3001", 10);

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!ADMIN_SECRET) return true; // open in dev if secret not set
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${ADMIN_SECRET}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c: Buffer) => (buf += c.toString()));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method?.toUpperCase() ?? "GET";

  // CORS — allow Vercel frontend
  const origin = req.headers["origin"];
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    return json(res, { ok: true, ts: new Date().toISOString() });
  }

  // Auth gate for all /admin/*
  if (url.pathname.startsWith("/admin")) {
    if (!isAuthorized(req)) {
      return json(res, { error: "Unauthorized" }, 401);
    }
  }

  // POST /admin/scan — SSE stream of scan progress
  if (method === "POST" && url.pathname === "/admin/scan") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send: ScanProgressCallback = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runScanPipeline(send);
    } catch (err) {
      const msg = (err as Error).message || "Scan failed";
      console.error("[/admin/scan]", err);
      send({ phase: "error", message: msg });
    } finally {
      res.end();
    }
    return;
  }

  // POST /admin/news-check — run news monitor once
  if (method === "POST" && url.pathname === "/admin/news-check") {
    try {
      const result = await runNewsMonitor();
      return json(res, result);
    } catch (err) {
      const msg = (err as Error).message || "News check failed";
      console.error("[/admin/news-check]", err);
      return json(res, { error: msg }, 500);
    }
  }

  // POST /admin/train — trigger model retraining
  if (method === "POST" && url.pathname === "/admin/train") {
    let force = false;
    try {
      const body = await readBody(req);
      if (body) force = JSON.parse(body)?.force === true;
    } catch { /* empty body ok */ }
    const result = trainModel({ force });
    if ("error" in result) return json(res, result, 400);
    return json(res, result);
  }

  return json(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`[server] Pipeline server listening on :${PORT}`);
});

// ─── Cron ─────────────────────────────────────────────────────────────────────

// Full scan: daily at 8am
schedule("0 8 * * *", async () => {
  console.log("[cron] Running daily scan...");
  try {
    const result = await runScanPipeline();
    console.log("[cron] Daily scan complete:", result);
  } catch (err) {
    console.error("[cron] Daily scan failed:", err);
  }
});

// News monitor: every 5 minutes
schedule("*/5 * * * *", async () => {
  try {
    const result = await runNewsMonitor();
    if (result.alertsFound > 0) {
      console.log(`[cron] News monitor: ${result.alertsFound} alerts, ${result.marketsReanalyzed} re-analyzed`);
    }
  } catch (err) {
    console.error("[cron] News monitor failed:", err);
  }
});

console.log("[cron] Daily scan scheduled at 08:00 local time");
console.log("[cron] News monitor scheduled every 5 minutes");
