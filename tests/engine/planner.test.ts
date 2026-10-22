import { describe, expect, it } from "vitest";
import { batchRunsForCadence, nextLogin, planWeek, slotDays, type PlanBatch, type SlotState } from "@/engine/planner";

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
    const p = planWeek({ candidates: [ship(1, 100, 10)], slots: slots(3), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 2, unitCap: () => 99 });
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
    const jobsOf = (x: typeof p) => x.prep.filter((j) => j.typeId === 500).reduce((n, j) => n + j.jobs, 0);
    expect(p.prep.reduce((n, j) => n + j.runs, 0)).toBe(30);
    expect(jobsOf(p)).toBe(2);
    // The blueprint allows only 5 runs per job → 6 jobs.
    const capped = long(1);
    capped.jobs[0].maxRunsPerJob = 5;
    expect(jobsOf(planWeek({ candidates: [capped], slots: slots(6), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 3, unitCap: () => 99 }))).toBe(6);
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

describe("planWeek: pinned items", () => {
  it("a pinned item goes in first even when it ranks last, past the budget share and the market cap", () => {
    const p = planWeek({
      candidates: [ship(1, 300, 30), { ...ship(2, 10, 50), pinned: 1 }],
      slots: slots(4),
      budget: 100,
      cadenceDays: 2,
      horizonDays: 7,
      maxBatchesPerItem: 5,
      unitCap: (id) => (id === 2 ? 0 : 99),
      maxItemShare: 0.3,
    });
    expect(p.batches[0].typeId).toBe(2);
    expect(p.batches.map((b) => b.typeId)).toEqual([2, 1]);
  });

  it("a pinned item that does not fit is reported with the reason", () => {
    const p = planWeek({ candidates: [{ ...ship(1, 100, 80), pinned: 2 }], slots: slots(4), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 5, unitCap: () => 99 });
    expect(p.batches).toHaveLength(1);
    expect(p.skipped).toEqual([{ name: "Ship 1", reason: "закреплено 2 шт., вошло 1: не хватает бюджета" }]);
  });

  it("a pinned item at a loss is still planned (Nick decided); an unpinned one is not", () => {
    const loss = { ...ship(1, -5, 10), pinned: 1 };
    expect(planWeek({ candidates: [loss], slots: slots(1), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 5, unitCap: () => 99 }).batches).toHaveLength(1);
    expect(planWeek({ candidates: [{ ...loss, pinned: undefined }], slots: slots(1), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 5, unitCap: () => 99 }).batches).toHaveLength(0);
  });
});

describe("planWeek: invention on lab slots", () => {
  // SYNTHETIC: an invented ship, 1/chance = 2.5 attempts of 20 h each per BPC.
  const invented = (id: number): PlanBatch => {
    const b = ship(id, 100, 10);
    return { ...b, jobs: [...b.jobs, { typeId: id, name: `Ship ${id} (инвент)`, activity: "invention", runs: 2.5, seconds: 2.5 * 20 * H, depth: 2 }] };
  };
  const labs = (n: number): SlotState[] => Array.from({ length: n }, (_, i) => ({ kind: "science", owner: `C${i}`, freeAt: 0 }));

  it("attempts are pooled and rounded up once; invention starts at the first login; lab time does not change the ranking", () => {
    const p = planWeek({ candidates: [invented(1)], slots: [...slots(3), ...labs(1)], budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 2, unitCap: () => 99 });
    expect(p.batches).toHaveLength(2);
    const inv = p.prep.find((x) => x.activity === "invention")!;
    expect(inv).toMatchObject({ runs: 5, start: 0 });
    expect(inv.seconds).toBeCloseTo(5 * 20 * H);
    expect(p.utilization.science).toBeCloseTo(100 / 24 / 7);
    expect(slotDays(invented(1), 2)).toBe(slotDays(ship(1, 100, 10), 2));
    // The component (depth 1) still starts today: invention does not shift the chain.
    expect(p.prep.find((x) => x.name === "Component")!.start).toBe(0);
  });

  it("no lab time left → the invented batch is skipped", () => {
    const p = planWeek({ candidates: [invented(1)], slots: [...slots(2), ...labs(1)], budget: 100, cadenceDays: 2, horizonDays: 2, maxBatchesPerItem: 2, unitCap: () => 99 });
    expect(p.batches).toHaveLength(0);
    expect(p.skipped[0].reason).toBe("не хватит лабораторных слотов на инвент");
  });
});

describe("planWeek: a pin counts per item across routes", () => {
  // SYNTHETIC: own BPCs (2 copies, better) and invention (unlimited) for the same item.
  const own = { ...ship(1, 200, 10), key: "1:owned", maxBatches: 2, pinned: 3 };
  const inv = { ...ship(1, 100, 10), key: "1:invention", pinned: 3 };

  it("own BPCs run out → the rest comes from invention", () => {
    const p = planWeek({ candidates: [inv, own], slots: slots(6), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 0 });
    expect(p.batches.map((b) => b.key)).toEqual(["1:owned", "1:owned", "1:invention"]);
    expect(p.skipped).toEqual([]);
  });

  it("not enough budget for all: one line with how many fit and why", () => {
    const p = planWeek({ candidates: [inv, own], slots: slots(6), budget: 25, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 0 });
    expect(p.batches).toHaveLength(2);
    expect(p.skipped).toEqual([{ name: "Ship 1", reason: "закреплено 3 шт., вошло 2: не хватает бюджета" }]);
  });
});

describe("planWeek: reaction length cap", () => {
  // SYNTHETIC: a reaction sold as a product, 10 runs × 12 h = 5 days; a component reaction of 6 days.
  const rx: PlanBatch = {
    typeId: 9,
    name: "Reaction",
    runs: 10,
    units: 2000,
    profit: 100,
    capital: 10,
    jobs: [
      { typeId: 8, name: "Sub reaction", activity: "reaction", runs: 12, seconds: 144 * H, depth: 1 },
      { typeId: 9, name: "Reaction", activity: "reaction", runs: 10, seconds: 120 * H, depth: 0 },
    ],
  };
  const rxSlots = (n: number): SlotState[] => Array.from({ length: n }, (_, i) => ({ kind: "reaction", owner: `R${i}`, freeAt: 0 }));

  it("a 5-day product reaction runs as 3 parallel jobs of ≤ 2 days; the pooled one is split too", () => {
    const p = planWeek({ candidates: [rx], slots: rxSlots(6), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 1e9, maxJobDays: { reaction: 2 } });
    expect(p.jobs.map((j) => j.runs)).toEqual([4, 3, 3]);
    expect(new Set(p.jobs.map((j) => j.slot)).size).toBe(3);
    expect(Math.max(...p.jobs.map((j) => j.end - j.start))).toBeLessThanOrEqual(2);
    expect(p.jobs.every((j) => j.start === 0)).toBe(true);
    expect(p.batches[0]).toMatchObject({ start: 0, end: 2 });
    expect(p.prep[0]).toMatchObject({ name: "Sub reaction", jobs: 3 });
  });

  it("without the cap it stays one job", () => {
    const p = planWeek({ candidates: [rx], slots: rxSlots(6), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 1, unitCap: () => 1e9 });
    expect(p.jobs).toHaveLength(1);
    expect(p.prep[0].jobs).toBe(1);
  });

  it("not enough slots for all parts inside the week → the batch is not taken", () => {
    const p = planWeek({ candidates: [rx], slots: rxSlots(1), budget: 100, cadenceDays: 2, horizonDays: 3, maxBatchesPerItem: 1, unitCap: () => 1e9, maxJobDays: { reaction: 2 } });
    expect(p.batches).toHaveLength(0);
    expect(p.jobs).toHaveLength(0);
  });
});

describe("planWeek: pooled jobs go on real free slots", () => {
  it("slots busy with hulls → components wait for the next login", () => {
    const p = planWeek({ candidates: [ship(1, 100, 10)], slots: slots(2), budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 2, unitCap: () => 99 });
    expect(p.jobs.map((j) => j.start)).toEqual([0, 0]);
    expect(p.prep).toEqual([expect.objectContaining({ name: "Component", start: 2 })]);
    expect(p.warnings).toEqual([]);
  });

  it("more parallel jobs than slots: the rest moves to the next login; past the end of the plan → a warning", () => {
    // SYNTHETIC: 30 reaction jobs of 1.5 days (45 slot-days, fits 2 slots × 28 days in total), but
    // each one holds its slot until the next login (2 days): only 28 start before the end.
    const rx: PlanBatch = {
      ...ship(1, 100, 10),
      jobs: [
        { typeId: 7, name: "Sub reaction", activity: "reaction", runs: 30, seconds: 30 * 36 * H, depth: 1 },
        { typeId: 1, name: "Ship 1", activity: "manufacturing", runs: 4, seconds: 40 * H, depth: 0 },
      ],
    };
    const rxSlots: SlotState[] = [0, 1].map((i) => ({ kind: "reaction", owner: `R${i}`, freeAt: 0 }));
    const p = planWeek({ candidates: [rx], slots: [...slots(1), ...rxSlots], budget: 100, cadenceDays: 2, horizonDays: 28, maxBatchesPerItem: 1, unitCap: () => 99, maxJobDays: { reaction: 1.5 } });
    const sub = p.prep.filter((j) => j.typeId === 7);
    expect(sub.map((j) => [j.start, j.jobs])).toEqual([[0, 2], [2, 2], [4, 2], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2], [16, 2], [18, 2], [20, 2], [22, 2], [24, 2], [26, 2], [28, 2]]);
    expect(p.warnings).toEqual(["Sub reaction: 2 из 30 джоб — не хватает свободных реакционных слотов до конца плана, начнутся позже"]);
  });
});

describe("planWeek: T1 copies before invention", () => {
  // SYNTHETIC: an invented ship; 2.5 attempts per BPC, each eats one 1-run T1 copy of 1 h.
  const withCopies = (id: number): PlanBatch => {
    const b = ship(id, 100, 10);
    return {
      ...b,
      jobs: [
        ...b.jobs,
        { typeId: id, name: `Ship ${id} (инвент)`, activity: "invention", runs: 2.5, seconds: 2.5 * 10 * H, depth: 2 },
        { typeId: id, name: "Ship BP (копии)", activity: "copying", runs: 2.5, seconds: 2.5 * H, depth: 3 },
      ],
    };
  };
  const labs: SlotState[] = [0, 1].map((i) => ({ kind: "science", owner: `L${i}`, freeAt: 0 }));

  it("copies go on a lab slot at the first login; invention waits for the next login; both rounded up once", () => {
    const p = planWeek({ candidates: [withCopies(1)], slots: [...slots(3), ...labs], budget: 100, cadenceDays: 2, horizonDays: 7, maxBatchesPerItem: 2, unitCap: () => 99 });
    const copy = p.prep.find((x) => x.activity === "copying")!;
    const inv = p.prep.find((x) => x.activity === "invention")!;
    expect(copy).toMatchObject({ runs: 5, start: 0 });
    expect(copy.seconds).toBeCloseTo(5 * H);
    expect(inv).toMatchObject({ runs: 5, start: 2 });
    // The component chain is not pushed back by the lab jobs.
    expect(p.prep.find((x) => x.name === "Component")!.start).toBe(0);
    expect(p.logins.find((l) => l.day === 0)!.prep.map((x) => x.activity)).toContain("copying");
  });
});
