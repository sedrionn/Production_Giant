import { calculate, type CalcRequest } from "@/server/calculate";
import { fail, int, ok } from "../_util";

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Partial<CalcRequest>;
    const r: CalcRequest = {
      ...b,
      typeId: int(b.typeId, "typeId", { min: 1 }),
      runs: int(b.runs ?? 1, "runs", { min: 1, max: 100_000 }),
      me: b.me == null ? undefined : int(b.me, "ME", { min: 0, max: 10 }),
      te: b.te == null ? undefined : int(b.te, "TE", { min: 0, max: 20 }),
    };
    return ok(calculate(r));
  } catch (e) {
    return fail(e);
  }
}
