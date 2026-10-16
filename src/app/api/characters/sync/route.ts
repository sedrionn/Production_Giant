import { syncAll } from "@/server/characters";
import { fail, ok } from "../../_util";

export async function POST() {
  try {
    return ok(await syncAll());
  } catch (e) {
    return fail(e, 502);
  }
}
