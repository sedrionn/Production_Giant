import { CATEGORIES, type CategoryKey } from "@/server/catalog";
import { getSettings } from "@/server/data";
import { refreshScope } from "@/server/overview";
import { refreshGlobal, refreshQuotes, refreshVolumes } from "@/server/refreshPrices";
import { startTask } from "@/server/tasks";
import { fail, ok } from "../../_util";

/** Starts a background refresh of prices + traded volumes for a whole category. Needs internet. */
export async function POST(req: Request) {
  try {
    const { category } = (await req.json()) as { category: CategoryKey };
    const cat = CATEGORIES.find((c) => c.key === category);
    if (!cat) throw new Error(`Неизвестная категория: ${category}`);
    const s = getSettings();
    const task = startTask(`prices:${category}`, async (t) => {
      t.phase = "собираю список";
      const scope = refreshScope(category);
      t.phase = "индексы и adjusted prices";
      await refreshGlobal();
      t.phase = "цены Jita";
      const q = await refreshQuotes(scope.priceTypes, s.priceRegionId, s.priceLocationId, (d, n) => {
        t.done = d;
        t.total = n;
      });
      t.failed += q.failed.length;
      t.phase = "объёмы продаж";
      const v = await refreshVolumes(scope.products, s.priceRegionId, (d, n) => {
        t.done = d;
        t.total = n;
      });
      t.failed += v.failed.length;
      t.phase = "готово";
    });
    return ok(task);
  } catch (e) {
    return fail(e);
  }
}
