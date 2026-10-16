import { describe, expect, it } from "vitest";
import { openAppDb } from "@/db/client";
import { seedDefaults } from "@/db/seed";
import { settings, structureProfiles } from "@/db/schema";

describe("app db", () => {
  it("migrates and seeds default presets idempotently", () => {
    const db = openAppDb(":memory:");
    seedDefaults(db);
    const profiles = db.select().from(structureProfiles).all();
    expect(profiles.map((p) => p.structureType)).toEqual(["sotiyo", "tatara", "npc_station"]);
    expect(profiles.filter((p) => p.isDefault)).toHaveLength(1);
    expect(profiles[0].rigs).toEqual([]);
    const s = Object.fromEntries(db.select().from(settings).all().map((r) => [r.key, r.value]));
    expect(s.materialPriceMode).toBe("sell");
  });
});
