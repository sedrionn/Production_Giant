/**
 * GOLDEN tests on REAL data (fixtures/, SDE build in subset.meta.build).
 * Expected numbers come from Nick's old Google Sheet where it was correct.
 */
import { describe, expect, it } from "vitest";
import { loadFixtures } from "./loadFixtures";
import { materialsForJob, runsNeeded } from "@/engine/materials";
import { materialMultiplier, NPC_STATION } from "@/engine/facility";

const fx = loadFixtures();
const JACKDAW = 34828;
const RAM = 11478;

function producer(typeId: number) {
  const ref = fx.sde.findProducers(typeId, "manufacturing")[0];
  return fx.sde.getBlueprint(ref.blueprintTypeId)!.activities.manufacturing!;
}

describe("old sheet: Jackdaw 20 runs, ME 4, no structure bonus", () => {
  const expected: Record<number, number> = {
    30466: 39, 30002: 39, 30476: 39, 30464: 154, 29992: 39, 30478: 39, 34396: 58, 29994: 39, 11478: 192,
  };

  it("matches the sheet for every material", () => {
    const lines = materialsForJob(producer(JACKDAW).materials, 20, 4, materialMultiplier(NPC_STATION, "manufacturing"));
    expect(Object.fromEntries(lines.map((l) => [l.typeId, l.quantity]))).toEqual(expected);
  });
});

describe("old sheet bug #1 on real data: R.A.M.", () => {
  it("one run makes 100 units", () => {
    expect(producer(RAM).products[0].quantity).toBe(100);
  });

  it("192 R.A.M. = 2 runs, needing ~1 112 Tritanium, not 85 402", () => {
    const act = producer(RAM);
    expect(runsNeeded(act.products[0], 192)).toBe(2);
    const trit = materialsForJob(act.materials, 2, 10).find((m) => m.typeId === 34)!;
    expect(trit.quantity).toBeLessThan(1200);
  });
});
