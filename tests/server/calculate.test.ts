import { beforeAll, describe, expect, it } from "vitest";
import type { CalcResponse } from "@/server/calculate";

// Deterministic: committed REAL fixtures + throwaway app DB with default presets.
process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";

let calculate: typeof import("@/server/calculate").calculate;
let priceTypesFor: typeof import("@/server/calculate").priceTypesFor;
let data: typeof import("@/server/data");

beforeAll(async () => {
  ({ calculate, priceTypesFor } = await import("@/server/calculate"));
  data = await import("@/server/data");
});

describe("calculate (server) on fixtures", () => {
  let jackdaw: CalcResponse;
  beforeAll(() => {
    jackdaw = calculate({ typeId: 34828, runs: 20 });
  });

  it("uses the fixture SDE and fixture prices", () => {
    expect(jackdaw.sde.kind).toBe("fixtures");
    expect(jackdaw.prices.fixtures).toBeGreaterThan(0);
    expect(jackdaw.prices.esi).toBe(0);
  });

  it("defaults to invention for a T3 hull and picks the cheapest relic per run", () => {
    expect(jackdaw.request.blueprintSource).toBe("invention");
    expect(jackdaw.invention.options).toHaveLength(3);
    const cheapest = Math.min(...jackdaw.invention.options.map((o) => o.costPerRun));
    expect(jackdaw.invention.chosen!.costPerRun).toBe(cheapest);
    expect(jackdaw.request.me).toBe(2);
    expect(jackdaw.summary.blueprintCost).toBeCloseTo(cheapest * 20);
  });

  it("owned blueprint: no BPC cost, default ME", () => {
    const r = calculate({ typeId: 34828, runs: 20, blueprintSource: "owned", me: 4 });
    expect(r.summary.blueprintCost).toBe(0);
    expect(r.request.me).toBe(4);
  });

  it("names everything, Sotiyo for manufacturing and Tatara for reactions", () => {
    expect(jackdaw.product.name).toBe("Jackdaw");
    expect(jackdaw.facilities.manufacturing?.structureType).toBe("sotiyo");
    expect(jackdaw.facilities.reaction?.structureType).toBe("tatara");
    expect(jackdaw.shopping.every((l) => !l.name.startsWith("#"))).toBe(true);
  });

  it("warns that the default presets have no system (no cost index)", () => {
    expect(jackdaw.warnings.join(" ")).toMatch(/не указана система/);
  });

  it("decision overrides flow through", () => {
    const r = calculate({ typeId: 34828, runs: 20, decisions: { 30466: "buy" } });
    expect(r.nodes.find((n) => n.typeId === 30466)!.decision).toBe("buy");
  });

  it("price refresh list contains only market items", () => {
    const ids = priceTypesFor(34828);
    expect(ids).toContain(34828);
    expect(ids).toContain(34412); // relic
    expect(ids.length).toBeGreaterThan(50);
  });

  it("settings round-trip", () => {
    const s = data.saveSettings({ materialPriceMode: "buy" });
    expect(s.materialPriceMode).toBe("buy");
    expect(calculate({ typeId: 2185, runs: 10 }).request.materialPriceMode).toBe("buy");
    data.saveSettings({ materialPriceMode: "sell" });
  });

  it("profile with a system gets cost indices", () => {
    const p = data.listProfiles().find((x) => x.structureType === "sotiyo")!;
    data.upsertProfile({ ...p, solarSystemId: 30000144 });
    const r = calculate({ typeId: 2185, runs: 10 });
    expect(r.facilities.manufacturing?.costIndices.manufacturing).toBeGreaterThan(0);
    expect(r.facilities.costIndexSource).toBe("fixtures");
  });
});
