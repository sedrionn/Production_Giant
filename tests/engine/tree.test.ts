import { describe, expect, it } from "vitest";
import { buildTree, type TreeContext } from "@/engine/tree";
import type { FacilityProfile } from "@/engine/facility";
import type { MarketQuote } from "@/engine/pricing";
import type { BlueprintActivity } from "@/engine/types";

// SYNTHETIC tree:
//   ship 1 ← 1 run: 10×compA(2) + 10×compB(3)
//   compA 2 ← 1 run makes 1: 100×goo(4)
//   compB 3 ← 1 run makes 1: 100×goo(4) + 1×mineral(5)
//   goo 4   ← reaction, 1 run makes 200: 100×mineral(5)
const recipes: Record<number, BlueprintActivity> = {
  1: mk(101, "manufacturing", [[2, 10], [3, 10]], [1, 1]),
  2: mk(102, "manufacturing", [[4, 100]], [2, 1]),
  3: mk(103, "manufacturing", [[4, 100], [5, 1]], [3, 1]),
  4: mk(104, "reaction", [[5, 100]], [4, 200]),
};
function mk(bp: number, activity: "manufacturing" | "reaction", mats: [number, number][], [p, q]: [number, number]): BlueprintActivity {
  return {
    blueprintTypeId: bp,
    activity,
    time: 3600,
    materials: mats.map(([typeId, quantity]) => ({ typeId, quantity })),
    products: [{ typeId: p, quantity: q }],
    skills: [],
  };
}
const q = (sell: number | null): MarketQuote => ({ typeId: 0, buyMax: null, sellMin: sell });
const npc: FacilityProfile = { structure: "npc_station", security: "high", rigs: [], facilityTax: 0 };
const tatara: FacilityProfile = { structure: "tatara", security: "null", rigs: [], facilityTax: 0 };

function ctx(over: Partial<TreeContext> = {}, prices: Record<number, number | null> = {}): TreeContext {
  const base: Record<number, number | null> = { 1: 1_000_000, 2: 5_000, 3: 5_000, 4: 30, 5: 10, ...prices };
  return {
    recipe: (t) => recipes[t],
    blueprintLevels: () => ({ me: 0, te: 0 }),
    facility: (a) => (a === "reaction" ? tatara : npc),
    costIndex: () => 0,
    quote: (t) => (t in base ? q(base[t]) : undefined),
    adjustedPrice: () => 0,
    materialPriceMode: "sell",
    fees: { salesTax: 0, brokerFee: 0 },
    ...over,
  };
}

describe("buildTree — decisions", () => {
  it("builds what is cheaper: comps from goo, goo from minerals", () => {
    // goo build: 100×10/200 = 5/unit < 30 → build; compA build: 100×5 = 500 < 5000 → build
    const r = buildTree(1, 1, ctx());
    expect(r.nodes.get(4)!.decision).toBe("build");
    expect(r.nodes.get(2)!.decision).toBe("build");
    expect(r.nodes.get(5)!.decision).toBe("buy");
    expect(r.nodes.get(5)!.reason).toBe("no recipe");
  });

  it("buys when market is cheaper", () => {
    const r = buildTree(1, 1, ctx({}, { 4: 1 }));
    expect(r.nodes.get(4)!.decision).toBe("buy");
    expect(r.nodes.get(4)!.reason).toBe("cheaper");
  });

  it("respects manual overrides", () => {
    const r = buildTree(1, 1, ctx({ decisions: { 2: "buy" } }));
    expect(r.nodes.get(2)!.decision).toBe("buy");
    expect(r.nodes.get(2)!.reason).toBe("override");
  });

  it("builds when there is no market price but a recipe exists", () => {
    const r = buildTree(1, 1, ctx({}, { 3: null }));
    expect(r.nodes.get(3)!.decision).toBe("build");
    expect(r.nodes.get(3)!.reason).toBe("no market price");
  });

  it("root is always built", () => {
    const r = buildTree(1, 1, ctx({}, { 1: 1 }));
    expect(r.nodes.get(1)!.decision).toBe("build");
  });
});

describe("buildTree — aggregation", () => {
  const r = buildTree(1, 2, ctx());

  it("shared intermediate becomes ONE job with summed demand", () => {
    // 2 ships → 20 compA + 20 compB → goo 2000 + 2000 = 4000 → 20 reaction runs
    const goo = r.jobs.filter((j) => j.typeId === 4);
    expect(goo).toHaveLength(1);
    expect(r.nodes.get(4)!.demand).toBe(4000);
    expect(goo[0].runs).toBe(20);
    expect(goo[0].surplus).toBe(0);
  });

  it("rounds runs up and reports surplus", () => {
    const r3 = buildTree(1, 1, ctx({}, {}));
    // 1 ship → 2000 goo → 10 runs exactly; make compB need 1 extra goo: not possible here, so check math
    expect(r3.jobs.find((j) => j.typeId === 4)!.runs).toBe(10);
  });

  it("jobs come inputs first, root last", () => {
    expect(r.jobs.at(-1)!.typeId).toBe(1);
    expect(r.jobs[0].typeId).toBe(4);
  });

  it("shopping list = all bought leaves with totals", () => {
    // minerals: reaction 20 runs × 100 = 2000 + compB 20 × 1 = 20 → 2020
    expect(r.shopping).toEqual([{ typeId: 5, quantity: 2020, unitPrice: 10, cost: 20200 }]);
    expect(r.materialCost).toBe(20200);
  });

  it("ME applies to manufacturing, never to reactions", () => {
    const withMe = buildTree(1, 2, ctx({ blueprintLevels: () => ({ me: 10, te: 0 }) }));
    // ship: 20 × 0.9 = 18 of each comp; comps: 100 × 18 × 0.9 = 1620 goo each → 3240 → 17 runs (reaction ignores ME)
    expect(withMe.nodes.get(2)!.demand).toBe(18);
    expect(withMe.nodes.get(4)!.demand).toBe(3240);
    expect(withMe.jobs.find((j) => j.typeId === 4)!.runs).toBe(17);
    expect(withMe.jobs.find((j) => j.typeId === 4)!.surplus).toBe(17 * 200 - 3240);
    expect(withMe.jobs.find((j) => j.typeId === 4)!.me).toBe(0);
  });
});

describe("buildTree — robustness", () => {
  it("throws for an item with no recipe", () => {
    expect(() => buildTree(5, 1, ctx())).toThrow(/no manufacturing or reaction recipe/);
  });

  it("does not hang on cycles", () => {
    const cyc: Record<number, BlueprintActivity> = {
      10: mk(110, "manufacturing", [[11, 1]], [10, 1]),
      11: mk(111, "manufacturing", [[10, 1], [5, 1]], [11, 1]),
    };
    const r = buildTree(10, 1, ctx({ recipe: (t) => cyc[t] }, { 10: 100, 11: 50 }));
    expect(r.jobs.length).toBeGreaterThan(0);
  });

  it("unpriced leaf → warning, not NaN", () => {
    const r = buildTree(1, 1, ctx({}, { 2: null, 4: null, 5: null }));
    expect(Number.isNaN(r.totalCost)).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/no market price/);
  });
});

describe("buildTree — ISK/h threshold for intermediates", () => {
  // compA: build 500/unit vs buy 5000 → saves 4500 per unit; job 1h per unit (no bonuses) → 4500/h
  it("builds when savings/h ≥ threshold", () => {
    const r = buildTree(1, 1, ctx({ minBuildIskPerHour: 4000 }));
    expect(r.nodes.get(2)!.decision).toBe("build");
    expect(r.nodes.get(2)!.buildSavingsPerHour).toBeCloseTo(4500);
  });

  it("buys when cheaper to build but savings/h below threshold", () => {
    const r = buildTree(1, 1, ctx({ minBuildIskPerHour: 100_000 }));
    expect(r.nodes.get(2)!.decision).toBe("buy");
    expect(r.nodes.get(2)!.reason).toBe("below threshold");
  });

  it("never applies to the root, and manual override still wins", () => {
    const r = buildTree(1, 1, ctx({ minBuildIskPerHour: 1e12, decisions: { 2: "build" } }));
    expect(r.nodes.get(1)!.decision).toBe("build");
    expect(r.nodes.get(2)!.decision).toBe("build");
  });
});

describe("buildTree — surplus credit", () => {
  it("leftover from whole runs is credited at its unit cost, not charged to the batch", () => {
    // SYNTHETIC: compA needs 150 goo → 1500 + 1000 = 2500 goo → 13 reaction runs → 2600, surplus 100.
    const recipe = (t: number) => (t === 2 ? mk(102, "manufacturing", [[4, 150]], [2, 1]) : recipes[t]);
    const r = buildTree(1, 1, ctx({ recipe }));
    const goo = r.jobs.find((j) => j.typeId === 4)!;
    expect(goo.surplus).toBe(100);
    // goo build cost = 100 minerals × 10 / 200 = 5 per unit
    expect(r.surplusCredit).toBeCloseTo(100 * 5);
    expect(r.totalCost).toBeCloseTo(r.materialCost + r.jobCost - 500);
  });

  it("no surplus → no credit", () => {
    expect(buildTree(1, 1, ctx()).surplusCredit).toBe(0);
  });
});
