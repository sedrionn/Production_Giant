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

describe("buildPlan: no market", () => {
  it("a pinned product without market is still planned, at its real (buy-order) price", async () => {
    const { getDb, getSettings } = await import("@/server/data");
    const { marketStats } = await import("@/db/schema");
    // SYNTHETIC history: Hammerhead II traded on 2 days out of 30.
    getDb()
      .insert(marketStats)
      .values({ typeId: 2185, regionId: getSettings().priceRegionId, avgDailyVolume7d: 0, avgDailyVolume30d: 0.1, vwap7d: null, vwap30d: 1, median30d: 1, daysTraded7d: 0, daysTraded30d: 2 })
      .run();
    const pinned = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    expect(pinned.batches.map((b) => b.name)).toEqual(["Hammerhead II"]);
    expect(pinned.batches[0].profit).toBeLessThan(0); // sold into buy orders only: at a loss, but pinned
  });
});

describe("buildPlan: T1 copies for invention", () => {
  it("own T1 BPO → a copying job on a lab slot before invention; without it → buy BPCs", async () => {
    const without = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    expect(without.prep.some((x) => x.activity === "copying")).toBe(false);
    expect(without.stages.blueprints?.[0]).toMatchObject({ name: "Hammerhead I Blueprint", how: "buy" });

    // SYNTHETIC: the character owns the Hammerhead I BPO.
    const { getDb } = await import("@/server/data");
    const { ownedBlueprints } = await import("@/db/schema");
    getDb()
      .insert(ownedBlueprints)
      .values({ itemId: 900, ownerType: "character", ownerId: 1, viaCharacterId: 1, typeId: 2184, me: 10, te: 20, runs: -1, quantity: -1, locationId: 1, locationFlag: "Hangar" })
      .run();
    (await import("@/server/characters")).forgetCharacterLookups();
    const withBpo = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    const copy = withBpo.prep.find((x) => x.activity === "copying")!;
    const inv = withBpo.prep.find((x) => x.activity === "invention")!;
    expect(copy).toMatchObject({ name: "Hammerhead I Blueprint (копии для Hammerhead II)", start: 0 });
    expect(copy.runs).toBe(inv.runs);
    expect(inv.start).toBe(2);
    expect(withBpo.stages.blueprints?.[0].how).toBe("copy");
  });
});

describe("buildPlan: stock", () => {
  it("materials in the stock hangar are taken by the batch and not paid from the budget", async () => {
    const before = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    const b0 = before.batches[0];
    expect(b0.fromStock).toBe(0);

    // SYNTHETIC: 1000 Morphite in a structure that counts as stock.
    const { getDb, saveSettings } = await import("@/server/data");
    const { assets } = await import("@/db/schema");
    const morphite = before.shopping.find((l) => l.name === "Morphite")!;
    saveSettings({ stockLocationIds: [1_000_000_000_001] });
    getDb()
      .insert(assets)
      .values({ itemId: 77, ownerType: "character", ownerId: 1, viaCharacterId: 1, typeId: morphite.typeId, quantity: 1000, locationId: 1_000_000_000_001, locationFlag: "Hangar", locationType: "other" })
      .run();

    const after = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    const b = after.batches[0];
    // The batch needs less Morphite than there is: all of it comes from stock, at its market cost.
    expect(b.fromStock).toBeCloseTo(morphite.cost!);
    expect(after.capital).toBeCloseTo(b.capital - b.fromStock);
    expect(after.fromStock).toBeCloseTo(morphite.cost!);
    expect(after.stages.buy.find((l) => l.typeId === morphite.typeId)).toMatchObject({ toBuy: 0 });
  });
});

describe("buildPlan: what one more slot, character or billion adds", () => {
  it("a small plan that fits everywhere: nothing more to gain, no second pass", () => {
    const p = plan.buildPlan({ ...req, pins: [{ typeId: 2185, batches: 1 }] });
    expect(p.marginal.slot).toEqual({ manufacturing: 0, reaction: 0, science: 0 });
    expect(p.marginal.character).toEqual({ like: "Тест", gain: 0 });
    expect(p.marginal.budget).toEqual({ step: 1e9, gain: 0 });
    expect(p.slotPass).toBeNull();
    expect(plan.sheetText(p)).toContain("Что даст ещё");
  });
});
