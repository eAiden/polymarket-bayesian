// Next.js instrumentation hook — runs once on server startup.
// Runs DB migration, then schedules:
//   1. Daily full scan at 00:00 UTC (= 08:00 Asia/Manila) (checked every minute via setInterval)
//   2. News monitor every 5 minutes

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { migrate } = await import("./lib/db");
  const { runScanPipeline } = await import("./lib/pipeline");
  const { runNewsMonitor } = await import("./lib/news-monitor");

  // Run DB migration on startup
  try {
    await migrate();
    console.log("[db] Migration complete");
  } catch (err) {
    console.error("[db] Migration failed:", err);
  }

  // ── Simple cron replacement using setInterval ─────────────────────────────
  // Tracks the last time each job ran (as "YYYY-MM-DD" for daily, epoch ms for interval)
  let lastDailyScanDate = "";
  let lastNewsMonitorMs = 0;

  const FIVE_MIN_MS = 5 * 60 * 1000;

  setInterval(async () => {
    const now = new Date();

    // Daily scan at 00:00 UTC (= 08:00 Asia/Manila, UTC+8)
    const dateStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const hour = now.getUTCHours();
    if (hour >= 0 && dateStr !== lastDailyScanDate) {
      lastDailyScanDate = dateStr;
      console.log("[cron] Running daily scan...");
      try { await runScanPipeline(); } catch (err) { console.error("[cron] daily scan:", err); }
    }

    // News monitor every 5 minutes
    if (Date.now() - lastNewsMonitorMs >= FIVE_MIN_MS) {
      lastNewsMonitorMs = Date.now();
      try { await runNewsMonitor(); } catch (err) { console.error("[cron] news monitor:", err); }
    }
  }, 60_000); // tick every 60 seconds

  console.log("[cron] Scheduled: daily scan @ 00:00 UTC (08:00 Asia/Manila), news monitor every 5min");
}
