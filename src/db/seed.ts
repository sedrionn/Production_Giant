import { count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { settings, structureProfiles } from "./schema";

export const DEFAULT_SETTINGS = {
  /** Where prices come from */
  priceLocationId: 60003760, // Jita 4-4
  materialPriceMode: "sell",
  productPriceMode: "sell",
  /** Fractions. Placeholders until the trader character's skills are synced (stage 2). */
  salesTax: 0.03375,
  brokerFee: 0.015,
} as const;

/** Idempotent: only fills empty tables. Rigs are left empty — Nick fills them in the UI. */
export function seedDefaults(db: BetterSQLite3Database<typeof schema>): void {
  const [{ n }] = db.select({ n: count() }).from(structureProfiles).all();
  if (n === 0) {
    db.insert(structureProfiles)
      .values([
        { name: "Sotiyo (main)", structureType: "sotiyo", security: "null", rigs: {}, facilityTax: 0, isDefault: true },
        { name: "Tatara (reactions)", structureType: "tatara", security: "null", rigs: {}, facilityTax: 0 },
        { name: "NPC Station (Jita)", structureType: "npc_station", security: "high", solarSystemId: 30000142, facilityTax: 0.0025 },
      ])
      .run();
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.insert(settings).values({ key, value }).onConflictDoNothing().run();
  }
}
