import type { CategoryKey } from "@/server/catalog";
import { buildPlan, sheetText } from "@/server/plan";
import { fail, ok } from "../_util";

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Partial<{ budget: number; cadenceDays: number; horizonDays: number; categories: CategoryKey[]; marketShare: number }>;
    const plan = buildPlan({
      budget: Math.max(0, Number(b.budget) || 10e9),
      cadenceDays: Math.min(7, Math.max(1, Number(b.cadenceDays) || 2)),
      horizonDays: Math.min(28, Math.max(1, Number(b.horizonDays) || 7)),
      categories: b.categories?.length ? b.categories : ["mine", "caldari_t1", "caldari_t2", "t3"],
      marketShare: Math.min(1, Math.max(0.05, Number(b.marketShare) || 0.3)),
    });
    return ok({ ...plan, text: sheetText(plan) });
  } catch (e) {
    return fail(e);
  }
}
