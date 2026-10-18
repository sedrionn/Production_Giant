import type { CategoryKey } from "@/server/catalog";
import { buildPlan, lastPlan, rememberPlan, sheetText } from "@/server/plan";
import { fail, ok } from "../_util";

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Partial<{ budget: number; cadenceDays: number; horizonDays: number; categories: CategoryKey[]; marketShare: number; minBatchProfit: number; caldariShipsFirst: boolean; maxItemShare: number }>;
    const plan = buildPlan({
      budget: Math.max(0, Number(b.budget) || 10e9),
      cadenceDays: Math.min(7, Math.max(1, Number(b.cadenceDays) || 2)),
      horizonDays: Math.min(28, Math.max(1, Number(b.horizonDays) || 7)),
      categories: b.categories?.length ? b.categories : ["caldari_t1", "caldari_t2", "t3", "rigs_t1", "rigs_t2", "reactions"],
      marketShare: Math.min(1, Math.max(0.05, Number(b.marketShare) || 0.3)),
      minBatchProfit: Math.max(0, Number(b.minBatchProfit ?? 30e6)),
      caldariShipsFirst: b.caldariShipsFirst !== false,
      maxItemShare: Math.min(1, Math.max(0.05, Number(b.maxItemShare ?? 0.2))),
    });
    const out = { ...plan, text: sheetText(plan), computedAt: new Date().toISOString() };
    rememberPlan(out);
    return ok(out);
  } catch (e) {
    return fail(e);
  }
}

/** The last plan made, so it survives leaving the page or restarting the app. */
export async function GET() {
  try {
    return ok({ plan: lastPlan() });
  } catch (e) {
    return fail(e);
  }
}
