// Next.js instrumentation hook — runs once on server startup.
// Runs DB migration, then schedules:
//   1. Daily full scan at 08:00
//   2. News monitor every 5 minutes

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { migrate } = await import("./lib/db");
  const { schedule } = await import("node-cron");
  const { runScanPipeline } = await import("./lib/pipeline");
  const { runNewsMonitor } = await import("./lib/news-monitor");

  // Run DB migration on startup
  try {
    await migrate();
    console.log("[db] Migration complete");
  } catch (err) {
    console.error("[db] Migration failed:", err);
  }

  // Daily scan at 8am
  schedule("0 8 * * *", async () => {
    console.log("[cron] Running daily scan...");
    try { await runScanPipeline(); } catch (err) { console.error("[cron]", err); }
  });

  // News monitor every 5 minutes
  schedule("*/5 * * * *", async () => {
    try { await runNewsMonitor(); } catch (err) { console.error("[cron] news:", err); }
  });

  console.log("[cron] Scheduled: daily scan @ 08:00, news monitor every 5min");
}
