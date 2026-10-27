import { beforeAll, describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

let sheet: typeof import("@/server/loginSheet");
let saved: typeof import("@/server/savedPlan");
let plan: typeof import("@/server/plan");

// SYNTHETIC character and jobs; recipes and prices are the real fixtures.
beforeAll(async () => {
  sheet = await import("@/server/loginSheet");
  saved = await import("@/server/savedPlan");
  plan = await import("@/server/plan");
  const { getDb } = await import("@/server/data");
  const { characters, characterSkills, industryJobs } = await import("@/db/schema");
  const db = getDb();
  db.insert(characters).values({ characterId: 1, name: "Тест", refreshToken: "x" }).run();
  db.insert(characterSkills).values([{ characterId: 1, skillId: 3387, level: 4 }]).run();
  const job = { ownerType: "character" as const, installerId: 1, viaCharacterId: 1, activityId: 1, status: "active", facilityId: 1, startDate: "2026-10-20T00:00:00Z" };
  db.insert(industryJobs)
    .values([
      { ...job, jobId: 1, blueprintTypeId: 34829, productTypeId: 34828, runs: 3, endDate: "2026-10-22T00:00:00Z" }, // finished, not delivered
      { ...job, jobId: 2, blueprintTypeId: 34829, productTypeId: 34828, runs: 2, endDate: "2099-01-01T00:00:00Z" }, // still running
    ])
    .run();
});

describe("loginSheet", () => {
  it("without a saved plan: only what the game shows", () => {
    const s = sheet.loginSheet(undefined, Date.parse("2026-10-23T00:00:00Z"));
    expect(s.plan).toBeNull();
    expect(s.logins).toEqual([]);
    expect(s.deliver).toEqual([{ owner: "Тест", items: [{ name: "Jackdaw", runs: 3, jobs: 1 }] }]);
    expect(s.slots[0]).toMatchObject({ owner: "Тест", manufacturing: { total: 5, busy: 1 } });
  });

  it("with a saved plan: the logins are kept, today's is picked, any other can be shown", () => {
    const p = plan.buildPlan({ budget: 10e9, cadenceDays: 2, horizonDays: 7, categories: [], marketShare: 0.3, minBatchProfit: 0, caldariShipsFirst: true, maxItemShare: 1, maxManufacturingJobDays: 7, pins: [{ typeId: 34828, units: 1 }] });
    saved.savePlan(p);
    const view = saved.savedPlanView()!;
    const t0 = Date.parse(view.createdAt);
    const s = sheet.loginSheet(undefined, t0 + 3600_000);
    expect(s.plan?.title).toBe(view.title);
    expect(s.logins.map((l) => l.day)).toEqual(p.logins.map((l) => l.day));
    expect(s.current).toBe(0);
    // Empty stock: the first week makes Jackdaw's components, the hull is next week's.
    expect(s.plan?.rampUp).toBe(true);
    expect(s.plan?.nextWeek).toEqual([{ name: "Jackdaw", batches: 1, runs: p.nextWeek[0].runs }]);
    expect(s.logins[0].prep.length).toBeGreaterThan(0);
    expect(s.buy?.buy.length).toBeGreaterThan(0);
    const later = s.logins.at(-1)!;
    expect(sheet.loginSheet(later.day, t0).current).toBe(s.logins.length - 1);
    // A day after the second login (day 6 for the second Jackdaw part) → that login.
    expect(sheet.loginSheet(undefined, t0 + (later.day + 0.5) * 86_400_000).current).toBe(s.logins.length - 1);
  });

  it("plans saved before logins were kept: rebuilt from the product jobs", () => {
    const view = saved.savedPlanView()!;
    const old = { ...view.data, logins: undefined };
    const l = saved.loginsOf(old);
    expect(l.flatMap((x) => x.start).map((j) => j.name)).toEqual(view.data.jobs.map((j) => j.name));
    expect(l.every((x) => x.prep.length === 0)).toBe(true);
  });
});
