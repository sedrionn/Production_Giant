/**
 * Assets of characters and their corporations: what is already in the hangars, so the plan
 * builds and buys only the rest. Replaced per owner on every sync (assets are a snapshot).
 */
import { and, eq, inArray } from "drizzle-orm";
import { assets, characters, industryJobs, locationNames } from "@/db/schema";
import { EsiError, esiGet, esiGetAllPages, mapLimit } from "@/esi/client";
import { getDb, getSde, getSettings } from "./data";
import { JOB_ACTIVITY_IDS } from "@/engine/bonuses";

export const ASSET_SCOPES = { character: "esi-assets.read_assets.v1", corporation: "esi-assets.read_corporation_assets.v1" } as const;

export interface EsiAsset {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_flag: string;
  location_type: string;
  is_singleton: boolean;
  is_blueprint_copy?: boolean;
}

export interface AssetApi {
  character(id: number, t: string): Promise<EsiAsset[]>;
  corporation(corpId: number, t: string): Promise<EsiAsset[]>;
  stationName(stationId: number): Promise<string>;
}

export const esiAssetApi: AssetApi = {
  character: (id, t) => esiGetAllPages(`/characters/${id}/assets/`, {}, t),
  corporation: (corp, t) => esiGetAllPages(`/corporations/${corp}/assets/`, {}, t),
  stationName: async (id) => (await esiGet<{ name: string }>(`/universe/stations/${id}/`)).name,
};

/** NPC station ids live in this range; everything else at the root is a player structure. */
const isStation = (id: number) => id >= 60_000_000 && id < 64_000_000;

export interface AssetSyncResult {
  character: number | null;
  corporation: number | null;
  notes: string[];
}

export async function syncAssets(characterId: number, corpId: number | null, token: string, api: AssetApi = esiAssetApi): Promise<AssetSyncResult> {
  const db = getDb();
  const c = db.select().from(characters).where(eq(characters.characterId, characterId)).get();
  if (!c) throw new Error(`Персонаж ${characterId} не найден`);
  const notes: string[] = [];
  let mine: EsiAsset[] | null = null;
  let corp: EsiAsset[] | null = null;
  if (c.scopes.includes(ASSET_SCOPES.character)) {
    mine = await api.character(characterId, token).catch((e) => (notes.push(`Ассеты не загрузились: ${(e as Error).message}`), null));
  } else notes.push("Нет доступа к ассетам — перезайди персонажем");
  if (corpId && c.scopes.includes(ASSET_SCOPES.corporation)) {
    corp = await api.corporation(corpId, token).catch((e) => {
      notes.push(e instanceof EsiError && e.status === 403 ? "Корп. ассеты недоступны: нужна роль Director" : `Корп. ассеты не загрузились: ${(e as Error).message}`);
      return null;
    });
  }

  const row = (a: EsiAsset, ownerType: "character" | "corporation", ownerId: number) => ({
    itemId: a.item_id,
    ownerType,
    ownerId,
    viaCharacterId: characterId,
    typeId: a.type_id,
    quantity: a.quantity,
    locationId: a.location_id,
    locationFlag: a.location_flag,
    locationType: a.location_type,
    isSingleton: a.is_singleton,
    isBlueprintCopy: a.is_blueprint_copy ?? false,
  });
  db.transaction((tx) => {
    if (mine) {
      tx.delete(assets).where(and(eq(assets.ownerType, "character"), eq(assets.ownerId, characterId))).run();
      for (const a of mine) tx.insert(assets).values(row(a, "character", characterId)).onConflictDoNothing().run();
    }
    if (corp && corpId) {
      tx.delete(assets).where(and(eq(assets.ownerType, "corporation"), eq(assets.ownerId, corpId))).run();
      for (const a of corp) tx.insert(assets).values(row(a, "corporation", corpId)).onConflictDoNothing().run();
    }
  });

  // Station names (public); structures need a scope the app does not ask for.
  const known = new Set(db.select({ id: locationNames.locationId }).from(locationNames).all().map((r) => r.id));
  const stations = [...new Set([...(mine ?? []), ...(corp ?? [])].map((a) => a.location_id))].filter((id) => isStation(id) && !known.has(id));
  await mapLimit(stations, 4, async (id) => {
    const name = await api.stationName(id).catch(() => null);
    if (name) db.insert(locationNames).values({ locationId: id, name, updatedAt: new Date().toISOString() }).onConflictDoNothing().run();
  });

  return { character: mine?.length ?? null, corporation: corp?.length ?? null, notes };
}

// ---- stock -----------------------------------------------------------------

/** Fitted modules, drones in bays, implants: not stock. */
const NOT_STOCK_FLAG = /^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystemSlot|ServiceSlot|DroneBay|FighterBay|FighterTube|Implant|Skill|Wardrobe|AssetSafety)/;
const CATEGORY_BLUEPRINT = 9;
const CATEGORY_SHIP = 6;

type AssetRow = typeof assets.$inferSelect;

/** Station or structure each asset sits in (walks up through containers, offices and ships). */
function rootOf(rows: AssetRow[]): Map<number, number | null> {
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  const out = new Map<number, number | null>();
  for (const r of rows) {
    let loc = r.locationId;
    let type = r.locationType;
    for (let i = 0; i < 10 && byItem.has(loc); i++) {
      const parent = byItem.get(loc)!;
      loc = parent.locationId;
      type = parent.locationType;
    }
    // In space (solar_system) is not a hangar.
    out.set(r.itemId, type === "solar_system" ? null : loc);
  }
  return out;
}

export interface StockLocation {
  locationId: number;
  name: string;
  /** Your industry jobs run here (the default stock). */
  jobsHere: boolean;
  items: number;
  selected: boolean;
}

function jobFacilities(): Set<number> {
  return new Set(getDb().select({ f: industryJobs.facilityId }).from(industryJobs).all().map((r) => r.f));
}

export function stockLocations(): StockLocation[] {
  const db = getDb();
  const rows = db.select().from(assets).all();
  const root = rootOf(rows);
  const names = new Map(db.select().from(locationNames).all().map((r) => [r.locationId, r.name]));
  const facilities = jobFacilities();
  const selected = selectedLocations(facilities);
  const count = new Map<number, number>();
  for (const r of rows) {
    const loc = root.get(r.itemId);
    if (loc) count.set(loc, (count.get(loc) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([id, items]) => ({
      locationId: id,
      name: names.get(id) ?? (facilities.has(id) ? `Структура, где идут твои джобы (#${id})` : isStation(id) ? `Станция #${id}` : `Структура #${id}`),
      jobsHere: facilities.has(id),
      items,
      selected: selected.has(id),
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.jobsHere) - Number(a.jobsHere) || b.items - a.items);
}

function selectedLocations(facilities = jobFacilities()): Set<number> {
  const s = getSettings().stockLocationIds;
  return new Set(s ?? [...facilities]);
}

/** Units on hand per type in the stock locations (no blueprints, no assembled ships, nothing fitted). */
export function stockIndex(): { stock: Map<number, number>; locations: number[]; syncedAt: string | null; owners: number } {
  const db = getDb();
  const { source: sde } = getSde();
  const locs = selectedLocations();
  const rows = locs.size ? db.select().from(assets).all() : [];
  const root = rootOf(rows);
  const stock = new Map<number, number>();
  for (const r of rows) {
    const loc = root.get(r.itemId);
    if (!loc || !locs.has(loc) || NOT_STOCK_FLAG.test(r.locationFlag)) continue;
    const t = sde.getType(r.typeId);
    if (t?.categoryId === CATEGORY_BLUEPRINT || r.isBlueprintCopy) continue;
    if (t?.categoryId === CATEGORY_SHIP && r.isSingleton) continue;
    stock.set(r.typeId, (stock.get(r.typeId) ?? 0) + r.quantity);
  }
  const via = [...new Set(rows.map((r) => r.viaCharacterId))];
  const synced = via.length
    ? db
        .select({ at: characters.lastSyncAt })
        .from(characters)
        .where(inArray(characters.characterId, via))
        .all()
        .map((r) => r.at)
        .filter((x): x is string => !!x)
        .sort()[0] ?? null
    : null;
  return { stock, locations: [...locs], syncedAt: synced, owners: new Set(rows.map((r) => `${r.ownerType}:${r.ownerId}`)).size };
}

/**
 * What running factory and reaction jobs in the stock locations will deliver within `days`: it
 * counts as stock for the plan (not in the hangar yet, so not in the assets). Finished but not
 * delivered jobs are still "active" in ESI and count too.
 */
export function jobOutputs(days: number, now = Date.now()): Map<number, number> {
  const { source: sde } = getSde();
  const locs = selectedLocations();
  const out = new Map<number, number>();
  for (const j of getDb().select().from(industryJobs).all()) {
    if (j.status !== "active" || !j.productTypeId || !locs.has(j.facilityId)) continue;
    const activity = j.activityId === JOB_ACTIVITY_IDS.manufacturing ? "manufacturing" : (JOB_ACTIVITY_IDS.reactions as readonly number[]).includes(j.activityId) ? "reaction" : null;
    if (!activity || Date.parse(j.endDate) > now + days * 86_400_000) continue;
    const perRun = sde.getBlueprint(j.blueprintTypeId)?.activities[activity]?.products.find((p) => p.typeId === j.productTypeId)?.quantity ?? 1;
    out.set(j.productTypeId, (out.get(j.productTypeId) ?? 0) + j.runs * perRun);
  }
  return out;
}

export function removeCharacterAssets(characterId: number): void {
  getDb().delete(assets).where(eq(assets.viaCharacterId, characterId)).run();
}
