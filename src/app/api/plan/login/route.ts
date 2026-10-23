import { loginSheet } from "@/server/loginSheet";
import { fail, ok } from "../../_util";

export async function GET(req: Request) {
  try {
    const day = new URL(req.url).searchParams.get("day");
    return ok({ sheet: loginSheet(day === null ? undefined : Number(day)) });
  } catch (e) {
    return fail(e);
  }
}
