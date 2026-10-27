import { buildPlan, lastPlan, rememberPlan, sheetText } from "@/server/plan";
import { parsePlanForm, planRequestOf, storedPlanForm, storePlanForm } from "@/server/planForm";
import { fail, ok } from "../_util";

/** Makes the plan from the form and keeps the form (pins stay until removed). */
export async function POST(req: Request) {
  try {
    const form = parsePlanForm(await req.json());
    storePlanForm(form);
    const plan = buildPlan(planRequestOf(form));
    const out = { ...plan, text: sheetText(plan), computedAt: new Date().toISOString() };
    rememberPlan(out);
    return ok(out);
  } catch (e) {
    return fail(e);
  }
}

/** Saves the form without planning (each change on the page). */
export async function PUT(req: Request) {
  try {
    const form = parsePlanForm(await req.json());
    storePlanForm(form);
    return ok({ form });
  } catch (e) {
    return fail(e);
  }
}

/** The last plan made and the stored form, so both survive leaving the page or restarting the app. */
export async function GET() {
  try {
    return ok({ plan: lastPlan(), form: storedPlanForm() });
  } catch (e) {
    return fail(e);
  }
}
