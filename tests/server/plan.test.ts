import { beforeAll, describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

let plan: typeof import("@/server/plan");

// SYNTHETIC character: 2 factory slots, 2 lab slots. Data (recipes, prices) are the real fixtures.
beforeAll(async () => {
  plan = await import("@/server/plan");
  const { getDb } = await import("@/server/data");
  const { characters, characterSkills } = await import("@/db/schema");
  const db = getDb();
  db.insert(characters).values({ characterId: 1, name: "Тест", refreshToken: "x" }).run();
  db.insert(characterSkills)
    .values([
      { characterId: 1, skillId: 3387, level: 1 }, // Mass Production → 2 factory slots
      { characterId: 1, skillId: 3406, level: 1 }, // Laboratory Operation → 2 lab slots
    ])
    .run();
});

const req = { budget: 10e9, cadenceDays: 2, horizonDays: 7, categories: [], marketShare: 0.3, minBatchProfit: 0, caldariShipsFirst: true, maxItemShare: 0.2 };

describe("buildPlan: pins and lab slots (real fixtures)", () => {
  it("a pinned item outside the chosen categories is planned, with its invention on a lab slot", () => {
    const p = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] }); // Hammerhead II, invented
    expect(p.slots[0]).toMatchObject({ manufacturing: { total: 2 }, science: { total: 2 } });
    expect(p.batches.map((b) => [b.name, b.pinned])).toEqual([["Hammerhead II", 1]]);
    const inv = p.prep.find((x) => x.activity === "invention")!;
    expect(inv.name).toBe("Hammerhead II (инвент)");
    expect(inv.runs).toBe(p.invention[0].attempts);
    expect(inv.seconds).toBeCloseTo(inv.runs * p.invention[0].secondsPerAttempt!);
    expect(p.utilization.science).toBeGreaterThan(0);
  });

  it("without pins and categories the plan is empty", () => {
    expect(plan.buildPlan(req).batches).toEqual([]);
  });
});
