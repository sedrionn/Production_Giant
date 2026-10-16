import { describe, expect, it } from "vitest";
import { materialQuantity, materialsForJob, outputQuantity, runsNeeded } from "@/engine/materials";
import { materialMultiplier, normalizeRigs, NPC_STATION, type FacilityProfile } from "@/engine/facility";

describe("materialQuantity", () => {
  it("ME 0 is base × runs", () => {
    expect(materialQuantity(10, 5, 0)).toBe(50);
  });

  it("ME 10 reduces by 10% and rounds up", () => {
    expect(materialQuantity(10, 1, 10)).toBe(9);
    expect(materialQuantity(15, 1, 10)).toBe(14); // 13.5 → 14
  });

  it("never drops below 1 per run", () => {
    expect(materialQuantity(1, 1, 10)).toBe(1);
    expect(materialQuantity(1, 50, 10, 0.95)).toBe(50);
  });

  it("rounds to 2 decimals before ceil (51.0048 → 51, not 52)", () => {
    expect(materialQuantity(8, 7, 8, 0.99)).toBe(51);
  });

  it("rejects bad input", () => {
    expect(() => materialQuantity(10, 0, 0)).toThrow();
    expect(() => materialQuantity(10, 1.5, 0)).toThrow();
    expect(() => materialQuantity(10, 1, -1)).toThrow();
    expect(materialQuantity(100, 1, 15)).toBe(85); // special BPC above ME 10 ('Whiskey' Shield Amplifier, ME 15)
  });
});

/**
 * GOLDEN — old Google Sheet, Jackdaw (34828), 20 runs, ME 4, no structure bonus.
 * Base quantities here are SYNTHETIC (back-derived from the sheet's output);
 * real ones come from fixtures/sde once fixtures:capture has run.
 */
describe("golden: Jackdaw 20 runs ME4 (old sheet)", () => {
  const synthetic = [
    { typeId: 30466, quantity: 2, expected: 39 },
    { typeId: 30002, quantity: 2, expected: 39 },
    { typeId: 30476, quantity: 2, expected: 39 },
    { typeId: 30464, quantity: 8, expected: 154 },
    { typeId: 29992, quantity: 2, expected: 39 },
    { typeId: 30478, quantity: 2, expected: 39 },
    { typeId: 34396, quantity: 3, expected: 58 },
    { typeId: 29994, quantity: 2, expected: 39 },
    { typeId: 11478, quantity: 10, expected: 192 },
  ];
  const mult = materialMultiplier(NPC_STATION, "manufacturing");

  it.each(synthetic)("type $typeId → $expected", ({ quantity, expected }) => {
    expect(materialQuantity(quantity, 20, 4, mult)).toBe(expected);
  });

  it("materialsForJob maps the whole list", () => {
    const lines = materialsForJob(synthetic, 20, 4, mult);
    expect(lines.map((l) => l.quantity)).toEqual(synthetic.map((s) => s.expected));
  });
});

describe("facility multipliers", () => {
  const sotiyoNull: FacilityProfile = {
    structure: "sotiyo",
    security: "null",
    rigs: [{ activity: "manufacturing", scopes: ["all"], material: 0.024, time: 0.24 }],
    facilityTax: 0.01,
  };

  it("Sotiyo role bonus only, no rigs", () => {
    const f: FacilityProfile = { ...sotiyoNull, rigs: [] };
    expect(materialMultiplier(f, "manufacturing")).toBeCloseTo(0.99, 10);
  });

  it("T2 rig in null multiplies by 2.1", () => {
    expect(materialMultiplier(sotiyoNull, "manufacturing")).toBeCloseTo(0.99 * (1 - 0.024 * 2.1), 10);
  });

  it("scoped rigs: ship rig hits ships only, component rig hits components only", () => {
    const auner: FacilityProfile = {
      structure: "sotiyo",
      security: "low",
      rigs: [
        { name: "XL Ship ME I", activity: "manufacturing", scopes: ["ships"], material: 0.02, time: 0.2 },
        { name: "XL Thukker Structure & Component", activity: "manufacturing", scopes: ["components", "structures"], material: 0.03, time: 0.2 },
      ],
      facilityTax: 0.01,
    };
    const ship = { categoryId: 6, groupId: 1305 };
    const component = { categoryId: 17, groupId: 964 };
    const drone = { categoryId: 18, groupId: 100 };
    expect(materialMultiplier(auner, "manufacturing", ship)).toBeCloseTo(0.99 * (1 - 0.02 * 1.9), 10);
    expect(materialMultiplier(auner, "manufacturing", component)).toBeCloseTo(0.99 * (1 - 0.03 * 1.9), 10);
    expect(materialMultiplier(auner, "manufacturing", drone)).toBeCloseTo(0.99, 10);
    expect(materialMultiplier(auner, "manufacturing")).toBeCloseTo(0.99, 10); // unknown item: only "all" rigs
  });

  it("stage-1 preset format converts to rules", () => {
    expect(normalizeRigs({ manufacturing: { material: "t2", time: "none" }, reaction: { material: "none", time: "none" } })).toEqual([
      { activity: "manufacturing", scopes: ["all"], material: 0.024, time: 0 },
    ]);
    expect(normalizeRigs([])).toEqual([]);
    expect(normalizeRigs(null)).toEqual([]);
  });

  it("role material bonus does not apply to reactions", () => {
    const tatara: FacilityProfile = { structure: "tatara", security: "low", rigs: [], facilityTax: 0 };
    expect(materialMultiplier(tatara, "reaction")).toBe(1);
  });
});

describe("portion size (old sheet bug #1)", () => {
  const ram = { typeId: 11478, quantity: 100 };

  it("192 R.A.M. needs 2 runs, not 192", () => {
    expect(runsNeeded(ram, 192)).toBe(2);
  });

  it("2 runs give 200 units", () => {
    expect(outputQuantity(ram, 2)).toBe(200);
  });

  it("exact multiples and zero", () => {
    expect(runsNeeded(ram, 200)).toBe(2);
    expect(runsNeeded(ram, 0)).toBe(0);
  });
});
