import { FULL_REFRESH_LABEL, startFullRefresh } from "@/server/autoRefresh";
import { getSettings } from "@/server/data";
import { latestTask } from "@/server/tasks";
import { fail, ok } from "../_util";

/** Status of "Обновить всё": when it last finished, and the running or last task with its steps. */
export async function GET() {
  const s = getSettings();
  return ok({ autoRefreshHours: s.autoRefreshHours, lastAutoRefreshAt: s.lastAutoRefreshAt, task: latestTask(FULL_REFRESH_LABEL) ?? null });
}

/** "Обновить всё" now. */
export async function POST() {
  try {
    return ok(startFullRefresh());
  } catch (e) {
    return fail(e);
  }
}
