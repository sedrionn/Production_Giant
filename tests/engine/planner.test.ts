import { describe, expect, it } from "vitest";
import { batchRunsForCadence, nextLogin, planWeek, type PlanBatch, type SlotState } from "@/engine/planner";

const H = 3600;

describe("batchRunsForCadence", () => {
  it("20 h per run, login every 2 days: the batch that ends closest to a login wins", () => {
    // 2 runs = 40 h in a 2-day window (1/day); 7 runs = 140 h in a 6-day window (1.17/day).
    expect(batchRunsForCadence({ secondsPerRun: 20 * H, profitPerRun: 1, maxRuns: 0, cadenceDays: 2, horizonDays: 7 })).toBe(7);
  });
  it("respects the blueprint run cap", () => {
    expect(batchRunsForCadence({ secondsPerRun: 1 * H, profitPerRun: 1, maxRuns: 10, cadenceDays: 2, horizonDays: 7 })).toBe(10);
  });
  it("prefers fewer logins on ties", () => {
    // 24 h runs, cadence 2: k=1 → 2 runs/2 days, k=3 → 6 runs/6 days: same rate, longer wins.
    expect(batchRunsForCadence({ secondsPerRun: 24 * H, profitPerRun: 1, maxRuns: 0, cadenceDays: 2, horizonDays: 7 })).toBe(6);
  });
});

describe("nextLogin", () => {
  it("snaps up to the cadence grid", () => {
    expect(nextLogin(0, 2)).toBe(0);
    expect(nextLogin(0.5, 2)).toBe(2);
    expect(nextLogin(4, 2)).toBe(4);
  });
});

// SYNTHETIC batches: a ship with one component job (depth 1) and the hull job (depth 0).
const ship = (typeId: number, profit: number, capital: number): PlanBatch => ({
  typeId,
  name: `Ship ${typeId}`,
  runs: 4,
  units: 4,
  profit,
  capital,
  jobs: [
    { typeId: 100 + typeId, name: "Component", activity: "manufacturing", runs: 8, seconds: 10 * H, depth: 1 },
    { typeId, name: `Ship ${typeId}`, activity: "manufacturing", runs: 4, seconds: 40 * H, depth: 0 },
  ],
});
const slots = (n: number, freeAt = 0): SlotState[] => Array.from({ length: n }, (_, i) => ({ kind: "manufacturing", owner: `C${i}`, freeAt }));

describe("planWeek (steady state: hulls from ready components, next components pooled)", () => {
  it("hull starts at today's login; components for the next round are one merged job", () => {
    const p = planWeek({ candidates: [ship(1, 100, 10)], slots: slots(2), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 2, unitCap: () => 99 });
    expect(p.batches).toHaveLength(2);
    expect(p.jobs.map((j) => j.start)).toEqual([0, 0]);
    expect(p.prep).toEqual([expect.objectContaining({ name: "Component", runs: 16, seconds: 20 * H, start: 0 })]);
    expect(p.logins.map((l) => l.day)).toEqual([0, 2]);
  });

  it("budget and market cap limit the plan; best profit per slot-day goes first", () => {
    const p = planWeek({
      candidates: [ship(1, 100, 60), ship(2, 300, 60)],
      slots: slots(4),
      budget: 100,
      cadenceDays: 2,
      horizonDays: 7,
      maxBatchesPerItem: 5,
      unitCap: () => 4,
    });
    expect(p.batches.map((b) => b.typeId)).toEqual([2]);
    expect(p.skipped).toEqual([{ name: "Ship 1", reason: "не хватает бюджета" }]);
  });

  it("tier beats score: Caldari ships first", () => {
    const p = planWeek({
      candidates: [{ ...ship(1, 300, 60), tier: 1 }, { ...ship(2, 100, 60), tier: 0 }],
      slots: slots(4),
      budget: 60,
      cadenceDays: 2,
      horizonDays: 7,
      maxBatchesPerItem: 1,
      unitCap: () => 99,
    });
    expect(p.batches.map((b) => b.typeId)).toEqual([2]);
  });

  it("one item may take only its share of the budget: the rest goes to other items", () => {
    const p = planWeek({
      candidates: [ship(1, 300, 30), ship(2, 100, 30)],
      slots: slots(6),
      budget: 100,
      cadenceDays: 2,
      horizonDays: 7,
      maxBatchesPerItem: 5,
      unitCap: () => 99,
      maxItemShare: 0.6,
    });
    expect(p.batches.map((b) => b.typeId)).toEqual([1, 1, 2]);
    expect(p.skipped).toEqual([]);
  });

  it("a reaction sold as a product takes a reaction slot, not a factory one", () => {
    const rx: PlanBatch = {
      typeId: 9,
      name: "Reaction",
      runs: 10,
      units: 2000,
      profit: 100,
      capital: 10,
      jobs: [{ typeId: 9, name: "Reaction", activity: "reaction", runs: 10, seconds: 40 * H, depth: 0 }],
    };
    const p = planWeek({
      candidates: [rx],
      slots: [{ kind: "manufacturing", owner: "A", freeAt: 0 }, { kind: "reaction", owner: "A", freeAt: 0 }],
      budget: 100,
      cadenceDays: 2,
      horizonDays: 7,
      maxBatchesPerItem: 1,
      unitCap: () => 1e9,
    });
    expect(p.jobs[0].slot).toBe(1);
    expect(p.utilization.reaction).toBeGreaterThan(0);
    expect(p.utilization.manufacturing).toBe(0);
  });

  it("a pooled component longer than the plan is split into parallel jobs", () => {
    // 3 batches × 60 h of components = 180 h > 7-day plan → 2 jobs.
    const long = (id: number): PlanBatch => ({ ...ship(id, 100, 10), jobs: [{ typeId: 500, name: "Component", activity: "manufacturing", runs: 10, seconds: 60 * H, depth: 1 }, { typeId: id, name: `Ship ${id}`, activity: "manufacturing", runs: 4, seconds: 40 * H, depth: 0 }] });
    const p = planWeek({ candidates: [long(1)], slots: slots(6), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 3, unitCap: () => 99 });
    expect(p.prep[0]).toMatchObject({ runs: 30, jobs: 2 });
  });

  it("busy slots push the start to the login after they free up", () => {
    const p = planWeek({ candidates: [ship(1, 100, 10)], slots: slots(1, 3.2), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 99 });
    expect(p.jobs[0].start).toBe(4);
  });

  it("nothing starts after the horizon", () => {
    const p = planWeek({ candidates: [ship(1, 100, 10)], slots: slots(1, 7), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 99 });
    expect(p.batches).toEqual([]);
    expect(p.skipped[0].reason).toMatch(/слотов/);
  });
});

describe("batchRunsForCadence with a minimum batch profit", () => {
  it("a batch below the minimum loses to a bigger one even at a better daily rate", () => {
    // 12.5 h runs, 6.4/run: 3 runs (2 d) = 19.2/2 d is below 30; 7 runs (4 d) = 44.8 clears it.
    const runs = batchRunsForCadence({ secondsPerRun: 12.5 * H, profitPerRun: 6.4, maxRuns: 10, cadenceDays: 2, horizonDays: 7, minProfit: 30 });
    expect(runs).toBe(7);
  });
});
