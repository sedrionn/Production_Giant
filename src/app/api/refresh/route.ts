import { FULL_REFRESH_LABEL, startFullRefresh } from "@/server/autoRefresh";
import { getSettings } from "@/server/data";
import { runningTask } from "@/server/tasks";
import { fail, ok } from "../_util";

/** Status of the daily full refresh. */
export async function GET() {
  const s = getSettings();
  return ok({ autoRefreshHours: s.autoRefreshHours, lastAutoRefreshAt: s.lastAutoRefreshAt, task: runningTask(FULL_REFRESH_LABEL) ?? null });
}

/** "Обновить всё" now. */
export async function POST() {
  try {
    return ok(startFullRefresh());
  } catch (e) {
    return fail(e);
  }
}
