// Next.js instrumentation hook — runs once on server startup.
// Schedules:
//   1. Daily full scan at 08:00 local time
//   2. News monitor every 5 minutes (checks for breaking news → fast re-analysis)

export async function register() {
  // Skip cron on Vercel — Railway handles the pipeline when PIPELINE_SERVICE_URL is set.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.PIPELINE_SERVICE_URL) {
    const cron = await import("node-cron");
    const { runScanPipeline } = await import("./lib/pipeline");
    const { runNewsMonitor } = await import("./lib/news-monitor");

    console.log("[scheduler] Daily scan scheduled at 08:00 local time");
    console.log("[scheduler] News monitor scheduled every 5 minutes");

    // Full scan: daily at 8am
    cron.default.schedule("0 8 * * *", async () => {
      console.log("[scheduler] Running daily scan...");
      try {
        const result = await runScanPipeline();
        console.log("[scheduler] Daily scan complete:", result);
      } catch (err) {
        console.error("[scheduler] Daily scan failed:", err);
      }
    });

    // News monitor: every 5 minutes
    cron.default.schedule("*/5 * * * *", async () => {
      try {
        const result = await runNewsMonitor();
        if (result.alertsFound > 0) {
          console.log(`[scheduler] News monitor: ${result.alertsFound} alerts, ${result.marketsReanalyzed} re-analyzed`);
        }
      } catch (err) {
        console.error("[scheduler] News monitor failed:", err);
      }
    });
  }
}
