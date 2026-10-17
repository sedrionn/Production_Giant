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
