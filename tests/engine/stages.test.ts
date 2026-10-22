import { describe, expect, it } from "vitest";
import { planStages, splitRuns, stageProgress, type StageBuyInfo, type StageRecipe } from "@/engine/stages";

// SYNTHETIC chain: Hull ← 2 Component per run ← 3 Ore + 1 Gas per run (reaction at depth 2: Gas ← 5 Ice).
const recipes = new Map<number, StageRecipe>([
  [1, { typeId: 1, name: "Hull", activity: "manufacturing", outputPerRun: 1, secondsPerRun: 3600, inputs: [{ typeId: 2, perRun: 2 }] }],
  [2, { typeId: 2, name: "Component", activity: "manufacturing", outputPerRun: 1, secondsPerRun: 600, inputs: [{ typeId: 10, perRun: 3 }, { typeId: 3, perRun: 1 }] }],
  [3, { typeId: 3, name: "Gas", activity: "reaction", outputPerRun: 10, secondsPerRun: 1800, inputs: [{ typeId: 11, perRun: 5 }] }],
]);
const buy = new Map<number, StageBuyInfo>([
  [10, { typeId: 10, name: "Ore", unitPrice: 10, volume: 0.1 }],
  [11, { typeId: 11, name: "Ice", unitPrice: 100, volume: 1 }],
  [20, { typeId: 20, name: "Datacore", unitPrice: 1000, volume: 0.1 }],
]);

describe("planStages", () => {
  it("merges product jobs and lists stages deepest first", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 5 }, { typeId: 1, runs: 5 }], recipes, buy, stock: new Map() });
    expect(s.stages.map((x) => x.depth)).toEqual([2, 1, 0]);
    const [gas, comp, hull] = s.stages.map((x) => x.lines[0]);
    expect(hull).toMatchObject({ runs: 10, output: 10, isProduct: true });
    expect(comp).toMatchObject({ need: 20, runs: 20 });
    expect(gas).toMatchObject({ need: 20, runs: 2, output: 20 });
    expect(s.buy.find((b) => b.typeId === 10)).toMatchObject({ need: 60, toBuy: 60, cost: 600 });
    expect(s.buy.find((b) => b.typeId === 11)).toMatchObject({ need: 10, toBuy: 10 });
  });

  it("components in stock are not built, so their inputs are not bought", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 10 }], recipes, buy, stock: new Map([[2, 15], [10, 7]]) });
    const comp = s.stages.find((x) => x.depth === 1)!.lines[0];
    expect(comp).toMatchObject({ need: 20, fromStock: 15, runs: 5 });
    expect(s.buy.find((b) => b.typeId === 10)).toMatchObject({ need: 15, fromStock: 7, toBuy: 8 });
    expect(s.savedByStock).toBe(70);
  });

  it("finished products in the hangar are for sale, not for the plan", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 2 }], recipes, buy, stock: new Map([[1, 50]]) });
    expect(s.stages.find((x) => x.depth === 0)!.lines[0]).toMatchObject({ runs: 2, fromStock: 0 });
  });

  it("invention purchases join the list, stock applies once", () => {
    const s = planStages({
      products: [{ typeId: 1, runs: 1 }],
      recipes,
      buy,
      stock: new Map([[20, 4]]),
      extraBuy: [{ typeId: 20, quantity: 10, note: "инвент" }],
    });
    expect(s.buy.find((b) => b.typeId === 20)).toMatchObject({ need: 10, fromStock: 4, toBuy: 6, cost: 6000, note: "инвент" });
  });

  it("N weeks: materials ×N minus stock (counted once); intermediates and jobs are not touched; m³ and freight", () => {
    const one = planStages({ products: [{ typeId: 1, runs: 10 }], recipes, buy, stock: new Map([[10, 7]]) });
    const three = planStages({ products: [{ typeId: 1, runs: 10 }], recipes, buy, stock: new Map([[10, 7]]), weeks: 3, freightPerM3: 333 });
    // Ore: 60 a week → 180 for 3 weeks, 7 in stock → 173. Ice: 10 → 30.
    expect(three.buy.find((b) => b.typeId === 10)).toMatchObject({ need: 180, fromStock: 7, toBuy: 173, cost: 1730 });
    expect(three.buy.find((b) => b.typeId === 11)).toMatchObject({ need: 30, toBuy: 30 });
    expect(three.stages).toEqual(one.stages);
    expect(three.weeks).toBe(3);
    expect(three.volume).toBeCloseTo(173 * 0.1 + 30 * 1);
    expect(three.freightCost).toBeCloseTo((173 * 0.1 + 30 * 1) * 333);
    expect(one).toMatchObject({ weeks: 1, freightCost: 0 });
  });

  it("buys a safety margin on top of what is short, rounded up", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 10 }], recipes, buy, stock: new Map([[10, 7]]), buffer: 0.01 });
    // Ore: need 60, 7 in stock, 53 short → 53 × 1.01 = 53.53 → 54.
    expect(s.buy.find((b) => b.typeId === 10)).toMatchObject({ need: 60, fromStock: 7, toBuy: 54, buffer: 1, cost: 540 });
  });

  it("no margin when stock covers everything", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 1 }], recipes, buy, stock: new Map([[10, 100], [11, 100]]), buffer: 0.05 });
    expect(s.buy.find((b) => b.typeId === 10)).toMatchObject({ toBuy: 0, buffer: 0 });
  });
});

describe("stageProgress", () => {
  const since = "2026-10-17T00:00:00Z";
  const now = new Date("2026-10-19T00:00:00Z");
  const job = (runs: number, status: string, start: string, end: string, typeId = 2) => ({ productTypeId: typeId, activity: "manufacturing" as const, runs, status, startDate: start, endDate: end });
  it("counts only jobs started after the plan, finished vs running", () => {
    const [p] = stageProgress(
      [{ typeId: 2, activity: "manufacturing", runs: 20 }],
      [
        job(5, "delivered", "2026-10-16T00:00:00Z", "2026-10-16T05:00:00Z"), // before the plan
        job(10, "delivered", "2026-10-17T01:00:00Z", "2026-10-17T05:00:00Z"),
        job(6, "active", "2026-10-18T00:00:00Z", "2026-10-20T00:00:00Z"),
      ],
      since,
      now,
    );
    expect(p).toEqual({ started: 16, done: 10, left: 4, runningUntil: "2026-10-20T00:00:00Z", state: "partial" });
  });
  it("an active job past its end time counts as done; nothing needed = done", () => {
    const [a, b] = stageProgress(
      [
        { typeId: 2, activity: "manufacturing", runs: 3 },
        { typeId: 9, activity: "manufacturing", runs: 0 },
      ],
      [job(3, "active", "2026-10-17T01:00:00Z", "2026-10-18T00:00:00Z")],
      since,
      now,
    );
    expect(a.state).toBe("done");
    expect(b.state).toBe("done");
  });
});

describe("planStages: nothing left to build", () => {
  it("a type reached only through stock-covered inputs gets no line", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 1 }], recipes, buy, stock: new Map([[2, 5]]) });
    expect(s.stages.flatMap((x) => x.lines).map((l) => l.typeId)).toEqual([2, 1]);
  });
});

describe("planStages: game rounding on merged jobs", () => {
  // SYNTHETIC: base 21 per run, ME 10, structure 1% → 18.711 per run. From a 1-run job the old
  // per-run share was ceil(18.711) = 19; for 10 merged runs the game needs ceil(187.11) = 188, not 190.
  const r = new Map<number, StageRecipe>([
    [1, { typeId: 1, name: "Hull", activity: "manufacturing", outputPerRun: 1, secondsPerRun: 60, inputs: [{ typeId: 2, perRun: 2 }] }],
    [2, { typeId: 2, name: "Part", activity: "manufacturing", outputPerRun: 2, secondsPerRun: 60, inputs: [{ typeId: 10, perRun: 19, base: 21 }], me: 10, materialMultiplier: 0.99 }],
  ]);
  it("inputs are recomputed with ME on the merged run count", () => {
    const s = planStages({ products: [{ typeId: 1, runs: 10 }], recipes: r, buy, stock: new Map() });
    expect(s.stages.find((x) => x.depth === 1)!.lines[0]).toMatchObject({ need: 20, runs: 10 });
    expect(s.buy.find((b) => b.typeId === 10)!.need).toBe(188);
  });
  it("a line longer than the limit is split into equal parallel jobs, each rounded on its own", () => {
    expect(splitRuns(10, 3600, 4 * 3600)).toEqual([4, 3, 3]);
    expect(splitRuns(5, 3600)).toEqual([5]);
    // Blueprint limit: 25 000 runs on a blueprint capped at 8 000 per job → 4 jobs.
    expect(splitRuns(25000, 1, undefined, 8000)).toEqual([6250, 6250, 6250, 6250]);
    const long = new Map(r);
    long.set(2, { ...r.get(2)!, maxJobSeconds: 300 });
    const s = planStages({ products: [{ typeId: 1, runs: 10 }], recipes: long, buy, stock: new Map() });
    expect(s.stages.find((x) => x.depth === 1)!.lines[0].jobs).toEqual([5, 5]);
    // 2 × ceil(93.555) = 188.
    expect(s.buy.find((b) => b.typeId === 10)!.need).toBe(188);
  });
});
