import { describe, expect, it } from "vitest";
import { FixtureSdeSource } from "@/sde/fixtureSource";
import { listCategory } from "@/server/catalog";
import type { SdeType } from "@/sde/types";
import type { Blueprint } from "@/engine/types";

// SYNTHETIC mini SDE: one blueprint per product, group names like the real ones.
const t = (typeId: number, name: string, groupId: number, categoryId: number, metaGroupId: number | null, raceId: number | null = null): SdeType => ({
  typeId, name, groupId, categoryId, metaGroupId, raceId, portionSize: 1, volume: 1, published: true, marketGroupId: 1,
});
const types: SdeType[] = [
  t(1, "Caracal", 26, 6, null, 1),
  t(2, "Cerberus", 358, 6, 2, 1),
  t(3, "Rupture", 26, 6, null, 2),
  t(4, "Tengu", 963, 6, 14, 1),
  t(5, "Tengu Defensive - Covert Reconfiguration", 954, 32, 14, 1),
  t(6, "Medium Core Defense Field Extender I", 774, 7, null),
  t(7, "Medium Core Defense Field Extender II", 774, 7, 2),
  t(8, "Fulleroferrocene", 974, 4, null),
  t(9, "Heavy Missile Launcher II", 510, 7, 2),
];
const groups = [
  { groupId: 26, categoryId: 6, name: "Cruiser" },
  { groupId: 774, categoryId: 7, name: "Rig Shield" },
  { groupId: 510, categoryId: 7, name: "Missile Launcher Heavy" },
];
const blueprints: Blueprint[] = types.map((x) => ({
  blueprintTypeId: 1000 + x.typeId,
  maxProductionLimit: 10,
  activities: {
    [x.typeId === 8 ? "reaction" : "manufacturing"]: {
      blueprintTypeId: 1000 + x.typeId,
      activity: x.typeId === 8 ? "reaction" : "manufacturing",
      time: 60,
      materials: [],
      products: [{ typeId: x.typeId, quantity: 1 }],
      skills: [],
    },
  },
}));
const sde = new FixtureSdeSource({ meta: { source: "test", capturedAt: "", roots: [] }, types, blueprints, groups });
const names = (k: Parameters<typeof listCategory>[1]) => listCategory(sde, k).map((x) => x.name);

describe("overview categories", () => {
  it("Caldari T1 / T2 ships only", () => {
    expect(names("caldari_t1")).toEqual(["Caracal"]);
    expect(names("caldari_t2")).toEqual(["Cerberus"]);
  });
  it("T3 = T3 hulls + subsystems of any race", () => {
    expect(names("t3")).toEqual(["Tengu", "Tengu Defensive - Covert Reconfiguration"]);
  });
  it("rigs by group name, split by tech level", () => {
    expect(names("rigs_t1")).toEqual(["Medium Core Defense Field Extender I"]);
    expect(names("rigs_t2")).toEqual(["Medium Core Defense Field Extender II"]);
  });
  it("reactions = reaction products", () => {
    expect(names("reactions")).toEqual(["Fulleroferrocene"]);
  });
});
