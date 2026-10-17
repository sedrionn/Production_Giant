import { buildLedger } from "@/server/ledger";
import { fail, ok } from "../_util";

export async function GET(req: Request) {
  try {
    const d = new URL(req.url).searchParams.get("days");
    const days = d === "all" ? null : Math.max(1, Math.min(3650, Number(d) || 30));
    return ok(buildLedger(days));
  } catch (e) {
    return fail(e);
  }
}
