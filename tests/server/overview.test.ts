import { beforeAll, describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";

let ov: typeof import("@/server/overview");

beforeAll(async () => {
  ov = await import("@/server/overview");
});

describe("batchRuns", () => {
  it("fills ~N days, at least one run, capped by blueprint", () => {
    expect(ov.batchRuns(3600, 5, 0)).toBe(120);
    expect(ov.batchRuns(3600, 5, 20)).toBe(20);
    expect(ov.batchRuns(10 * 86400, 5, 0)).toBe(1);
  });
});

describe("computeOverview on REAL fixtures", () => {
  it("T3 lists Jackdaw with a batch limited by its invented BPC runs", () => {
    const o = ov.computeOverview("t3");
    const jd = o.rows.find((r) => r.name === "Jackdaw");
    expect(jd).toBeDefined();
    expect(jd!.error).toBeNull();
    expect(jd!.blueprintSource).toBe("invention");
    expect(jd!.runs).toBeLessThanOrEqual(20);
    expect(jd!.runs).toBeGreaterThan(0);
    expect(jd!.profitPerRun).toBeCloseTo(jd!.profit! / jd!.runs);
  });

  it("reactions are listed and computed", () => {
    const o = ov.computeOverview("reactions");
    expect(o.rows.length).toBeGreaterThan(5);
    expect(o.rows.filter((r) => r.error)).toEqual([]);
  });

  it("refresh scope covers every market input of the category", () => {
    const s = ov.refreshScope("t3");
    expect(s.products).toContain(34828);
    expect(s.priceTypes.length).toBeGreaterThan(30);
  });
});
