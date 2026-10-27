import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

let plan: typeof import("@/server/plan");

// SYNTHETIC character: 2 factory slots, 6 reaction slots, 2 lab slots. Data (recipes, prices) are the real fixtures.
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
      { characterId: 1, skillId: 45748, level: 5 }, // Mass Reactions → 6 reaction slots
    ])
    .run();
});

const req = { budget: 10e9, cadenceDays: 2, horizonDays: 7, categories: [], marketShare: 0.3, minBatchProfit: 0, caldariShipsFirst: true, maxItemShare: 0.2 };

describe("buildPlan: pins and lab slots (real fixtures)", () => {
  it("a pinned item outside the chosen categories is planned, with its invention on a lab slot", () => {
    const p = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] }); // Hammerhead II, invented
    expect(p.slots[0]).toMatchObject({ manufacturing: { total: 2 }, science: { total: 2 } });
    // Empty stock: its chain (fuel blocks → reactions → components) takes the week, the hull is next week's.
    expect(p.batches).toEqual([]);
    expect(p.nextWeek.map((b) => [b.name, b.pinned])).toEqual([["Hammerhead II", 1]]);
    expect(p.rampUp).toBe(true);
    expect(p.pins).toEqual([expect.objectContaining({ name: "Hammerhead II", want: 1 })]);
    expect(p.pins[0].planned).toBeGreaterThanOrEqual(1);
    // Every job of the plan starts inside the week.
    expect(p.logins.every((l) => l.day < 7)).toBe(true);
    expect(p.prep.every((x) => x.start < 7)).toBe(true);
    // The purchase list has the components' materials, not the hull's own (bought next week).
    expect(p.stages.stages.flatMap((s) => s.lines).some((l) => l.isProduct)).toBe(false);
    const inv = p.prep.find((x) => x.activity === "invention")!;
    expect(inv.name).toBe("Hammerhead II (инвент)");
    expect(inv.runs).toBe(p.invention[0].attempts);
    expect(inv.seconds).toBeCloseTo(inv.runs * p.invention[0].secondsPerAttempt!);
    expect(p.utilization.science).toBeGreaterThan(0);
  });

  it("a pin's decryptor and blueprint source are kept; the pin options list every decryptor", () => {
    const opts = plan.pinOptions(2185);
    expect(opts.invention.length).toBeGreaterThan(1);
    const d = opts.invention.find((x) => x.decryptorId !== null)!;
    const withD = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1, decryptor: d.decryptorId! }] });
    expect(withD.invention[0].decryptor).toBe(d.name);
    expect(withD.invention[0].runsPerBpc).toBe(d.runsPerBpc);
    const none = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1, decryptor: "none" }] });
    expect(none.invention[0].decryptor).toBeNull();
    const owned = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1, source: "owned" }] });
    expect(owned.batches).toEqual([]);
    expect(owned.skipped.map((s) => s.reason)).toContain("закреплено со своим чертежом, а своего нет");
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
    const pinned = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
    const all = [...pinned.batches, ...pinned.nextWeek];
    expect(all.map((b) => b.name)).toEqual(["Hammerhead II"]);
    expect(all[0].profit).toBeLessThan(0); // sold into buy orders only: at a loss, but pinned
  });
});

describe("buildPlan: T1 copies for invention", () => {
  it("own T1 BPO → a copying job on a lab slot before invention; without it → buy BPCs", async () => {
    const without = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
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
    const withBpo = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
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
    const before = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
    const b0 = [...before.batches, ...before.nextWeek][0];
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

    const after = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
    const b = [...after.batches, ...after.nextWeek][0];
    // The batch needs less Morphite than there is: all of it comes from stock, at its market cost.
    expect(b.fromStock).toBeCloseTo(morphite.cost!);
    expect(after.capital).toBeCloseTo(b.capital - b.fromStock);
    expect(after.fromStock).toBeCloseTo(morphite.cost!);
    // Morphite goes into the hull itself, which starts next week: not on this week's list at all.
    expect(after.stages.buy.find((l) => l.typeId === morphite.typeId)?.toBuy ?? 0).toBe(0);
  });
});

describe("buildPlan: what one more slot, character or billion adds", () => {
  it("a small plan that fits everywhere: nothing more to gain, no second pass", () => {
    const p = plan.buildPlan({ ...req, pins: [{ typeId: 2185, units: 1 }] });
    expect(p.marginal.slot).toEqual({ manufacturing: 0, reaction: 0, science: 0 });
    expect(p.marginal.character).toEqual({ like: "Тест", gain: 0 });
    expect(p.marginal.budget).toEqual({ step: 1e9, gain: 0 });
    expect(p.slotPass).toBeNull();
    expect(plan.sheetText(p)).toContain("Что даст ещё");
  });
});

/** SYNTHETIC: every intermediate of a pinned item's chain lies in the stock hangar (the hull can start this week). Returns the cleanup. */
async function stockChainOf(typeId: number): Promise<() => void> {
  const { getDb, saveSettings } = await import("@/server/data");
  const { assets } = await import("@/db/schema");
  const { inArray } = await import("drizzle-orm");
  const first = plan.buildPlan({ ...req, categories: ["t3"], maxItemShare: 1, pins: [{ typeId, units: 1 }] });
  saveSettings({ stockLocationIds: [1_000_000_000_001] });
  const ids: number[] = [];
  for (const l of first.stages.stages.flatMap((s) => s.lines)) {
    if (l.isProduct || l.need <= 0) continue;
    const itemId = 5000 + ids.length;
    ids.push(itemId);
    getDb()
      .insert(assets)
      .values({ itemId, ownerType: "character", ownerId: 1, viaCharacterId: 1, typeId: l.typeId, quantity: l.need * 2, locationId: 1_000_000_000_001, locationFlag: "Hangar", locationType: "other" })
      .run();
  }
  return () => getDb().delete(assets).where(inArray(assets.itemId, ids)).run();
}

describe("buildPlan: manufacturing job cap (Jackdaw, real fixtures)", () => {
  let cleanup = () => {};
  beforeAll(async () => {
    cleanup = await stockChainOf(34828);
  });
  afterAll(() => cleanup());

  it("an invented BPC longer than the cap runs as sequential jobs of ≤ 7 days; the BPC length matches the batch", () => {
    const p = plan.buildPlan({ ...req, categories: ["t3"], maxItemShare: 1, maxManufacturingJobDays: 7, pins: [{ typeId: 34828, units: 1 }] });
    const hull = p.jobs.filter((j) => j.typeId === 34828);
    expect(hull.length).toBeGreaterThan(1);
    for (const j of hull) expect(j.end - j.start).toBeLessThanOrEqual(7);
    expect(hull.map((j) => j.part?.index)).toEqual(hull.map((_, i) => i + 1));
    expect(new Set(hull.map((j) => j.slot)).size).toBe(1);
    const batch = p.batches.find((b) => b.typeId === 34828)!;
    expect(hull.reduce((s, j) => s + j.runs, 0)).toBe(batch.runs);
    // Sized and calculated from the same relic: one BPC = one batch.
    expect(p.invention.find((i) => i.name === "Jackdaw")!.runsPerBpc).toBe(batch.runs);
    // Each part is its own job in the stages (materials rounded per job).
    expect(p.stages.stages.flatMap((s) => s.lines).find((l) => l.typeId === 34828)!.jobs).toEqual(hull.map((j) => j.runs));
  });

  it("without the cap the same BPC is one long job", () => {
    const p = plan.buildPlan({ ...req, categories: ["t3"], maxItemShare: 1, pins: [{ typeId: 34828, units: 1 }] });
    const hull = p.jobs.filter((j) => j.typeId === 34828);
    expect(hull).toHaveLength(1);
    expect(hull[0].part).toBeUndefined();
  });
});

describe("buildPlan: purchase by buy orders, fillers", () => {
  it("lines where a buy order saves enough are marked; the total is their sum; «…без ордерных» leaves them out", async () => {
    const { multibuy } = await import("@/components/BuyList");
    const p = plan.buildPlan({ ...req, categories: ["t3"], maxItemShare: 1, pins: [{ typeId: 34828, units: 1 }] });
    const orders = p.stages.buy.filter((l) => l.order);
    expect(orders.length).toBeGreaterThan(0);
    for (const l of orders) expect(l.order!.saving).toBeGreaterThanOrEqual(1e6);
    expect(p.stages.orderSaving).toBeCloseTo(orders.reduce((s, l) => s + l.order!.saving, 0));
    expect(multibuy(p.stages.buy.filter((l) => !l.order))).not.toContain(orders[0].name + " ");
  });

  it("a filler is a reaction for sale that earns, but less than a batch must", () => {
    expect(plan.isFillerRoute("reactions", 5e6, 30e6)).toBe(true);
    expect(plan.isFillerRoute("reactions", 40e6, 30e6)).toBe(false); // a normal batch
    expect(plan.isFillerRoute("reactions", -1, 30e6)).toBe(false);
    expect(plan.isFillerRoute("rigs_t1", 5e6, 30e6)).toBe(false);
  });
});
