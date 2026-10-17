import { beforeAll, describe, expect, it } from "vitest";
import type { AssetApi, EsiAsset } from "@/server/assets";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";

let assets: typeof import("@/server/assets");
let ch: typeof import("@/server/characters");
let data: typeof import("@/server/data");

// SYNTHETIC ESI asset payloads in the documented shape.
const NICK = 90000011;
const CORP = 98000011;
const SOTIYO = 1_035_000_000_001; // structure: Nick's jobs run here
const JITA = 60003760;
const a = (item_id: number, type_id: number, quantity: number, location_id: number, location_flag = "Hangar", extra: Partial<EsiAsset> = {}): EsiAsset => ({
  item_id,
  type_id,
  quantity,
  location_id,
  location_flag,
  location_type: location_id === JITA ? "station" : "item",
  is_singleton: false,
  ...extra,
});
const fake: AssetApi = {
  character: async () => [
    a(1, 34, 5000, SOTIYO), // Tritanium in the Sotiyo hangar
    a(2, 3293, 1, SOTIYO, "Hangar", { is_singleton: true }), // a container
    a(3, 35, 700, 2, "Unlocked"), // Pyerite inside the container
    a(4, 34, 999, JITA), // Tritanium in Jita: not stock by default
    a(5, 34828, 1, SOTIYO, "Hangar", { is_singleton: true }), // assembled ship
    a(6, 36, 50, 5, "Cargo"), // Mexallon in its cargo: counts
    a(7, 2048, 1, 5, "LoSlot0", { is_singleton: true }), // fitted module: not stock
  ],
  corporation: async () => [
    a(100, 27, 1, SOTIYO, "OfficeFolder", { is_singleton: true }), // office
    a(101, 34, 1000, 100, "CorpSAG2"),
  ],
  stationName: async () => "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
};

beforeAll(async () => {
  assets = await import("@/server/assets");
  ch = await import("@/server/characters");
  data = await import("@/server/data");
  ch.saveCharacter(
    { characterId: NICK, name: "Nick", scopes: [assets.ASSET_SCOPES.character, assets.ASSET_SCOPES.corporation], expiresAt: 0 },
    { access_token: "tok", expires_in: 1200, token_type: "Bearer", refresh_token: "ref" },
    CORP,
  );
  const { industryJobs } = await import("@/db/schema");
  data.getDb()
    .insert(industryJobs)
    .values({ jobId: 1, ownerType: "character", installerId: NICK, viaCharacterId: NICK, activityId: 1, blueprintTypeId: 1, productTypeId: 2, runs: 1, status: "active", facilityId: SOTIYO, startDate: "2026-10-16T00:00:00Z", endDate: "2026-10-20T00:00:00Z" })
    .run();
});

describe("assets → stock (SYNTHETIC ESI)", () => {
  it("stock = hangars where your jobs run, through containers and corp offices; no ships or fitted modules", async () => {
    const r = await assets.syncAssets(NICK, CORP, "tok", fake);
    expect(r).toMatchObject({ character: 7, corporation: 2, notes: [] });
    const { stock } = assets.stockIndex();
    expect(stock.get(34)).toBe(6000);
    expect(stock.get(35)).toBe(700);
    expect(stock.get(36)).toBe(50);
    expect(stock.has(34828)).toBe(false);
    expect(stock.has(2048)).toBe(false);
  });

  it("locations: the job structure is selected by default, Jita gets its name and can be added", () => {
    const locs = assets.stockLocations();
    expect(locs[0]).toMatchObject({ locationId: SOTIYO, jobsHere: true, selected: true });
    expect(locs.find((l) => l.locationId === JITA)).toMatchObject({ name: expect.stringContaining("Jita"), selected: false });
    data.saveSettings({ stockLocationIds: [SOTIYO, JITA] });
    expect(assets.stockIndex().stock.get(34)).toBe(6999);
  });

  it("a 403 on corp assets is a note and keeps the old corp rows", async () => {
    const { EsiError } = await import("@/esi/client");
    const r = await assets.syncAssets(NICK, CORP, "tok", { ...fake, corporation: async () => Promise.reject(new EsiError(403, "x", "no")) });
    expect(r.notes.join(" ")).toMatch(/Director/);
    expect(assets.stockIndex().stock.get(34)).toBe(6999);
  });
});
