import type { AppSettings } from "@/db/seed";
import { getSettings, saveSettings } from "@/server/data";
import { fail, ok } from "../_util";

export async function GET() {
  return ok(getSettings());
}

export async function PUT(req: Request) {
  try {
    return ok(saveSettings((await req.json()) as Partial<AppSettings>));
  } catch (e) {
    return fail(e);
  }
}
