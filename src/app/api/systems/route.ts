import { getSde } from "@/server/data";
import { ok } from "../_util";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return ok([]);
  return ok(getSde().source.searchSystems(q, 15));
}
