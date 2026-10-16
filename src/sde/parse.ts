/**
 * Parsers for the official CCP SDE in JSON Lines format
 * (https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip).
 *
 * Each line is one record; the record id is in `_key`. Field access is
 * deliberately tolerant (typeID / typeId, name as string or {en}), because the
 * 2025 SDE rework changed several names and CCP keeps iterating. Anything we
 * cannot parse is returned as `null` so the importer can count and report it.
 */
import type { Activity, BlueprintActivity, Blueprint } from "@/engine/types";
import type { SdeGroup, SdeSystem, SdeType } from "./types";

type Rec = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pick(r: Rec, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
}

function localized(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Rec).en === "string") return (v as Rec).en as string;
  return null;
}

function keyOf(r: Rec, ...fallbacks: string[]): number | null {
  return num(pick(r, "_key", ...fallbacks));
}

export function parseTypeRecord(r: Rec, groupCategory: Map<number, number>): SdeType | null {
  const typeId = keyOf(r, "typeID", "typeId");
  const groupId = num(pick(r, "groupID", "groupId"));
  const name = localized(pick(r, "name", "typeName"));
  if (typeId === null || groupId === null || name === null) return null;
  return {
    typeId,
    name,
    groupId,
    categoryId: groupCategory.get(groupId) ?? null,
    portionSize: num(pick(r, "portionSize")) ?? 1,
    volume: num(pick(r, "volume")) ?? 0,
    published: pick(r, "published") === true,
    marketGroupId: num(pick(r, "marketGroupID", "marketGroupId")),
    metaGroupId: num(pick(r, "metaGroupID", "metaGroupId")),
    raceId: num(pick(r, "raceID", "raceId")),
  };
}

export function parseGroupRecord(r: Rec): SdeGroup | null {
  const groupId = keyOf(r, "groupID", "groupId");
  const categoryId = num(pick(r, "categoryID", "categoryId"));
  if (groupId === null || categoryId === null) return null;
  return { groupId, categoryId, name: localized(pick(r, "name", "groupName")) ?? "" };
}

export function parseSystemRecord(r: Rec): SdeSystem | null {
  const systemId = keyOf(r, "solarSystemID", "solarSystemId");
  const name = localized(pick(r, "name", "solarSystemName"));
  if (systemId === null || name === null) return null;
  return { systemId, name, security: num(pick(r, "securityStatus", "security")) };
}

const ACTIVITY_ALIASES: Record<string, Activity> = {
  manufacturing: "manufacturing",
  reaction: "reaction",
  reactions: "reaction",
  invention: "invention",
  copying: "copying",
  research_material: "research_material",
  research_time: "research_time",
  researchMaterial: "research_material",
  researchTime: "research_time",
};

function parseList<T>(v: unknown, f: (r: Rec) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const item of v) {
    if (item && typeof item === "object") {
      const parsed = f(item as Rec);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

export function parseBlueprintRecord(r: Rec): Blueprint | null {
  const blueprintTypeId = keyOf(r, "blueprintTypeID", "blueprintTypeId");
  const acts = pick(r, "activities");
  if (blueprintTypeId === null || !acts || typeof acts !== "object") return null;

  const activities: Blueprint["activities"] = {};
  for (const [rawKey, rawAct] of Object.entries(acts as Rec)) {
    const activity = ACTIVITY_ALIASES[rawKey];
    if (!activity || !rawAct || typeof rawAct !== "object") continue;
    const a = rawAct as Rec;
    const ba: BlueprintActivity = {
      blueprintTypeId,
      activity,
      time: num(a.time) ?? 0,
      materials: parseList(a.materials, (m) => {
        const typeId = num(pick(m, "typeID", "typeId"));
        const quantity = num(m.quantity);
        return typeId === null || quantity === null ? null : { typeId, quantity };
      }),
      products: parseList(a.products, (p) => {
        const typeId = num(pick(p, "typeID", "typeId"));
        const quantity = num(p.quantity);
        if (typeId === null || quantity === null) return null;
        const probability = num(p.probability);
        return probability === null ? { typeId, quantity } : { typeId, quantity, probability };
      }),
      skills: parseList(a.skills, (s) => {
        const typeId = num(pick(s, "typeID", "typeId"));
        const level = num(s.level);
        return typeId === null || level === null ? null : { typeId, level };
      }),
    };
    activities[activity] = ba;
  }
  return {
    blueprintTypeId,
    maxProductionLimit: num(pick(r, "maxProductionLimit")) ?? 0,
    activities,
  };
}

