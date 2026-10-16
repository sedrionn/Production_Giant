import { getTask } from "@/server/tasks";
import { fail, ok } from "../_util";

export async function GET(req: Request) {
  const t = getTask(new URL(req.url).searchParams.get("id") ?? "");
  return t ? ok(t) : fail(new Error("Задача не найдена"), 404);
}
