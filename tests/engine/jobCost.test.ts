import { describe, expect, it } from "vitest";
import { estimatedItemValue, jobInstallCost, jobTime, skillTimeMultiplier } from "@/engine/jobCost";
import { NPC_STATION, type FacilityProfile } from "@/engine/facility";
import { SCC_SURCHARGE } from "@/engine/bonuses";

const mats = [
  { typeId: 34, quantity: 1000 },
  { typeId: 35, quantity: 200 },
];
const adjusted = (id: number) => ({ 34: 4, 35: 10 })[id];

describe("estimatedItemValue", () => {
  it("uses base quantities × runs", () => {
    expect(estimatedItemValue(mats, 3, adjusted).eiv).toBe((1000 * 4 + 200 * 10) * 3);
  });

  it("reports missing adjusted prices", () => {
    const r = estimatedItemValue([...mats, { typeId: 99, quantity: 1 }], 1, adjusted);
    expect(r.missing).toEqual([99]);
    expect(r.eiv).toBe(6000);
  });
});

describe("jobInstallCost", () => {
  it("NPC station: EIV × index + tax + SCC", () => {
    const c = jobInstallCost(1_000_000, "manufacturing", 0.05, NPC_STATION);
    expect(c.grossCost).toBeCloseTo(50_000);
    expect(c.facilityTax).toBeCloseTo(2_500);
    expect(c.sccSurcharge).toBeCloseTo(1_000_000 * SCC_SURCHARGE);
    expect(c.total).toBeCloseTo(c.grossCost + c.facilityTax + c.sccSurcharge);
  });

  it("Sotiyo job bonus reduces only the gross part", () => {
    const sotiyo: FacilityProfile = { structure: "sotiyo", security: "null", rigs: [], facilityTax: 0 };
    const c = jobInstallCost(1_000_000, "manufacturing", 0.1, sotiyo);
    expect(c.grossCost).toBeCloseTo(100_000 * 0.95);
    expect(c.facilityTax).toBe(0);
  });

  it("invention uses 2% of EIV as base", () => {
    const c = jobInstallCost(1_000_000, "invention", 0.1, NPC_STATION);
    expect(c.grossCost).toBeCloseTo(1_000_000 * 0.02 * 0.1);
  });
});

describe("ME does not change job cost", () => {
  it("EIV is independent of ME (computed from base quantities)", () => {
    // estimatedItemValue has no ME parameter by design; this test guards the signature.
    expect(estimatedItemValue.length).toBe(3);
  });
});

describe("jobTime", () => {
  it("TE and skills", () => {
    const t = jobTime(3600, 10, 20, "manufacturing", NPC_STATION, { industry: 5, advancedIndustry: 5 });
    expect(t).toBeCloseTo(3600 * 10 * 0.8 * 0.8 * 0.85);
  });

  it("Sotiyo + T1 time rig in high-sec", () => {
    const f: FacilityProfile = {
      structure: "sotiyo",
      security: "high",
      rigs: [{ activity: "manufacturing", scopes: ["all"], material: 0, time: 0.2 }],
      facilityTax: 0,
    };
    expect(jobTime(1000, 1, 0, "manufacturing", f)).toBeCloseTo(1000 * 0.7 * 0.8);
  });

  it("TE is ignored for reactions; reactions skill applies", () => {
    expect(skillTimeMultiplier("reaction", { reactions: 5 })).toBeCloseTo(0.8);
    const tatara: FacilityProfile = { structure: "tatara", security: "low", rigs: [], facilityTax: 0 };
    expect(jobTime(1000, 1, 20, "reaction", tatara)).toBeCloseTo(750);
  });
});

describe("system job bonus (e.g. Faction Warfare)", () => {
  it("halves only the cost-index part, taxes untouched", () => {
    const f: FacilityProfile = { structure: "sotiyo", security: "low", rigs: [], facilityTax: 0.01, systemJobBonus: 0.5 };
    const c = jobInstallCost(1_000_000, "manufacturing", 0.1, f);
    expect(c.grossCost).toBeCloseTo(100_000 * 0.95 * 0.5);
    expect(c.facilityTax).toBeCloseTo(10_000);
    expect(c.sccSurcharge).toBeCloseTo(1_000_000 * SCC_SURCHARGE);
  });
});
