import { count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PriceMode } from "@/engine/pricing";
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
  industrySkills: { industry: number; advancedIndustry: number; reactions: number };
  inventionSkills: { encryption: number; science1: number; science2: number };
  manufacturingProfileId: number | null;
  reactionProfileId: number | null;
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
  industrySkills: { industry: 5, advancedIndustry: 4, reactions: 4 },
  inventionSkills: { encryption: 4, science1: 4, science2: 4 },
  manufacturingProfileId: null,
  reactionProfileId: null,
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
