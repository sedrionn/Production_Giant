import { CATEGORIES, type CategoryKey } from "@/server/catalog";
import { computeOverview } from "@/server/overview";
import { fail, ok } from "../_util";

export async function GET(req: Request) {
  try {
    const key = new URL(req.url).searchParams.get("category") as CategoryKey;
    if (!CATEGORIES.some((c) => c.key === key)) throw new Error(`Неизвестная категория: ${key}`);
    return ok(computeOverview(key));
  } catch (e) {
    return fail(e);
  }
}
