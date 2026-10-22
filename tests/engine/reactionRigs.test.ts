import { describe, expect, it } from "vitest";
import { materialsForJob } from "@/engine/materials";
import { jobTime } from "@/engine/jobCost";
import { materialMultiplier, normalizeRigs, type FacilityProfile, type RigRule } from "@/engine/facility";
import { loadFixtures } from "../fixtures/loadFixtures";

/**
 * In-game check (2026-10-22, Nick): Tatara in Auner (lowsec), Standup L-Set Reactor Efficiency II,
 * Reactions IV. Vanadium Hafnite × 105 runs: industry window shows
 * "Skills −16%, Installed Rig −24%, Structure Role −25%", duration 6D 06:49:19, 10 248 of each moon goo.
 * The app used to apply the standard lowsec ×1.9 to the reactor rig → 10 022 and 4D 11:57.
 */
const VANADIUM_HAFNITE_FORMULA = 46183;
const HAFNIUM = 16648;
const VANADIUM = 16642;

const { subset } = loadFixtures();
const reaction = subset.blueprints.find((b) => b.blueprintTypeId === VANADIUM_HAFNITE_FORMULA)!.activities.reaction!;

const rig: RigRule = { name: "Standup L-Set Reactor Efficiency II", activity: "reaction", scopes: ["all"], material: 0.024, time: 0.24 };
const tatara = (r: RigRule): FacilityProfile => ({ structure: "tatara", security: "low", rigs: [r], facilityTax: 0 });

describe("reactor rigs use their own security multipliers", () => {
  it("lowsec ×1: materials match the game (10 248 per moon goo)", () => {
    const lines = materialsForJob(reaction.materials, 105, 0, materialMultiplier(tatara(rig), "reaction"));
    expect(lines.find((l) => l.typeId === HAFNIUM)!.quantity).toBe(10248);
    expect(lines.find((l) => l.typeId === VANADIUM)!.quantity).toBe(10248);
  });

  it("lowsec ×1: time matches the game (6D 06:49:19)", () => {
    const t = jobTime(reaction.time, 105, 0, "reaction", tatara(rig), { reactions: 4 });
    expect(Math.abs(t - (6 * 86400 + 6 * 3600 + 49 * 60 + 19))).toBeLessThan(60);
  });

  it("null/WH ×1.1", () => {
    const f: FacilityProfile = { ...tatara(rig), security: "null" };
    expect(materialMultiplier(f, "reaction")).toBeCloseTo(1 - 0.024 * 1.1);
  });

  it("old presets saved with standard ×1/×1.9/×2.1 on a reaction rig are corrected", () => {
    const [fixed] = normalizeRigs([{ ...rig, security: { high: 1, low: 1.9, null: 2.1 } }]);
    expect(materialMultiplier(tatara(fixed), "reaction")).toBeCloseTo(0.976);
  });

  it("an explicit non-standard multiplier is kept", () => {
    const [kept] = normalizeRigs([{ ...rig, security: { high: 0, low: 1.5, null: 1.1 } }]);
    expect(kept.security?.low).toBe(1.5);
  });

  it("manufacturing rigs keep the standard ×1.9 in lowsec", () => {
    const f: FacilityProfile = { structure: "sotiyo", security: "low", rigs: [{ activity: "manufacturing", scopes: ["all"], material: 0.02, time: 0.2 }], facilityTax: 0 };
    expect(materialMultiplier(f, "manufacturing")).toBeCloseTo(0.99 * (1 - 0.02 * 1.9));
  });
});
