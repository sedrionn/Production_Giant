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

describe("skillTimeMultiplier — per-skill bonus from SDE", () => {
  // Medium Core Defense Field Extender II requires Hydromagnetic Physics (11443), Quantum Physics (11455)
  // and Shield Rigging (26261). SDE dogma attr 1982 = −1 on the two science skills only.
  const required = [{ typeId: 11443, level: 1 }, { typeId: 11455, level: 1 }, { typeId: 26261, level: 1 }];
  const base = { industry: 5, advancedIndustry: 5, blueprintSkills: 5 };
  it("only skills with a time bonus count (EVE Guru: 03:13:19 on the T2 rig)", () => {
    const m = skillTimeMultiplier("manufacturing", { ...base, timeBonusPerLevel: { 11443: 0.01, 11455: 0.01 } }, required);
    expect(m).toBeCloseTo(0.8 * 0.85 * 0.95 * 0.95);
  });
  it("without SDE data falls back to 1% for every required skill", () => {
    expect(skillTimeMultiplier("manufacturing", base, required)).toBeCloseTo(0.8 * 0.85 * 0.95 ** 3);
  });
});

describe("science job time", () => {
  it("invention: Advanced Industry only; copying: also Science 5%/lvl", () => {
    expect(skillTimeMultiplier("invention", { advancedIndustry: 5, levels: { 3402: 5 } })).toBeCloseTo(0.85);
    expect(skillTimeMultiplier("copying", { advancedIndustry: 5, levels: { 3402: 5 } })).toBeCloseTo(0.85 * 0.75);
    expect(skillTimeMultiplier("copying", { advancedIndustry: 0, blueprintSkills: 4 })).toBeCloseTo(0.8);
  });
});
