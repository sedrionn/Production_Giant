import { describe, expect, it } from "vitest";
import { collectTree } from "@/sde/collect";
import { FixtureSdeSource } from "@/sde/fixtureSource";
import type { Blueprint } from "@/engine/types";
import type { SdeType } from "@/sde/types";

// SYNTHETIC tree:
//   T2 item 200 ← BPC 201 (manufacturing: 100×T1 item 100? no — 2×component 300 + 50×mineral 34)
//   component 300 ← BP 301 (manufacturing: 10×moon product 400)
//   moon product 400 ← reaction formula 401 (reaction: 100×raw 34, 100×raw 35)
//   BPC 201 ← invented from T1 BP 101 (invention: 8×datacore 900)
const bp = (id: number, acts: Blueprint["activities"]): Blueprint => ({ blueprintTypeId: id, maxProductionLimit: 10, activities: acts });
const act = (bpId: number, activity: "manufacturing" | "reaction" | "invention", mats: [number, number][], prods: [number, number][]) => ({
  blueprintTypeId: bpId,
  activity,
  time: 60,
  materials: mats.map(([typeId, quantity]) => ({ typeId, quantity })),
  products: prods.map(([typeId, quantity]) => ({ typeId, quantity })),
  skills: [],
});

const blueprints: Blueprint[] = [
  bp(201, { manufacturing: act(201, "manufacturing", [[300, 2], [34, 50]], [[200, 1]]) }),
  bp(301, { manufacturing: act(301, "manufacturing", [[400, 10]], [[300, 1]]) }),
  bp(401, { reaction: act(401, "reaction", [[34, 100], [35, 100]], [[400, 200]]) }),
  bp(101, {
    manufacturing: act(101, "manufacturing", [[34, 1000]], [[100, 1]]),
    invention: act(101, "invention", [[900, 8]], [[201, 10]]),
  }),
];
const types: SdeType[] = [];

const sde = new FixtureSdeSource({ meta: { source: "test", capturedAt: "", roots: [] }, types, blueprints });

describe("collectTree", () => {
  const tree = collectTree(sde, [200]);

  it("walks manufacturing → manufacturing → reaction", () => {
    expect([...tree.blueprintIds].sort()).toEqual([101, 201, 301, 401]);
  });

  it("leaves are raw materials only", () => {
    expect([...tree.leafTypeIds].sort()).toEqual([34, 35]);
  });

  it("includes invention inputs as types", () => {
    expect(tree.typeIds.has(900)).toBe(true);
  });

  it("can skip invention", () => {
    const t = collectTree(sde, [200], { invention: false });
    expect(t.blueprintIds.has(101)).toBe(false);
    expect(t.typeIds.has(900)).toBe(false);
  });

  it("does not loop on cycles", () => {
    const cyc = new FixtureSdeSource({
      meta: { source: "test", capturedAt: "", roots: [] },
      types: [],
      blueprints: [
        bp(1, { manufacturing: act(1, "manufacturing", [[20, 1]], [[10, 1]]) }),
        bp(2, { manufacturing: act(2, "manufacturing", [[10, 1]], [[20, 1]]) }),
      ],
    });
    expect(collectTree(cyc, [10]).blueprintIds.size).toBe(2);
  });
});
