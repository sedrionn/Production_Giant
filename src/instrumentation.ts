/**
 * Next.js calls this once when the server starts. Background jobs live only in the Node runtime;
 * the import must sit INSIDE the NEXT_RUNTIME check so the edge build drops it (better-sqlite3).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { scheduleAutoRefresh } = await import("./server/autoRefresh");
    if (!process.env.PG_NO_AUTO_REFRESH) scheduleAutoRefresh();
  }
}
