import { count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { DEFAULT_BUY_BUFFER } from "@/engine/bonuses";
import type { PriceMode } from "@/engine/pricing";
import { MARKET_SANITY, type MarketSanityConfig } from "@/engine/marketSanity";
import * as schema from "./schema";
import { settings, structureProfiles } from "./schema";

export interface AppSettings {
  /** Station whose order book prices come from. */
  priceLocationId: number;
  priceRegionId: number;
  materialPriceMode: PriceMode;
  productPriceMode: PriceMode;
  /** Fractions. Manual until the trader character's skills are synced (stage 2). */
  salesTax: number;
  brokerFee: number;
  /** ME/TE assumed for every non-root blueprint (stage 2: real values from owned blueprints). */
  defaultMe: number;
  defaultTe: number;
  /** blueprintSkills: level assumed for every other skill a blueprint requires (1% time per level). */
  industrySkills: { industry: number; advancedIndustry: number; reactions: number; blueprintSkills: number };
  inventionSkills: { encryption: number; science1: number; science2: number };
  /** Build an intermediate only if it saves at least this many ISK per hour of its job vs buying. */
  minBuildIskPerHour: number;
  /** Overview and weekly plan: size batches so the product's job runs about this long. */
  targetJobDays: number;
  /** Decryptor used for invention (type id), null = none. */
  inventionDecryptorId: number | null;
  /** Own BPCs: "free" (already paid) or valued at what inventing the same runs would cost. */
  ownBpcValue: "free" | "invention";
  /** Freight ISK per m³: bought materials market → factory, and product factory → market. 0 = off. */
  freightInPerM3: number;
  freightOutPerM3: number;
  /** Plan purchase list: extra share bought on top of what is needed after stock (0.01 = +1%). */
  buyBuffer: number;
  /** Hidden from the overview and the plan: whole groups by rule, plus single items. */
  blacklist: { boosters: boolean; triglavian: boolean; edencom: boolean; typeIds: number[] };
  /** Full refresh (characters, prices, volumes) while the app runs; 0 = off. */
  autoRefreshHours: number;
  /** When the last full refresh finished (ISO), null = never. */
  lastAutoRefreshAt: string | null;
  /** Locations whose hangars count as stock (station / structure ids); null = where your industry jobs run. */
  stockLocationIds: number[] | null;
  /** Character whose skills drive time/invention; null = best level across all synced characters. */
  industryCharacterId: number | null;
  manufacturingProfileId: number | null;
  reactionProfileId: number | null;
  /** Product sale price vs market history (speculators' walls, illiquid items). */
  marketSanity: MarketSanityConfig;
  /** Weekly plan: leave out products flagged "no market". */
  planSkipNoMarket: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  priceLocationId: 60003760, // Jita IV - Moon 4 - Caldari Navy Assembly Plant
  priceRegionId: 10000002, // The Forge
  materialPriceMode: "sell",
  productPriceMode: "sell",
  salesTax: 0.03375,
  brokerFee: 0.015,
  defaultMe: 10,
  defaultTe: 20,
  industrySkills: { industry: 5, advancedIndustry: 5, reactions: 4, blueprintSkills: 5 },
  inventionSkills: { encryption: 4, science1: 4, science2: 4 },
  minBuildIskPerHour: 100_000,
  targetJobDays: 5,
  inventionDecryptorId: null,
  ownBpcValue: "free",
  freightInPerM3: 0,
  freightOutPerM3: 0,
  buyBuffer: DEFAULT_BUY_BUFFER,
  blacklist: { boosters: true, triglavian: true, edencom: true, typeIds: [] },
  autoRefreshHours: 24,
  lastAutoRefreshAt: null,
  stockLocationIds: null,
  industryCharacterId: null,
  manufacturingProfileId: null,
  reactionProfileId: null,
  marketSanity: { ...MARKET_SANITY },
  planSkipNoMarket: true,
};

/** Idempotent: only fills empty tables / missing keys. Rigs are left empty — Nick fills them in the UI. */
export function seedDefaults(db: BetterSQLite3Database<typeof schema>): void {
  const [{ n }] = db.select({ n: count() }).from(structureProfiles).all();
  if (n === 0) {
    db.insert(structureProfiles)
      .values([
        { name: "Sotiyo (main)", structureType: "sotiyo", security: "null", rigs: [], facilityTax: 0, isDefault: true },
        { name: "Tatara (reactions)", structureType: "tatara", security: "null", rigs: [], facilityTax: 0 },
        { name: "NPC Station (Jita)", structureType: "npc_station", security: "high", solarSystemId: 30000142, facilityTax: 0.0025 },
      ])
      .run();
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (value === null) continue; // absent key = default
    db.insert(settings).values({ key, value }).onConflictDoNothing().run();
  }
}
