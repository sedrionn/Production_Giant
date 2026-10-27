import { pinOptions } from "@/server/plan";
import { fail, ok } from "../../_util";

/** Blueprint sources and decryptors of a pinned item, for the choice next to the pin. */
export async function GET(req: Request) {
  try {
    const typeId = Number(new URL(req.url).searchParams.get("typeId"));
    if (!(typeId > 0)) throw new Error("Нужен typeId");
    return ok(pinOptions(typeId));
  } catch (e) {
    return fail(e);
  }
}
