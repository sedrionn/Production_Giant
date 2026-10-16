import { priceTypesFor } from "@/server/calculate";
import { getSettings } from "@/server/data";
import { refreshPrices } from "@/server/refreshPrices";
import { fail, int, ok } from "../../_util";

/** Fetches live prices from ESI for everything the given item's tree needs. Needs internet. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { typeId?: number };
    const s = getSettings();
    const ids = priceTypesFor(int(b.typeId, "typeId", { min: 1 }));
    return ok({ ...(await refreshPrices(ids, s.priceRegionId, s.priceLocationId)), requested: ids.length });
  } catch (e) {
    return fail(e, 502);
  }
}
