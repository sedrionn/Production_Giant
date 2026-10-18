import { deleteSavedPlan, savePlan, savedPlanView } from "@/server/savedPlan";
import type { PlanResponse } from "@/server/plan";
import { fail, ok } from "../../_util";

export async function GET(req: Request) {
  try {
    const id = Number(new URL(req.url).searchParams.get("id")) || undefined;
    return ok({ plan: savedPlanView(id) });
  } catch (e) {
    return fail(e);
  }
}

/** Save the plan you just made: { plan, title? }. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { plan: PlanResponse; title?: string };
    return ok({ id: savePlan(b.plan, b.title) });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (id) deleteSavedPlan(id);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
