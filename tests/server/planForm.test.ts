import { describe, expect, it } from "vitest";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

describe("plan form", () => {
  it("an old form (pins in batches, any horizon) becomes units and a 7-day plan; stored and read back", async () => {
    const f = await import("@/server/planForm");
    const form = f.parsePlanForm({ budget: 5e9, horizonDays: 14, pins: [{ typeId: 2185, name: "Hammerhead II", batches: 3 }, { typeId: 0 }] });
    expect(form.pins).toEqual([{ typeId: 2185, name: "Hammerhead II", units: 3, decryptor: "auto", source: "auto" }]);
    expect(form.categories).toContain("warp_disruptors");
    expect(f.planRequestOf(form).horizonDays).toBe(7);
    expect(f.planRequestOf(f.parsePlanForm({ pins: [{ typeId: 1, units: 250, decryptor: 34201, source: "invention" }] })).pins).toEqual([{ typeId: 1, units: 250, decryptor: 34201, source: "invention" }]);
    expect(f.storedPlanForm()).toBeNull();
    f.storePlanForm(form);
    expect(f.storedPlanForm()).toEqual(form);
  });
});
