/**
 * Application database (data/app.sqlite). The SDE lives in a separate file
 * (data/sde.sqlite) so it can be replaced wholesale on every game patch.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { RigRule } from "@/engine/facility";
import type { Activity } from "@/engine/types";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** Structure presets: Sotiyo with rigs, Tatara for reactions, NPC station… */
export const structureProfiles = sqliteTable("structure_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  structureType: text("structure_type", {
    enum: ["npc_station", "raitaru", "azbel", "sotiyo", "athanor", "tatara"],
  }).notNull(),
  security: text("security", { enum: ["high", "low", "null"] }).notNull(),
  /** RigRule[] (older presets may hold the stage-1 object form — see normalizeRigs). */
  rigs: text("rigs", { mode: "json" }).$type<RigRule[]>().notNull().default([]),
  solarSystemId: integer("solar_system_id"),
  /** Fraction, 0.01 = 1% */
  facilityTax: real("facility_tax").notNull().default(0),
  /** Extra system discount on the cost-index part (e.g. Faction Warfare), fraction 0.5 = −50%. */
  systemJobBonus: real("system_job_bonus").notNull().default(0),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
});

/** Best bid/ask per type per hub, refreshed from ESI orders. */
export const priceCache = sqliteTable(
  "price_cache",
  {
    typeId: integer("type_id").notNull(),
    /** Station id, e.g. 60003760 Jita 4-4 */
    locationId: integer("location_id").notNull(),
    buyMax: real("buy_max"),
    sellMin: real("sell_min"),
    buyVolume: integer("buy_volume").notNull().default(0),
    sellVolume: integer("sell_volume").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.typeId, t.locationId] })],
);

/** CCP adjusted/average prices (/markets/prices) — used for EIV, not for profit. */
export const adjustedPrices = sqliteTable("adjusted_prices", {
  typeId: integer("type_id").primaryKey(),
  adjustedPrice: real("adjusted_price"),
  averagePrice: real("average_price"),
  updatedAt: text("updated_at").notNull().default(now),
});

export const costIndices = sqliteTable(
  "cost_indices",
  {
    solarSystemId: integer("solar_system_id").notNull(),
    activity: text("activity").$type<Activity>().notNull(),
    costIndex: real("cost_index").notNull(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.solarSystemId, t.activity] })],
);

/** Key/value settings: price modes, fee rates, default hub… (JSON values). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

/** Saved calculations / build plans. */
export const buildPlans = sqliteTable(
  "build_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    productTypeId: integer("product_type_id").notNull(),
    runs: integer("runs").notNull().default(1),
    me: integer("me").notNull().default(0),
    te: integer("te").notNull().default(0),
    profileId: integer("profile_id").references(() => structureProfiles.id),
    /** Per-node overrides: { "<typeId>": "build" | "buy" } */
    decisions: text("decisions", { mode: "json" }).$type<Record<string, "build" | "buy">>().notNull().default({}),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("build_plans_product").on(t.productTypeId)],
);
