import { describe, expect, it } from "vitest";
import { planStages, stageProgress, type StageBuyInfo, type StageRecipe } from "@/engine/stages";

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
