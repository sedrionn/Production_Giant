import type { AppSettings } from "@/db/seed";
import { getSettings, saveSettings } from "@/server/data";
import { fail, ok } from "../_util";

export async function GET() {
  return ok(getSettings());
}

export async function PUT(req: Request) {
  try {
    // Kept by the app itself: a settings page opened earlier must not overwrite them with stale copies.
    const patch = (await req.json()) as Partial<AppSettings>;
    delete patch.planForm;
    delete patch.lastAutoRefreshAt;
    return ok(saveSettings(patch));
  } catch (e) {
    return fail(e);
  }
}
