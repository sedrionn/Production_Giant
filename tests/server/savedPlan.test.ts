import { beforeAll, describe, expect, it } from "vitest";
import type { PlanResponse } from "@/server/plan";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

let sp: typeof import("@/server/savedPlan");
let data: typeof import("@/server/data");

// SYNTHETIC plan: 2 hull jobs of 5 runs from 10 components.
const plan = {
  request: { budget: 1e9, cadenceDays: 2, horizonDays: 7, categories: [], marketShare: 0.3, minBatchProfit: 0, caldariShipsFirst: true, maxItemShare: 0.2 },
  profit: 100,
  capital: 1000,
  batches: [{ typeId: 1, name: "Hull", runs: 5, units: 5, profit: 50, capital: 500, jobs: [], start: 0, end: 2 }],
  jobs: [{ typeId: 1, name: "Hull", activity: "manufacturing", runs: 5, seconds: 1, depth: 0, batchTypeId: 1, slot: 0, owner: "Aggrail", start: 0, end: 2 }],
  stages: {
    stages: [
      { depth: 1, lines: [{ typeId: 2, name: "Component", activity: "manufacturing", depth: 1, need: 10, fromStock: 0, runs: 10, output: 10, seconds: 100, isProduct: false }] },
      { depth: 0, lines: [{ typeId: 1, name: "Hull", activity: "manufacturing", depth: 0, need: 5, fromStock: 0, runs: 5, output: 5, seconds: 10, isProduct: true }] },
    ],
    buy: [],
    savedByStock: 0,
    costWithoutStock: 0,
    costWithStock: 0,
  },
  stock: { locations: [], syncedAt: null, owners: 0, types: 0 },
  invention: [],
} as unknown as PlanResponse;

beforeAll(async () => {
  sp = await import("@/server/savedPlan");
  data = await import("@/server/data");
});

describe("saved plan (SYNTHETIC)", () => {
  it("no plan yet → null; saving makes it the current one", () => {
    expect(sp.savedPlanView()).toBeNull();
    const id = sp.savePlan(plan, "Неделя теста");
    const v = sp.savedPlanView()!;
    expect(v).toMatchObject({ id, title: "Неделя теста" });
    expect(v.progress.startedShare).toBe(0);
  });

  it("jobs started after saving show up as progress", async () => {
    const { industryJobs } = await import("@/db/schema");
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    data.getDb()
      .insert(industryJobs)
      .values({ jobId: 501, ownerType: "character", installerId: 1, viaCharacterId: 1, activityId: 1, blueprintTypeId: 99, productTypeId: 2, runs: 10, status: "active", facilityId: 1, startDate: new Date().toISOString(), endDate: soon })
      .run();
    const v = sp.savedPlanView()!;
    const comp = v.progress.stages[0].lines[0].progress;
    expect(comp).toMatchObject({ started: 10, done: 0, left: 0, state: "running", runningUntil: soon });
    expect(v.progress.stages[1].lines[0].progress.state).toBe("todo");
    // Components 100 s of 110 s job time started, none finished.
    expect(v.progress.startedShare).toBeCloseTo(100 / 110);
    expect(v.progress.doneShare).toBe(0);
  });

  it("older plans are listed; delete removes", () => {
    const id2 = sp.savePlan(plan);
    const v = sp.savedPlanView()!;
    expect(v.id).toBe(id2);
    expect(v.others).toHaveLength(1);
    sp.deleteSavedPlan(id2);
    expect(sp.savedPlanView()!.title).toBe("Неделя теста");
  });
});
