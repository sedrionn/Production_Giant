import { stockLocations } from "@/server/assets";
import { saveSettings } from "@/server/data";
import { fail, ok } from "../_util";

export async function GET() {
  try {
    return ok({ locations: stockLocations() });
  } catch (e) {
    return fail(e);
  }
}

/** { locationIds: number[] | null } — null = back to "where your jobs run". */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { locationIds: number[] | null };
    saveSettings({ stockLocationIds: b.locationIds === null ? null : b.locationIds.map(Number).filter(Number.isFinite) });
    return ok({ locations: stockLocations() });
  } catch (e) {
    return fail(e);
  }
}
