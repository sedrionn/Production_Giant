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
    sellOrders: integer("sell_orders"),
    sellOrdersFresh: integer("sell_orders_fresh"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.typeId, t.locationId] })],
);

/** Traded volume from region market history (refreshed with prices). */
export const marketStats = sqliteTable(
  "market_stats",
  {
    typeId: integer("type_id").notNull(),
    regionId: integer("region_id").notNull(),
    avgDailyVolume7d: real("avg_daily_volume_7d").notNull(),
    avgDailyVolume30d: real("avg_daily_volume_30d").notNull(),
    avgPrice30d: real("avg_price_30d"),
    avgPrice7d: real("avg_price_7d"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.typeId, t.regionId] })],
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

// ---- characters (stage 2) ----------------------------------------------------

export const characters = sqliteTable("characters", {
  characterId: integer("character_id").primaryKey(),
  name: text("name").notNull(),
  corporationId: integer("corporation_id"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** AES-GCM sealed (src/server/secret.ts). */
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessExpiresAt: text("access_expires_at"),
  lastSyncAt: text("last_sync_at"),
  /** Human-readable problems from the last sync (e.g. no Director role for corp blueprints). */
  lastSyncNotes: text("last_sync_notes", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull().default(now),
});

export const characterSkills = sqliteTable(
  "character_skills",
  {
    characterId: integer("character_id").notNull(),
    skillId: integer("skill_id").notNull(),
    /** Active level (alpha clones may train more than they can use). */
    level: integer("level").notNull(),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.skillId] })],
);

export const ownedBlueprints = sqliteTable(
  "owned_blueprints",
  {
    itemId: integer("item_id").primaryKey(),
    ownerType: text("owner_type", { enum: ["character", "corporation"] }).notNull(),
    ownerId: integer("owner_id").notNull(),
    /** Character whose token fetched it. */
    viaCharacterId: integer("via_character_id").notNull(),
    typeId: integer("type_id").notNull(),
    me: integer("me").notNull(),
    te: integer("te").notNull(),
    /** −1 = BPO (unlimited), otherwise runs left on the BPC. */
    runs: integer("runs").notNull(),
    quantity: integer("quantity").notNull(),
    locationId: integer("location_id").notNull(),
    locationFlag: text("location_flag").notNull(),
  },
  (t) => [index("owned_blueprints_type").on(t.typeId)],
);

export const industryJobs = sqliteTable("industry_jobs", {
  jobId: integer("job_id").primaryKey(),
  ownerType: text("owner_type", { enum: ["character", "corporation"] }).notNull(),
  installerId: integer("installer_id").notNull(),
  viaCharacterId: integer("via_character_id").notNull(),
  activityId: integer("activity_id").notNull(),
  blueprintTypeId: integer("blueprint_type_id").notNull(),
  productTypeId: integer("product_type_id"),
  runs: integer("runs").notNull(),
  status: text("status").notNull(),
  facilityId: integer("facility_id").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  /** Install fee + facility tax (ESI `cost`). */
  cost: real("cost"),
  completedDate: text("completed_date"),
  successfulRuns: integer("successful_runs"),
});

// ---- money: wallet, market orders, contracts (stage 3) ---------------------------
// Kept across syncs (upsert, never cleared) so history grows past ESI's 30/90-day windows.

export const walletJournal = sqliteTable(
  "wallet_journal",
  {
    id: integer("id").primaryKey(),
    characterId: integer("character_id").notNull(),
    date: text("date").notNull(),
    refType: text("ref_type").notNull(),
    amount: real("amount").notNull(),
    balance: real("balance"),
    description: text("description").notNull().default(""),
    firstPartyId: integer("first_party_id"),
    secondPartyId: integer("second_party_id"),
    contextId: integer("context_id"),
    contextIdType: text("context_id_type"),
    reason: text("reason"),
    tax: real("tax"),
  },
  (t) => [index("wallet_journal_char_date").on(t.characterId, t.date)],
);

export const walletTransactions = sqliteTable(
  "wallet_transactions",
  {
    transactionId: integer("transaction_id").primaryKey(),
    characterId: integer("character_id").notNull(),
    date: text("date").notNull(),
    typeId: integer("type_id").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: real("unit_price").notNull(),
    isBuy: integer("is_buy", { mode: "boolean" }).notNull(),
    isPersonal: integer("is_personal", { mode: "boolean" }).notNull().default(true),
    locationId: integer("location_id").notNull(),
    clientId: integer("client_id"),
    journalRefId: integer("journal_ref_id"),
  },
  (t) => [index("wallet_transactions_type").on(t.typeId), index("wallet_transactions_date").on(t.date)],
);

export const marketOrders = sqliteTable(
  "market_orders",
  {
    orderId: integer("order_id").primaryKey(),
    characterId: integer("character_id").notNull(),
    typeId: integer("type_id").notNull(),
    locationId: integer("location_id").notNull(),
    regionId: integer("region_id").notNull(),
    isBuy: integer("is_buy", { mode: "boolean" }).notNull(),
    price: real("price").notNull(),
    volumeTotal: integer("volume_total").notNull(),
    volumeRemain: integer("volume_remain").notNull(),
    issued: text("issued").notNull(),
    duration: integer("duration").notNull(),
    escrow: real("escrow"),
    /** open (from /orders/) or what /orders/history/ says: closed, expired, cancelled. */
    state: text("state").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("market_orders_type").on(t.typeId)],
);

export const contracts = sqliteTable("contracts", {
  contractId: integer("contract_id").primaryKey(),
  characterId: integer("character_id").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  issuerId: integer("issuer_id").notNull(),
  acceptorId: integer("acceptor_id"),
  forCorporation: integer("for_corporation", { mode: "boolean" }).notNull().default(false),
  price: real("price"),
  reward: real("reward"),
  collateral: real("collateral"),
  volume: real("volume"),
  startLocationId: integer("start_location_id"),
  endLocationId: integer("end_location_id"),
  title: text("title"),
  dateIssued: text("date_issued").notNull(),
  dateCompleted: text("date_completed"),
});

export const walletBalances = sqliteTable(
  "wallet_balances",
  {
    characterId: integer("character_id").notNull(),
    /** One row per sync. */
    at: text("at").notNull(),
    balance: real("balance").notNull(),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.at] })],
);
