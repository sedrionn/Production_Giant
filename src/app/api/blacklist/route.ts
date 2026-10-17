import { getSde, getSettings, saveSettings } from "@/server/data";
import { fail, int, ok } from "../_util";

/** The manual part of the blacklist with names, for the settings page. */
export async function GET() {
  const { source: sde } = getSde();
  const bl = getSettings().blacklist;
  return ok({ ...bl, items: bl.typeIds.map((id) => ({ typeId: id, name: sde.getType(id)?.name ?? `#${id}` })) });
}

/** {typeId, add} adds or removes one item. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { typeId: unknown; add?: boolean };
    const id = int(b.typeId, "typeId", { min: 1 });
    const bl = getSettings().blacklist;
    const ids = new Set(bl.typeIds);
    if (b.add === false) ids.delete(id);
    else ids.add(id);
    return ok(saveSettings({ blacklist: { ...bl, typeIds: [...ids] } }).blacklist);
  } catch (e) {
    return fail(e);
  }
}
