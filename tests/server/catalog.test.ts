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
  t(10, "Graviton Reactor Unit", 334, 17, null, 1),
  t(11, "Exigent Sentry Drone Firepower Mutaplasmid", 1964, 17, null),
];
const groups = [
  { groupId: 26, categoryId: 6, name: "Cruiser" },
  { groupId: 774, categoryId: 7, name: "Rig Shield" },
  { groupId: 510, categoryId: 7, name: "Missile Launcher Heavy" },
  { groupId: 334, categoryId: 17, name: "Construction Components" },
];
const blueprints: Blueprint[] = types.map((x) => ({
  blueprintTypeId: 1000 + x.typeId,
  maxProductionLimit: 10,
  activities: {
    [x.typeId === 8 ? "reaction" : "manufacturing"]: {
      blueprintTypeId: 1000 + x.typeId,
      activity: x.typeId === 8 ? "reaction" : "manufacturing",
      time: 60,
      // Caracal is built from the Graviton Reactor Unit; nothing uses the mutaplasmid.
      materials: x.typeId === 1 ? [{ typeId: 10, quantity: 1 }] : [],
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
  it("components tab holds intermediates; ship tabs never do", () => {
    expect(names("components")).toEqual(["Graviton Reactor Unit"]);
    expect(names("caldari_t1")).not.toContain("Graviton Reactor Unit");
  });
  it("«Прочие»: commodities that no empire ship needs", () => {
    expect(names("other")).toEqual(["Exigent Sentry Drone Firepower Mutaplasmid"]);
  });

  it("my blueprints show end products only", () => {
    expect(listCategory(sde, "mine", [1001, 1010]).map((x) => x.name)).toEqual(["Caracal"]);
  });

  it("reactions = reaction products", () => {
    expect(names("reactions")).toEqual(["Fulleroferrocene"]);
  });
});

describe("blacklist", () => {
  it("boosters by group, Triglavian and EDENCOM by race, single items by id", async () => {
    const { blacklistReason, RACE_TRIGLAVIAN, RACE_EDENCOM } = await import("@/server/catalog");
    // SYNTHETIC types and groups.
    const g = [
      { groupId: 303, categoryId: 20, name: "Booster" },
      { groupId: 4060, categoryId: 7, name: "Vorton Projector" },
      { groupId: 1986, categoryId: 7, name: "Precursor Weapon" },
    ];
    const ts = [t(20, "Synth Crash Booster", 303, 20, null), t(21, "Small Vorton Projector I", 4060, 7, 1, 1), t(22, "Light Entropic Disintegrator I", 1986, 7, 1, RACE_TRIGLAVIAN), t(23, "Thunderchild", 26, 6, null, RACE_EDENCOM)];
    const s = new FixtureSdeSource({ meta: { source: "test", capturedAt: "", roots: [] }, types: [...types, ...ts], blueprints, groups: [...groups, ...g] });
    const all = { boosters: true, triglavian: true, edencom: true, typeIds: [1] };
    const reason = (id: number, bl = all) => blacklistReason(s, s.getType(id)!, bl);
    expect([20, 21, 22, 23].map((id) => reason(id))).toEqual(["бустеры", "EDENCOM", "триглавское", "EDENCOM"]);
    expect(reason(1)).toBe("в блэклисте");
    expect(reason(2)).toBeNull();
    expect(reason(20, { ...all, boosters: false })).toBeNull();
  });
});

describe("capitals and the Caldari branch extras (SYNTHETIC types)", () => {
  it("freighters and jump freighters are capitals; a battleship is not", async () => {
    const { isCapital, isCaldariBranchShip } = await import("@/server/catalog");
    const groups: Record<number, string> = { 513: "Freighter", 902: "Jump Freighter", 27: "Battleship" };
    const sde = { getGroup: (id: number) => ({ groupId: id, name: groups[id], categoryId: 6 }) } as unknown as import("@/sde/types").SdeSource;
    const ship = (name: string, groupId: number, raceId: number) => ({ typeId: 1, name, groupId, categoryId: 6, raceId }) as unknown as import("@/sde/types").SdeType;
    expect(isCapital(sde, ship("Obelisk", 513, 8))).toBe(true);
    expect(isCapital(sde, ship("Anshar", 902, 8))).toBe(true);
    expect(isCapital(sde, ship("Raven", 27, 1))).toBe(false);
    expect(isCaldariBranchShip(ship("Obelisk", 513, 8))).toBe(true);
    expect(isCaldariBranchShip(ship("Megathron", 27, 8))).toBe(false);
    expect(isCaldariBranchShip(ship("Raven", 27, 1))).toBe(true);
  });
});
