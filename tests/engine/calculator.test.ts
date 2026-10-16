import { describe, expect, it } from "vitest";
import { calculateJob, type CalcInput } from "@/engine/calculator";
import { NPC_STATION } from "@/engine/facility";
import type { MarketQuote } from "@/engine/pricing";
import type { BlueprintActivity } from "@/engine/types";

// SYNTHETIC blueprint: 1 run → 100 units of type 500 from 1000×34 + 100×35.
const act: BlueprintActivity = {
  blueprintTypeId: 501,
  activity: "manufacturing",
  time: 600,
  materials: [
    { typeId: 34, quantity: 1000 },
    { typeId: 35, quantity: 100 },
  ],
  products: [{ typeId: 500, quantity: 100 }],
  skills: [],
};

const quotes: Record<number, MarketQuote> = {
  34: { typeId: 34, buyMax: 3, sellMin: 4 },
  35: { typeId: 35, buyMax: 15, sellMin: 17 },
  500: { typeId: 500, buyMax: 80, sellMin: 100 },
};

const base: CalcInput = {
  activity: act,
  runs: 2,
  me: 10,
  te: 20,
  facility: NPC_STATION,
  systemCostIndex: 0.05,
  quotes: (id) => quotes[id],
  adjustedPrice: (id) => ({ 34: 3.5, 35: 16 })[id],
  materialPriceMode: "sell",
  productPriceMode: "sell",
  fees: { salesTax: 0.04, brokerFee: 0.01 },
};

describe("calculateJob", () => {
  it("full breakdown, sell/sell", () => {
    const r = calculateJob(base);
    expect(r.outputUnits).toBe(200);
    expect(r.materials.map((m) => m.quantity)).toEqual([1800, 180]);
    expect(r.materialCost).toBeCloseTo(1800 * 4 + 180 * 17);
    const eiv = (1000 * 3.5 + 100 * 16) * 2;
    expect(r.job.eiv).toBeCloseTo(eiv);
    expect(r.job.total).toBeCloseTo(eiv * (0.05 + 0.0025 + 0.04));
    expect(r.grossRevenue).toBe(200 * 100);
    expect(r.saleFees).toBeCloseTo(20000 * 0.05);
    expect(r.profit).toBeCloseTo(20000 * 0.95 - r.totalCost);
    expect(r.warnings).toEqual([]);
  });

  it("buy-order materials add broker fee; selling into buy orders pays only tax", () => {
    const r = calculateJob({ ...base, materialPriceMode: "buy", productPriceMode: "buy" });
    expect(r.materialCost).toBeCloseTo((1800 * 3 + 180 * 15) * 1.01);
    expect(r.saleFees).toBeCloseTo(200 * 80 * 0.04);
  });

  it("missing prices produce warnings and null profit, not NaN", () => {
    const r = calculateJob({ ...base, quotes: () => undefined, adjustedPrice: () => undefined });
    expect(r.profit).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(Number.isNaN(r.totalCost)).toBe(false);
  });

  it("refuses a reaction in a Sotiyo", () => {
    expect(() =>
      calculateJob({
        ...base,
        activity: { ...act, activity: "reaction" },
        facility: { structure: "sotiyo", security: "null", rigs: [], facilityTax: 0 },
      }),
    ).toThrow(/cannot run reaction/);
  });
});
