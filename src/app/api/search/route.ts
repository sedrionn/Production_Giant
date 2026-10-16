import { getSde } from "@/server/data";
import { ok } from "../_util";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return ok([]);
  return ok(getSde().source.searchBuildable(q, 15).map((t) => ({ typeId: t.typeId, name: t.name })));
}
