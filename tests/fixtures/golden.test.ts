/**
 * GOLDEN tests on REAL data (fixtures/, SDE build in subset.meta.build).
 * Expected numbers come from Nick's old Google Sheet where it was correct.
 */
import { describe, expect, it } from "vitest";
import { loadFixtures } from "./loadFixtures";
import { materialsForJob, runsNeeded } from "@/engine/materials";
import { materialMultiplier, NPC_STATION, timeMultiplier } from "@/engine/facility";
import { estimatedItemValue, jobInstallCost, jobTime, skillTimeMultiplier } from "@/engine/jobCost";
import { buildTree, type TreeContext } from "@/engine/tree";
import { recipeLookup } from "@/sde/recipes";

const fx = loadFixtures();
const JACKDAW = 34828;
const RAM = 11478;

function producer(typeId: number) {
  const ref = fx.sde.findProducers(typeId, "manufacturing")[0];
  return fx.sde.getBlueprint(ref.blueprintTypeId)!.activities.manufacturing!;
}

describe("old sheet: Jackdaw 20 runs, ME 4, no structure bonus", () => {
  const expected: Record<number, number> = {
    30466: 39, 30002: 39, 30476: 39, 30464: 154, 29992: 39, 30478: 39, 34396: 58, 29994: 39, 11478: 192,
  };

  it("matches the sheet for every material", () => {
    const lines = materialsForJob(producer(JACKDAW).materials, 20, 4, materialMultiplier(NPC_STATION, "manufacturing"));
    expect(Object.fromEntries(lines.map((l) => [l.typeId, l.quantity]))).toEqual(expected);
  });
});

describe("old sheet bug #1 on real data: R.A.M.", () => {
  it("one run makes 100 units", () => {
    expect(producer(RAM).products[0].quantity).toBe(100);
  });

  it("192 R.A.M. = 2 runs, needing ~1 112 Tritanium, not 85 402", () => {
    const act = producer(RAM);
    expect(runsNeeded(act.products[0], 192)).toBe(2);
    const trit = materialsForJob(act.materials, 2, 10).find((m) => m.typeId === 34)!;
    expect(trit.quantity).toBeLessThan(1200);
  });
});

describe("build tree on REAL data", () => {
  const sotiyo = { structure: "sotiyo" as const, security: "null" as const, rigs: [], facilityTax: 0 };
  const tatara = { structure: "tatara" as const, security: "null" as const, rigs: [], facilityTax: 0 };
  const ci = fx.costIndices(30000144);
  const ctx: TreeContext = {
    recipe: recipeLookup(fx.sde),
    blueprintLevels: () => ({ me: 10, te: 20 }),
    facility: (a) => (a === "reaction" ? tatara : sotiyo),
    costIndex: (a) => ci[a] ?? 0,
    quote: fx.quote,
    adjustedPrice: fx.adjustedPrice,
    materialPriceMode: "sell",
    fees: { salesTax: 0.03375, brokerFee: 0.015 },
  };

  it.each([
    ["Jackdaw", JACKDAW, 20],
    ["Hammerhead II", 2185, 100],
    ["Capital Armor Plates", 21017, 10],
  ])("%s: consistent totals, every job reachable, no warnings", (_, typeId, runs) => {
    const t = buildTree(typeId, runs, ctx);
    expect(t.warnings).toEqual([]);
    expect(t.jobs.at(-1)!.typeId).toBe(typeId);
    expect(t.materialCost).toBeCloseTo(t.shopping.reduce((s, l) => s + (l.cost ?? 0), 0));
    // each type appears at most once as a job (aggregation)
    const ids = t.jobs.map((j) => j.typeId);
    expect(new Set(ids).size).toBe(ids.length);
    // every built job's output covers its demand
    for (const j of t.jobs) expect(j.output).toBeGreaterThanOrEqual(t.nodes.get(j.typeId)!.demand);
    // reactions run without ME
    for (const j of t.jobs.filter((x) => x.activity === "reaction")) expect(j.me).toBe(0);
  });

  it("Jackdaw: polymer reactions aggregate into single jobs", () => {
    const t = buildTree(JACKDAW, 20, ctx);
    const fullero = t.jobs.filter((j) => fx.sde.getType(j.typeId)?.name === "Fulleroferrocene");
    expect(fullero).toHaveLength(1);
    expect(fullero[0].activity).toBe("reaction");
  });
});

/**
 * GOLDEN from the game (Nick's screenshots, 2026-10-16): Jackdaw × 20, BPC ME 4 / TE 14,
 * EVEGuru Industrial Park Sotiyo in Auner (lowsec, FW −50%, tax 1%, XL Ship Manufacturing rig),
 * Industry V, Advanced Industry V, all required skills V.
 */
describe("in-game check: Jackdaw × 20 in Auner Sotiyo", () => {
  const act = producer(JACKDAW);
  const auner = {
    structure: "sotiyo" as const,
    security: "low" as const,
    facilityTax: 0.01,
    systemJobBonus: 0.5,
    rigs: [
      { name: "Standup XL-Set Ship Manufacturing Efficiency I", activity: "manufacturing" as const, scopes: ["ships" as const], material: 0.02, time: 0.2 },
    ],
  };
  const ship = { categoryId: 6, groupId: 1305 };

  it("EIV = 1 298 218 183 ISK (to the ISK)", () => {
    expect(Math.round(estimatedItemValue(act.materials, 20, fx.adjustedPrice).eiv)).toBe(1_298_218_183);
  });

  it("job cost lines match the in-game tooltip", () => {
    // Game shows 12.23% (rounded); the exact index is index-part / EIV.
    const index = 158_764_056 / 1_298_218_183;
    const c = jobInstallCost(1_298_218_183, "manufacturing", index, auner);
    expect(c.grossCost).toBeCloseTo(75_412_927, -1);
    expect(c.facilityTax).toBeCloseTo(12_982_182, -1);
    expect(c.sccSurcharge).toBeCloseTo(51_928_727, -1);
    expect(c.total).toBeCloseTo(140_323_836, -1);
  });

  it("job duration = 9d 01:36:16 (±1 min)", () => {
    const t = jobTime(act.time, 20, 14, "manufacturing", auner, { industry: 5, advancedIndustry: 5, blueprintSkills: 5 }, ship, act.skills);
    expect(Math.abs(t - (9 * 86400 + 1 * 3600 + 36 * 60 + 16))).toBeLessThan(60);
  });

  it("skills −41.7%, rig −38%, structure −30% as listed in game", () => {
    expect(1 - skillTimeMultiplier("manufacturing", { industry: 5, advancedIndustry: 5, blueprintSkills: 5 }, act.skills)).toBeCloseTo(0.417, 3);
    expect(1 - timeMultiplier(auner, "manufacturing", ship)).toBeCloseTo(1 - 0.7 * 0.62, 6);
  });

  it("Thukker rig: nullsec ×0.1, capital components 3.7%", () => {
    const thukker = { high: 0.1, low: 1.9, null: 0.1 };
    const rigs = [
      { activity: "manufacturing" as const, scopes: ["components" as const, "structures" as const], material: 0.02, time: 0.2, security: thukker },
      { activity: "manufacturing" as const, scopes: ["capital_components" as const], material: 0.037, time: 0.2, security: thukker },
    ];
    const low = { ...auner, rigs };
    const nul = { ...low, security: "null" as const };
    const capital = { categoryId: 17, groupId: 873 };
    const t3comp = { categoryId: 17, groupId: 964 };
    expect(materialMultiplier(low, "manufacturing", capital)).toBeCloseTo(0.99 * (1 - 0.037 * 1.9), 10);
    expect(materialMultiplier(low, "manufacturing", t3comp)).toBeCloseTo(0.99 * (1 - 0.02 * 1.9), 10);
    expect(materialMultiplier(nul, "manufacturing", t3comp)).toBeCloseTo(0.99 * (1 - 0.02 * 0.1), 10);
  });
});
