import { getSde } from "@/server/data";
import { fail, ok } from "../_util";

export async function GET() {
  try {
    return ok(getSde().source.listDecryptors());
  } catch (e) {
    return fail(e);
  }
}
