import { beforeAll, describe, expect, it } from "vitest";
import type { CharacterApi } from "@/server/characters";
import { EsiError } from "@/esi/client";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";
process.env.EVE_CLIENT_ID = "client123";
process.env.EVE_CLIENT_SECRET = "secret456";

let ch: typeof import("@/server/characters");
let sso: typeof import("@/esi/sso");
let secret: typeof import("@/server/secret");

beforeAll(async () => {
  ch = await import("@/server/characters");
  sso = await import("@/esi/sso");
  secret = await import("@/server/secret");
});

// SYNTHETIC ESI payloads in the documented shapes.
const NICK = 90000001;
const CORP = 98000001;
const api = (corpFails = false): CharacterApi => ({
  publicInfo: async () => ({ corporation_id: CORP, name: "Nick Industrialist" }),
  skills: async () => ({
    skills: [
      { skill_id: 3380, active_skill_level: 5, trained_skill_level: 5 }, // Industry
      { skill_id: 3388, active_skill_level: 4, trained_skill_level: 5 }, // Advanced Industry (alpha-capped)
    ],
  }),
  blueprints: async () => [
    { item_id: 1, type_id: 34829, location_id: 1, location_flag: "Hangar", quantity: -2, material_efficiency: 4, time_efficiency: 14, runs: 20 },
    { item_id: 2, type_id: 34829, location_id: 1, location_flag: "Hangar", quantity: -2, material_efficiency: 2, time_efficiency: 4, runs: 10 },
  ],
  jobs: async () => [
    { job_id: 7, installer_id: NICK, facility_id: 1, activity_id: 1, blueprint_type_id: 34829, product_type_id: 34828, runs: 20, status: "active", start_date: "2026-10-16T00:00:00Z", end_date: "2026-10-25T00:00:00Z" },
  ],
  corpBlueprints: async () => {
    if (corpFails) throw new EsiError(403, "x", "forbidden");
    return [{ item_id: 3, type_id: 11890, location_id: 2, location_flag: "CorpSAG1", quantity: 1, material_efficiency: 10, time_efficiency: 20, runs: -1 }];
  },
  corpJobs: async () => [],
});

describe("SSO helpers", () => {
  it("authorize URL carries client, callback, scopes and state", () => {
    const u = new URL(sso.authorizeUrl(sso.ssoConfig(), "abc"));
    expect(u.searchParams.get("client_id")).toBe("client123");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(u.searchParams.get("state")).toBe("abc");
    expect(u.searchParams.get("scope")).toContain("esi-characters.read_blueprints.v1");
  });

  it("missing credentials give a clear error", () => {
    expect(() => sso.ssoConfig({})).toThrow(/EVE_CLIENT_ID/);
  });

  it("character id from both sub formats", () => {
    expect(sso.identityFromClaims({ sub: "CHARACTER:EVE:123", name: "A" }).characterId).toBe(123);
    expect(sso.identityFromClaims({ sub: "EVE:CHARACTER:456", name: "B", scp: "x" }).scopes).toEqual(["x"]);
    expect(() => sso.identityFromClaims({ sub: "nope" })).toThrow();
  });

  it("token request uses Basic auth and form body", async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ access_token: "a", expires_in: 1199, token_type: "Bearer", refresh_token: "r" }));
    }) as unknown as typeof fetch;
    const t = await sso.exchangeCode(sso.ssoConfig(), "CODE", fake);
    expect(t.refresh_token).toBe("r");
    expect((seen!.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("client123:secret456").toString("base64")}`);
    expect(String(seen!.body)).toBe("grant_type=authorization_code&code=CODE");
  });
});

describe("token encryption", () => {
  it("round-trips and is not plain text", () => {
    const sealed = secret.encrypt("refresh-token-value");
    expect(sealed).not.toContain("refresh-token-value");
    expect(secret.decrypt(sealed)).toBe("refresh-token-value");
  });
});

describe("character sync (SYNTHETIC ESI)", () => {
  beforeAll(() => {
    ch.saveCharacter(
      { characterId: NICK, name: "Nick", scopes: [], expiresAt: 0 },
      { access_token: "tok", expires_in: 1200, token_type: "Bearer", refresh_token: "ref" },
      null,
    );
  });

  it("stores skills (active level), blueprints, jobs and corp blueprints", async () => {
    const r = await ch.syncCharacter(NICK, api(), async () => "tok");
    expect(r).toMatchObject({ skills: 2, blueprints: 2, corpBlueprints: 1, jobs: 1 });
    // Saved without the stage-3 scopes: only the "log in again for the wallet" note.
    expect(r.notes).toEqual([expect.stringMatching(/перезайди/)]);
    expect(ch.skillLevels(null).get(3388)).toBe(4);
    const c = ch.listCharacters()[0];
    expect(c).toMatchObject({ name: "Nick Industrialist", corporationId: CORP, blueprints: 2, jobs: 1 });
  });

  it("best owned blueprint: highest ME wins among BPCs; BPO flagged", () => {
    const idx = ch.ownedBlueprintIndex();
    expect(idx.get(34829)).toMatchObject({ me: 4, te: 14, isBpo: false, runs: 20, copies: 2 });
    expect(idx.get(11890)).toMatchObject({ isBpo: true, me: 10 });
  });

  it("missing Director role is a note, not a failure; corp data kept from before", async () => {
    const r = await ch.syncCharacter(NICK, api(true), async () => "tok");
    expect(r.notes.join(" ")).toMatch(/Director/);
    expect(ch.ownedBlueprintIndex().get(11890)).toBeDefined();
  });

  it("access token is refreshed when expired and a rotated refresh token is stored", async () => {
    const { getDb } = await import("@/server/data");
    const { characters } = await import("@/db/schema");
    getDb().update(characters).set({ accessExpiresAt: new Date(0).toISOString() }).run();
    let used = "";
    const t = await ch.accessToken(NICK, async (_cfg, refresh) => {
      used = refresh;
      return { access_token: "new", expires_in: 1200, token_type: "Bearer", refresh_token: "ref2" };
    });
    expect(t).toBe("new");
    expect(used).toBe("ref");
    let used2 = "";
    getDb().update(characters).set({ accessExpiresAt: new Date(0).toISOString() }).run();
    await ch.accessToken(NICK, async (_c, r) => ((used2 = r), { access_token: "n2", expires_in: 1, token_type: "B", refresh_token: "" }));
    expect(used2).toBe("ref2");
  });
});

describe("calculations use synced characters", () => {
  it("owned Jackdaw BPC: ME 4 / TE 14, no invention cost, character skills", async () => {
    const { calculate } = await import("@/server/calculate");
    const r = calculate({ typeId: 34828, runs: 20 });
    expect(r.request.blueprintSource).toBe("owned");
    expect(r.request.me).toBe(4);
    expect(r.request.te).toBe(14);
    expect(r.summary.blueprintCost).toBe(0);
    expect(r.ownedBlueprint).toMatchObject({ me: 4, runs: 20, isBpo: false });
    expect(r.skillsSource).toBe("characters");
  });

  it("setting: own BPC valued at the invention cost", async () => {
    const { calculate } = await import("@/server/calculate");
    const { saveSettings } = await import("@/server/data");
    saveSettings({ ownBpcValue: "invention" });
    const r = calculate({ typeId: 34828, runs: 20 });
    saveSettings({ ownBpcValue: "free" });
    const cheapest = Math.min(...r.invention.options.map((o) => o.costPerRun));
    expect(r.request.blueprintSource).toBe("owned");
    expect(r.summary.blueprintCost).toBeCloseTo(cheapest * 20);
  });

  it("owned BPO ME10 used for an intermediate (R.A.M. Starship Tech)", async () => {
    const { calculate } = await import("@/server/calculate");
    const r = calculate({ typeId: 34828, runs: 20, decisions: { 11478: "build" } });
    expect(r.jobs.find((j) => j.typeId === 11478)!.me).toBe(10);
  });

  it("explicit invention still possible", async () => {
    const { calculate } = await import("@/server/calculate");
    const r = calculate({ typeId: 34828, runs: 20, blueprintSource: "invention" });
    expect(r.request.blueprintSource).toBe("invention");
    expect(r.summary.blueprintCost).toBeGreaterThan(0);
  });
});
