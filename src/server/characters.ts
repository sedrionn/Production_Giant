/** Characters: SSO tokens, sync from ESI (skills, blueprints, jobs), and lookups for calculations. */
import { and, eq, inArray } from "drizzle-orm";
import { characters, characterSkills, industryJobs, ownedBlueprints } from "@/db/schema";
import { EsiError, esiGet, esiGetAllPages } from "@/esi/client";
import { refreshToken as ssoRefresh, ssoConfig, verifyAccessToken, type CharacterIdentity, type TokenResponse } from "@/esi/sso";
import { getDb } from "./data";
import { decrypt, encrypt } from "./secret";

// ---- ESI shapes (subset) ---------------------------------------------------

export interface EsiSkills {
  skills: { skill_id: number; active_skill_level: number; trained_skill_level: number }[];
}
export interface EsiBlueprint {
  item_id: number;
  type_id: number;
  location_id: number;
  location_flag: string;
  quantity: number;
  material_efficiency: number;
  time_efficiency: number;
  runs: number;
}
export interface EsiJob {
  job_id: number;
  installer_id: number;
  facility_id: number;
  activity_id: number;
  blueprint_type_id: number;
  product_type_id?: number;
  runs: number;
  status: string;
  start_date: string;
  end_date: string;
}

/** Injectable for tests; default talks to ESI. */
export interface CharacterApi {
  publicInfo(id: number): Promise<{ corporation_id: number; name?: string }>;
  skills(id: number, token: string): Promise<EsiSkills>;
  blueprints(id: number, token: string): Promise<EsiBlueprint[]>;
  jobs(id: number, token: string): Promise<EsiJob[]>;
  corpBlueprints(corpId: number, token: string): Promise<EsiBlueprint[]>;
  corpJobs(corpId: number, token: string): Promise<EsiJob[]>;
}

export const esiCharacterApi: CharacterApi = {
  publicInfo: (id) => esiGet(`/characters/${id}/`),
  skills: (id, t) => esiGet(`/characters/${id}/skills/`, {}, t),
  blueprints: (id, t) => esiGetAllPages(`/characters/${id}/blueprints/`, {}, t),
  jobs: (id, t) => esiGet(`/characters/${id}/industry/jobs/`, {}, t),
  corpBlueprints: (corp, t) => esiGetAllPages(`/corporations/${corp}/blueprints/`, {}, t),
  corpJobs: (corp, t) => esiGetAllPages(`/corporations/${corp}/industry/jobs/`, {}, t),
};

// ---- tokens ---------------------------------------------------------------

export function saveCharacter(id: CharacterIdentity, tokens: TokenResponse, corporationId: number | null): void {
  const db = getDb();
  const values = {
    name: id.name,
    corporationId,
    scopes: id.scopes,
    refreshToken: encrypt(tokens.refresh_token),
    accessToken: tokens.access_token,
    accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
  db.insert(characters)
    .values({ characterId: id.characterId, ...values })
    .onConflictDoUpdate({ target: characters.characterId, set: values })
    .run();
  forgetCharacterLookups();
}

/** Valid access token, refreshed when it expires within a minute. */
export async function accessToken(characterId: number, refresh: typeof ssoRefresh = ssoRefresh): Promise<string> {
  const db = getDb();
  const c = db.select().from(characters).where(eq(characters.characterId, characterId)).get();
  if (!c) throw new Error(`Персонаж ${characterId} не найден`);
  if (c.accessToken && c.accessExpiresAt && Date.parse(c.accessExpiresAt) - Date.now() > 60_000) return c.accessToken;
  const t = await refresh(ssoConfig(), decrypt(c.refreshToken));
  db.update(characters)
    .set({
      accessToken: t.access_token,
      accessExpiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      // EVE may rotate the refresh token.
      ...(t.refresh_token ? { refreshToken: encrypt(t.refresh_token) } : {}),
    })
    .where(eq(characters.characterId, characterId))
    .run();
  return t.access_token;
}

export async function addCharacterFromTokens(tokens: TokenResponse, api: CharacterApi = esiCharacterApi): Promise<CharacterIdentity> {
  const id = await verifyAccessToken(ssoConfig(), tokens.access_token);
  const info = await api.publicInfo(id.characterId).catch(() => null);
  saveCharacter(id, tokens, info?.corporation_id ?? null);
  return id;
}

export function listCharacters() {
  const db = getDb();
  return db
    .select({
      characterId: characters.characterId,
      name: characters.name,
      corporationId: characters.corporationId,
      scopes: characters.scopes,
      lastSyncAt: characters.lastSyncAt,
      lastSyncNotes: characters.lastSyncNotes,
    })
    .from(characters)
    .all()
    .map((c) => ({
      ...c,
      skills: db.select().from(characterSkills).where(eq(characterSkills.characterId, c.characterId)).all().length,
      blueprints: db
        .select()
        .from(ownedBlueprints)
        .where(and(eq(ownedBlueprints.ownerType, "character"), eq(ownedBlueprints.ownerId, c.characterId)))
        .all().length,
      jobs: db.select().from(industryJobs).where(eq(industryJobs.installerId, c.characterId)).all().length,
    }));
}

export function removeCharacter(characterId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(characterSkills).where(eq(characterSkills.characterId, characterId)).run();
    tx.delete(ownedBlueprints).where(eq(ownedBlueprints.viaCharacterId, characterId)).run();
    tx.delete(industryJobs).where(eq(industryJobs.viaCharacterId, characterId)).run();
    tx.delete(characters).where(eq(characters.characterId, characterId)).run();
  });
  forgetCharacterLookups();
}

// ---- sync -----------------------------------------------------------------

const toBp = (b: EsiBlueprint, ownerType: "character" | "corporation", ownerId: number, via: number) => ({
  itemId: b.item_id,
  ownerType,
  ownerId,
  viaCharacterId: via,
  typeId: b.type_id,
  me: b.material_efficiency,
  te: b.time_efficiency,
  runs: b.runs,
  quantity: b.quantity,
  locationId: b.location_id,
  locationFlag: b.location_flag,
});

const toJob = (j: EsiJob, ownerType: "character" | "corporation", via: number) => ({
  jobId: j.job_id,
  ownerType,
  installerId: j.installer_id,
  viaCharacterId: via,
  activityId: j.activity_id,
  blueprintTypeId: j.blueprint_type_id,
  productTypeId: j.product_type_id ?? null,
  runs: j.runs,
  status: j.status,
  facilityId: j.facility_id,
  startDate: j.start_date,
  endDate: j.end_date,
});

export interface SyncResult {
  characterId: number;
  name: string;
  skills: number;
  blueprints: number;
  corpBlueprints: number | null;
  jobs: number;
  notes: string[];
}

export async function syncCharacter(
  characterId: number,
  api: CharacterApi = esiCharacterApi,
  token: (id: number) => Promise<string> = accessToken,
): Promise<SyncResult> {
  const db = getDb();
  const c = db.select().from(characters).where(eq(characters.characterId, characterId)).get();
  if (!c) throw new Error(`Персонаж ${characterId} не найден`);
  const t = await token(characterId);
  const notes: string[] = [];

  const info = await api.publicInfo(characterId).catch(() => null);
  const corpId = info?.corporation_id ?? c.corporationId;

  const [skills, bps, jobs] = await Promise.all([api.skills(characterId, t), api.blueprints(characterId, t), api.jobs(characterId, t)]);

  let corpBps: EsiBlueprint[] | null = null;
  let corpJobs: EsiJob[] = [];
  if (corpId) {
    const why = (e: unknown, what: string, role: string) =>
      e instanceof EsiError && e.status === 403 ? `${what} недоступны: нужна роль ${role}` : `${what} не загрузились: ${(e as Error).message}`;
    // Separate calls: the roles differ, one may work without the other.
    [corpBps, corpJobs] = await Promise.all([
      api.corpBlueprints(corpId, t).catch((e) => (notes.push(why(e, "Корп. чертежи", "Director")), null)),
      api.corpJobs(corpId, t).catch((e) => (notes.push(why(e, "Корп. джобы", "Factory Manager")), [] as EsiJob[])),
    ]);
  }

  db.transaction((tx) => {
    tx.delete(characterSkills).where(eq(characterSkills.characterId, characterId)).run();
    for (const s of skills.skills) {
      tx.insert(characterSkills).values({ characterId, skillId: s.skill_id, level: s.active_skill_level }).run();
    }
    tx.delete(ownedBlueprints).where(and(eq(ownedBlueprints.ownerType, "character"), eq(ownedBlueprints.ownerId, characterId))).run();
    for (const b of bps) tx.insert(ownedBlueprints).values(toBp(b, "character", characterId, characterId)).onConflictDoNothing().run();
    if (corpBps && corpId) {
      tx.delete(ownedBlueprints).where(and(eq(ownedBlueprints.ownerType, "corporation"), eq(ownedBlueprints.ownerId, corpId))).run();
      for (const b of corpBps) tx.insert(ownedBlueprints).values(toBp(b, "corporation", corpId, characterId)).onConflictDoNothing().run();
    }
    tx.delete(industryJobs).where(eq(industryJobs.viaCharacterId, characterId)).run();
    for (const j of jobs) tx.insert(industryJobs).values(toJob(j, "character", characterId)).onConflictDoNothing().run();
    for (const j of corpJobs) tx.insert(industryJobs).values(toJob(j, "corporation", characterId)).onConflictDoNothing().run();
    tx.update(characters)
      .set({ corporationId: corpId ?? null, name: info?.name ?? c.name, lastSyncAt: new Date().toISOString(), lastSyncNotes: notes })
      .where(eq(characters.characterId, characterId))
      .run();
  });
  forgetCharacterLookups();

  return {
    characterId,
    name: c.name,
    skills: skills.skills.length,
    blueprints: bps.length,
    corpBlueprints: corpBps?.length ?? null,
    jobs: jobs.length + corpJobs.length,
    notes,
  };
}

export async function syncAll(api?: CharacterApi): Promise<(SyncResult | { characterId: number; name: string; error: string })[]> {
  const out = [];
  for (const c of getDb().select().from(characters).all()) {
    try {
      out.push(await syncCharacter(c.characterId, api));
    } catch (e) {
      const error = (e as Error).message;
      getDb().update(characters).set({ lastSyncNotes: [`Ошибка синхронизации: ${error}`] }).where(eq(characters.characterId, c.characterId)).run();
      out.push({ characterId: c.characterId, name: c.name, error });
    }
  }
  return out;
}

// ---- lookups for calculations ---------------------------------------------

/**
 * The overview calls these for every item (hundreds of times in a few seconds) and they
 * read whole tables. Keep each result for a few seconds; a sync shows up at most that late.
 */
const MEMO_MS = 5_000;
const memo = new Map<string, { at: number; value: unknown }>();
function remember<T>(key: string, load: () => T): T {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as T;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  return value;
}
/** Call after writing characters, skills or blueprints. */
export function forgetCharacterLookups(): void {
  memo.clear();
}

export function hasCharacters(): boolean {
  return remember("has", () => getDb().select({ id: characters.characterId }).from(characters).limit(1).all().length > 0);
}

/** Skill levels: one character, or the best level across all characters (characterId = null). */
export function skillLevels(characterId: number | null): Map<number, number> {
  return remember(`skills:${characterId}`, () => loadSkillLevels(characterId));
}

function loadSkillLevels(characterId: number | null): Map<number, number> {
  const db = getDb();
  const rows = characterId
    ? db.select().from(characterSkills).where(eq(characterSkills.characterId, characterId)).all()
    : db.select().from(characterSkills).all();
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.skillId, Math.max(m.get(r.skillId) ?? 0, r.level));
  return m;
}

export interface OwnedBlueprint {
  blueprintTypeId: number;
  me: number;
  te: number;
  isBpo: boolean;
  /** Runs on the best BPC (−1 for BPO). */
  runs: number;
  /** BPO count + BPC count across characters and corp. */
  copies: number;
}

/** Best owned blueprint per blueprint type: BPO over BPC, then higher ME, then TE. */
export function ownedBlueprintIndex(blueprintTypeIds?: number[]): Map<number, OwnedBlueprint> {
  return blueprintTypeIds ? loadOwnedBlueprints(blueprintTypeIds) : remember("owned", () => loadOwnedBlueprints());
}

function loadOwnedBlueprints(blueprintTypeIds?: number[]): Map<number, OwnedBlueprint> {
  const db = getDb();
  const rows = blueprintTypeIds
    ? db.select().from(ownedBlueprints).where(inArray(ownedBlueprints.typeId, blueprintTypeIds)).all()
    : db.select().from(ownedBlueprints).all();
  const out = new Map<number, OwnedBlueprint>();
  for (const r of rows) {
    const cand: OwnedBlueprint = { blueprintTypeId: r.typeId, me: r.me, te: r.te, isBpo: r.runs === -1, runs: r.runs, copies: 1 };
    const cur = out.get(r.typeId);
    if (!cur) {
      out.set(r.typeId, cand);
      continue;
    }
    const better =
      cand.isBpo !== cur.isBpo ? cand.isBpo : cand.me !== cur.me ? cand.me > cur.me : cand.te !== cur.te ? cand.te > cur.te : cand.runs > cur.runs;
    out.set(r.typeId, { ...(better ? cand : cur), copies: cur.copies + 1 });
  }
  return out;
}
