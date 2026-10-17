/** Next.js calls this once when the server starts. Background jobs live only in the Node runtime. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.PG_NO_AUTO_REFRESH) return;
  const { scheduleAutoRefresh } = await import("./server/autoRefresh");
  scheduleAutoRefresh();
}
