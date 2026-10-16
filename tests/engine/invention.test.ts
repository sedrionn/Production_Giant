import { describe, expect, it } from "vitest";
import { inventionChance, inventionCost } from "@/engine/invention";
import { NPC_STATION } from "@/engine/facility";
import { loadFixtures } from "../fixtures/loadFixtures";

describe("inventionChance", () => {
  it("skills raise base chance", () => {
    expect(inventionChance(0.34, { encryption: 0, science1: 0, science2: 0 })).toBeCloseTo(0.34);
    expect(inventionChance(0.34, { encryption: 5, science1: 5, science2: 5 })).toBeCloseTo(0.34 * (1 + 5 / 40 + 10 / 30));
  });
  it("capped at 100%", () => {
    expect(inventionChance(0.9, { encryption: 5, science1: 5, science2: 5 }, 1.9)).toBe(1);
  });
});

describe("inventionCost on REAL data (Hammerhead II)", () => {
  const fx = loadFixtures();
  const t1 = fx.sde.getBlueprint(2184)!; // Hammerhead I Blueprint
  const t2 = fx.sde.getBlueprint(2186)!; // Hammerhead II Blueprint
  const base: Parameters<typeof inventionCost>[0] = {
    invention: t1.activities.invention!,
    targetBlueprintTypeId: 2186,
    targetManufacturing: t2.activities.manufacturing!,
    skills: { encryption: 4, science1: 4, science2: 4 },
    sourceItemCost: 0,
    quote: fx.quote,
    adjustedPrice: fx.adjustedPrice,
    materialPriceMode: "sell",
    fees: { salesTax: 0, brokerFee: 0 },
    facility: NPC_STATION,
    costIndex: 0.05,
  };
  const r = inventionCost(base);

  it("10 runs per success at 34% base", () => {
    expect(r.runsPerSuccess).toBe(10);
    expect(r.chance).toBeCloseTo(0.34 * (1 + 4 / 40 + 8 / 30));
  });

  it("cost per run = cost per attempt / chance / runs", () => {
    expect(r.missingPrices).toEqual([]);
    expect(r.costPerRun).toBeCloseTo(r.costPerAttempt / r.chance / 10);
    expect(r.materialsPerAttempt).toBeGreaterThan(0);
  });

  it("decryptor: chance ×mult, ME/TE/runs added, price per attempt", () => {
    // Process Decryptor, values from SDE typeDogma 34205 (attrs 1112/1113/1114/1124). Price is SYNTHETIC.
    const process = { typeId: 34205, name: "Process Decryptor", probabilityMultiplier: 1.1, me: 3, te: 6, runs: 0 };
    const quote = (id: number) => (id === 34205 ? { typeId: id, buyMax: null, sellMin: 1_000_000 } : fx.quote(id));
    const d = inventionCost({ ...base, quote, decryptor: process });
    expect(d.chance).toBeCloseTo(r.chance * 1.1);
    expect([d.me, d.te, d.runsPerSuccess]).toEqual([5, 10, 10]);
    expect(d.decryptorCost).toBe(1_000_000);
    expect(d.costPerAttempt).toBeCloseTo(r.costPerAttempt + 1_000_000);
    expect(d.costPerRun).toBeCloseTo(d.costPerAttempt / d.chance / 10);
  });

  it("rejects a wrong target", () => {
    const input = { invention: t1.activities.invention!, targetBlueprintTypeId: 1 } as Parameters<typeof inventionCost>[0];
    expect(() => inventionCost(input)).toThrow(/does not yield/);
  });
});
