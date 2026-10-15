import type Database from "better-sqlite3";
import type { Activity, Blueprint, BlueprintActivity } from "@/engine/types";
import type { ProducerRef, SdeSource, SdeType } from "./types";

interface TypeRow {
  type_id: number;
  name: string;
  group_id: number;
  category_id: number | null;
  portion_size: number;
  volume: number;
  published: number;
  market_group_id: number | null;
  meta_group_id: number | null;
}

function toType(r: TypeRow): SdeType {
  return {
    typeId: r.type_id,
    name: r.name,
    groupId: r.group_id,
    categoryId: r.category_id,
    portionSize: r.portion_size,
    volume: r.volume,
    published: r.published === 1,
    marketGroupId: r.market_group_id,
    metaGroupId: r.meta_group_id,
  };
}

/** Reads the normalized tables written by src/sde/build.ts. */
export class SqliteSdeSource implements SdeSource {
  private cache = new Map<number, Blueprint | undefined>();

  constructor(private db: Database.Database) {}

  getType(typeId: number): SdeType | undefined {
    const r = this.db.prepare("SELECT * FROM sde_types WHERE type_id = ?").get(typeId) as TypeRow | undefined;
    return r && toType(r);
  }

  getBlueprint(blueprintTypeId: number): Blueprint | undefined {
    if (this.cache.has(blueprintTypeId)) return this.cache.get(blueprintTypeId);
    const head = this.db
      .prepare("SELECT max_production_limit FROM sde_blueprints WHERE blueprint_type_id = ?")
      .get(blueprintTypeId) as { max_production_limit: number } | undefined;
    if (!head) {
      this.cache.set(blueprintTypeId, undefined);
      return undefined;
    }
    const acts = this.db
      .prepare("SELECT activity, time FROM sde_bp_activities WHERE blueprint_type_id = ?")
      .all(blueprintTypeId) as { activity: Activity; time: number }[];
    const mats = this.db
      .prepare("SELECT activity, type_id, quantity FROM sde_bp_materials WHERE blueprint_type_id = ?")
      .all(blueprintTypeId) as { activity: Activity; type_id: number; quantity: number }[];
    const prods = this.db
      .prepare("SELECT activity, type_id, quantity, probability FROM sde_bp_products WHERE blueprint_type_id = ?")
      .all(blueprintTypeId) as { activity: Activity; type_id: number; quantity: number; probability: number | null }[];
    const skills = this.db
      .prepare("SELECT activity, type_id, level FROM sde_bp_skills WHERE blueprint_type_id = ?")
      .all(blueprintTypeId) as { activity: Activity; type_id: number; level: number }[];

    const activities: Blueprint["activities"] = {};
    for (const a of acts) {
      const ba: BlueprintActivity = {
        blueprintTypeId,
        activity: a.activity,
        time: a.time,
        materials: mats.filter((m) => m.activity === a.activity).map((m) => ({ typeId: m.type_id, quantity: m.quantity })),
        products: prods
          .filter((p) => p.activity === a.activity)
          .map((p) =>
            p.probability === null
              ? { typeId: p.type_id, quantity: p.quantity }
              : { typeId: p.type_id, quantity: p.quantity, probability: p.probability },
          ),
        skills: skills.filter((s) => s.activity === a.activity).map((s) => ({ typeId: s.type_id, level: s.level })),
      };
      activities[a.activity] = ba;
    }
    const bp: Blueprint = { blueprintTypeId, maxProductionLimit: head.max_production_limit, activities };
    this.cache.set(blueprintTypeId, bp);
    return bp;
  }

  findProducers(productTypeId: number, activity?: Activity): ProducerRef[] {
    const rows = (
      activity
        ? this.db
            .prepare("SELECT blueprint_type_id, activity FROM sde_bp_products WHERE type_id = ? AND activity = ?")
            .all(productTypeId, activity)
        : this.db.prepare("SELECT blueprint_type_id, activity FROM sde_bp_products WHERE type_id = ?").all(productTypeId)
    ) as { blueprint_type_id: number; activity: Activity }[];
    return rows.map((r) => ({ blueprintTypeId: r.blueprint_type_id, activity: r.activity }));
  }

  searchTypes(query: string, limit = 20): SdeType[] {
    const rows = this.db
      .prepare("SELECT * FROM sde_types WHERE published = 1 AND name LIKE ? ORDER BY length(name) LIMIT ?")
      .all(`%${query}%`, limit) as TypeRow[];
    return rows.map(toType);
  }
}
