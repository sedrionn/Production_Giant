/**
 * Builds data/sde.sqlite from parsed SDE records. Node-only (better-sqlite3).
 * Our own normalized tables — we never depend on a third-party dump schema.
 */
import type Database from "better-sqlite3";
import type { Blueprint } from "@/engine/types";
import type { SdeGroup, SdeSystem, SdeType } from "./types";

export const SDE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sde_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sde_groups (
  group_id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sde_types (
  type_id INTEGER PRIMARY KEY, name TEXT NOT NULL, group_id INTEGER NOT NULL,
  category_id INTEGER, portion_size INTEGER NOT NULL, volume REAL NOT NULL,
  published INTEGER NOT NULL, market_group_id INTEGER, meta_group_id INTEGER
);
CREATE INDEX IF NOT EXISTS sde_types_name ON sde_types(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sde_blueprints (
  blueprint_type_id INTEGER PRIMARY KEY, max_production_limit INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sde_bp_activities (
  blueprint_type_id INTEGER NOT NULL, activity TEXT NOT NULL, time INTEGER NOT NULL,
  PRIMARY KEY (blueprint_type_id, activity)
);
CREATE TABLE IF NOT EXISTS sde_bp_materials (
  blueprint_type_id INTEGER NOT NULL, activity TEXT NOT NULL,
  type_id INTEGER NOT NULL, quantity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sde_bp_materials_bp ON sde_bp_materials(blueprint_type_id, activity);
CREATE TABLE IF NOT EXISTS sde_bp_products (
  blueprint_type_id INTEGER NOT NULL, activity TEXT NOT NULL,
  type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, probability REAL
);
CREATE INDEX IF NOT EXISTS sde_bp_products_type ON sde_bp_products(type_id, activity);
CREATE TABLE IF NOT EXISTS sde_systems (
  system_id INTEGER PRIMARY KEY, name TEXT NOT NULL, security REAL
);
CREATE INDEX IF NOT EXISTS sde_systems_name ON sde_systems(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sde_bp_skills (
  blueprint_type_id INTEGER NOT NULL, activity TEXT NOT NULL,
  type_id INTEGER NOT NULL, level INTEGER NOT NULL
);
`;

export function createSdeSchema(db: Database.Database): void {
  db.exec(SDE_SCHEMA);
}

export function insertGroups(db: Database.Database, groups: Iterable<SdeGroup>): number {
  const stmt = db.prepare("INSERT OR REPLACE INTO sde_groups VALUES (?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const g of groups) {
      stmt.run(g.groupId, g.categoryId, g.name);
      n++;
    }
  })();
  return n;
}

export function insertTypes(db: Database.Database, types: Iterable<SdeType>): number {
  const stmt = db.prepare("INSERT OR REPLACE INTO sde_types VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const t of types) {
      stmt.run(
        t.typeId, t.name, t.groupId, t.categoryId, t.portionSize, t.volume,
        t.published ? 1 : 0, t.marketGroupId, t.metaGroupId,
      );
      n++;
    }
  })();
  return n;
}

export function insertBlueprints(db: Database.Database, blueprints: Iterable<Blueprint>): number {
  const bp = db.prepare("INSERT OR REPLACE INTO sde_blueprints VALUES (?, ?)");
  const act = db.prepare("INSERT OR REPLACE INTO sde_bp_activities VALUES (?, ?, ?)");
  const mat = db.prepare("INSERT INTO sde_bp_materials VALUES (?, ?, ?, ?)");
  const prod = db.prepare("INSERT INTO sde_bp_products VALUES (?, ?, ?, ?, ?)");
  const skill = db.prepare("INSERT INTO sde_bp_skills VALUES (?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const b of blueprints) {
      bp.run(b.blueprintTypeId, b.maxProductionLimit);
      for (const a of Object.values(b.activities)) {
        if (!a) continue;
        act.run(b.blueprintTypeId, a.activity, a.time);
        for (const m of a.materials) mat.run(b.blueprintTypeId, a.activity, m.typeId, m.quantity);
        for (const p of a.products) prod.run(b.blueprintTypeId, a.activity, p.typeId, p.quantity, p.probability ?? null);
        for (const s of a.skills) skill.run(b.blueprintTypeId, a.activity, s.typeId, s.level);
      }
      n++;
    }
  })();
  return n;
}

export function insertSystems(db: Database.Database, systems: Iterable<SdeSystem>): number {
  const stmt = db.prepare("INSERT OR REPLACE INTO sde_systems VALUES (?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const s of systems) {
      stmt.run(s.systemId, s.name, s.security);
      n++;
    }
  })();
  return n;
}

export function setMeta(db: Database.Database, meta: Record<string, string>): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO sde_meta VALUES (?, ?)");
  for (const [k, v] of Object.entries(meta)) stmt.run(k, v);
}

export interface SdeSanityReport {
  ok: boolean;
  counts: Record<string, number>;
  problems: string[];
}

/** Catches a silently-wrong import (e.g. CCP renamed a field and everything parsed to null). */
export function sanityCheck(db: Database.Database): SdeSanityReport {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const counts = {
    types: count("SELECT COUNT(*) n FROM sde_types"),
    groups: count("SELECT COUNT(*) n FROM sde_groups"),
    blueprints: count("SELECT COUNT(*) n FROM sde_blueprints"),
    manufacturing: count("SELECT COUNT(*) n FROM sde_bp_activities WHERE activity='manufacturing'"),
    reactions: count("SELECT COUNT(*) n FROM sde_bp_activities WHERE activity='reaction'"),
    invention: count("SELECT COUNT(*) n FROM sde_bp_activities WHERE activity='invention'"),
    materials: count("SELECT COUNT(*) n FROM sde_bp_materials"),
    typesWithoutCategory: count("SELECT COUNT(*) n FROM sde_types WHERE category_id IS NULL"),
    systems: count("SELECT COUNT(*) n FROM sde_systems"),
  };
  const problems: string[] = [];
  if (counts.types < 20_000) problems.push(`too few types (${counts.types})`);
  if (counts.manufacturing < 3_000) problems.push(`too few manufacturing blueprints (${counts.manufacturing})`);
  if (counts.reactions < 50) problems.push(`too few reaction formulas (${counts.reactions})`);
  if (counts.invention < 500) problems.push(`too few invention activities (${counts.invention})`);
  if (counts.typesWithoutCategory > counts.types * 0.05) problems.push("many types without category — groups not linked");
  const tritanium = db.prepare("SELECT name FROM sde_types WHERE type_id = 34").get() as { name: string } | undefined;
  if (tritanium?.name !== "Tritanium") problems.push(`type 34 should be Tritanium, got ${tritanium?.name}`);
  return { ok: problems.length === 0, counts, problems };
}
