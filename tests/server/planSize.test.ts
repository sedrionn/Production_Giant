import { beforeAll, describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";

let plan: typeof import("@/server/plan");
beforeAll(async () => {
  plan = await import("@/server/plan");
});

describe("own BPCs of different lengths (SYNTHETIC row)", () => {
  it("one batch per copy of its real length, not every copy at the longest one", () => {
    // Raven: T1, no invention — only the owned route. One 10-run BPC and four 1-run BPCs.
    const row = { typeId: 638, name: "Raven", blueprintSource: "bpc", profit: 100e6, runs: 10, jobSeconds: 10 * 3600, maxRuns: 10 } as unknown as import("@/server/plan").Row;
    const r = plan.sizeRoutes(row, 2, 7, 0, [10, 1, 1, 1, 1]);
    expect(r.map((x) => ({ runs: x.runs, maxBatches: x.maxBatches }))).toEqual([
      { runs: 10, maxBatches: 1 },
      { runs: 1, maxBatches: 4 },
    ]);
    expect(r.reduce((s, x) => s + x.runs * (x.maxBatches ?? 0), 0)).toBe(14);
  });
});
