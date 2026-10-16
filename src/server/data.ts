/**
 * Server-side data access: SDE, app DB, prices, cost indices.
 * Falls back to committed fixtures when local data is missing (cloud sessions,
 * fresh checkout), and says so — the UI shows where numbers come from.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import type { MarketQuote } from "@/engine/pricing";
import type { Activity } from "@/engine/types";
import { openAppDb, type AppDb } from "@/db/client";
import { adjustedPrices, costIndices, priceCache, settings, structureProfiles } from "@/db/schema";
import { DEFAULT_SETTINGS, type AppSettings } from "@/db/seed";
import { FixtureSdeSource } from "@/sde/fixtureSource";
import { SqliteSdeSource } from "@/sde/sqliteSource";
import type { SdeSource, SdeSubset } from "@/sde/types";
import type { CostIndices } from "@/esi/transform";

const DATA = path.resolve("data");
const FIXTURES = path.resolve("fixtures");

type Cache = {
  sde?: { source: SdeSource; kind: "sqlite" | "fixtures"; build: string | null };
  db?: AppDb;
  fixtures?: FixtureData | null;
};
// Survive Next.js dev hot reloads.
const g = globalThis as unknown as { __pg?: Cache };
const cache: Cache = (g.__pg ??= {});

interface FixtureData {
  subset: SdeSubset;
  quotes: Record<string, MarketQuote>;
  adjusted: Record<string, number>;
  indices: Record<string, CostIndices>;
  capturedAt: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function fixtures(): FixtureData | null {
  if (cache.fixtures !== undefined) return cache.fixtures;
  const subset = readJson<SdeSubset>(path.join(FIXTURES, "sde/subset.json"));
  const quotes = readJson<{ quotes: Record<string, MarketQuote>; capturedAt: string }>(path.join(FIXTURES, "esi/jita-quotes.json"));
  const adjusted = readJson<{ prices: Record<string, number> }>(path.join(FIXTURES, "esi/adjusted-prices.json"));
  const indices = readJson<{ systems: Record<string, CostIndices> }>(path.join(FIXTURES, "esi/cost-indices.json"));
  cache.fixtures =
    subset && quotes && adjusted && indices
      ? { subset, quotes: quotes.quotes, adjusted: adjusted.prices, indices: indices.systems, capturedAt: quotes.capturedAt }
      : null;
  return cache.fixtures;
}

export function getSde() {
  if (cache.sde) return cache.sde;
  const file = path.join(DATA, "sde.sqlite");
  // PG_SDE=fixtures forces the committed snapshot (tests).
  if (process.env.PG_SDE !== "fixtures" && fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const build = (db.prepare("SELECT value FROM sde_meta WHERE key='build'").get() as { value: string } | undefined)?.value ?? null;
    cache.sde = { source: new SqliteSdeSource(db), kind: "sqlite", build };
  } else {
    const fx = fixtures();
    if (!fx) throw new Error("No SDE: run `npm run sde:download` (or commit fixtures/).");
    cache.sde = { source: new FixtureSdeSource(fx.subset), kind: "fixtures", build: String(fx.subset.meta.build ?? "") };
  }
  return cache.sde;
}

export function getDb(): AppDb {
  // PG_APP_DB=:memory: gives tests a throwaway database.
  return (cache.db ??= openAppDb(process.env.PG_APP_DB || undefined));
}

// ---- settings ---------------------------------------------------------------

export function getSettings(): AppSettings {
  const rows = getDb().select().from(settings).all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored)) {
    const d = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
    // Object settings gain new fields over time (e.g. industrySkills.blueprintSkills): merge with defaults.
    merged[k] = d && typeof d === "object" && v && typeof v === "object" ? { ...d, ...v } : v;
  }
  return merged as unknown as AppSettings;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    if (value === null) {
      db.delete(settings).where(eq(settings.key, key)).run();
      continue;
    }
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }
  return getSettings();
}

// ---- structure profiles -----------------------------------------------------

export type Profile = typeof structureProfiles.$inferSelect;
export type ProfileInput = Omit<typeof structureProfiles.$inferInsert, "id" | "createdAt">;

export function listProfiles(): Profile[] {
  return getDb().select().from(structureProfiles).all();
}

export function getProfile(id: number | null | undefined): Profile | undefined {
  if (id == null) return undefined;
  return getDb().select().from(structureProfiles).where(eq(structureProfiles.id, id)).get();
}

export function upsertProfile(input: ProfileInput & { id?: number }): Profile {
  const db = getDb();
  const { id, ...values } = input;
  if (values.isDefault) db.update(structureProfiles).set({ isDefault: false }).run();
  if (id) {
    db.update(structureProfiles).set(values).where(eq(structureProfiles.id, id)).run();
    return getProfile(id)!;
  }
  return db.insert(structureProfiles).values(values).returning().get();
}

export function deleteProfile(id: number): void {
  getDb().delete(structureProfiles).where(eq(structureProfiles.id, id)).run();
}

// ---- prices -----------------------------------------------------------------

export type PriceSource = "esi" | "fixtures" | "none";

export interface PriceBook {
  quote(typeId: number): MarketQuote | undefined;
  adjusted(typeId: number): number | undefined;
  /** Where each quoted type's price came from, and the oldest ESI timestamp. */
  meta(): { esi: number; fixtures: number; none: number; oldest: string | null; fixturesCapturedAt: string | null };
}

export function priceBook(typeIds: number[], locationId: number): PriceBook {
  const db = getDb();
  const ids = [...new Set(typeIds)];
  const quotes = new Map<number, MarketQuote & { updatedAt: string }>();
  const adj = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.select().from(priceCache).where(inArray(priceCache.typeId, chunk)).all()) {
      if (r.locationId === locationId) {
        quotes.set(r.typeId, { typeId: r.typeId, buyMax: r.buyMax, sellMin: r.sellMin, buyVolume: r.buyVolume, sellVolume: r.sellVolume, updatedAt: r.updatedAt });
      }
    }
    for (const r of db.select().from(adjustedPrices).where(inArray(adjustedPrices.typeId, chunk)).all()) {
      if (r.adjustedPrice !== null) adj.set(r.typeId, r.adjustedPrice);
    }
  }
  const fx = fixtures();
  const sourceOf = new Map<number, PriceSource>();
  return {
    quote(typeId) {
      const q = quotes.get(typeId);
      if (q) {
        sourceOf.set(typeId, "esi");
        return q;
      }
      const f = fx?.quotes[typeId];
      sourceOf.set(typeId, f ? "fixtures" : "none");
      return f;
    },
    adjusted(typeId) {
      return adj.get(typeId) ?? fx?.adjusted[typeId];
    },
    meta() {
      const counts = { esi: 0, fixtures: 0, none: 0 };
      for (const s of sourceOf.values()) counts[s]++;
      let oldest: string | null = null;
      for (const [id, s] of sourceOf) {
        const q = quotes.get(id);
        if (s === "esi" && q && (oldest === null || q.updatedAt < oldest)) oldest = q.updatedAt;
      }
      return { ...counts, oldest, fixturesCapturedAt: counts.fixtures ? fx?.capturedAt ?? null : null };
    },
  };
}

export function costIndicesFor(systemId: number | null | undefined): { indices: CostIndices; source: PriceSource } {
  if (systemId == null) return { indices: {}, source: "none" };
  const rows = getDb().select().from(costIndices).where(eq(costIndices.solarSystemId, systemId)).all();
  if (rows.length) {
    const indices: CostIndices = {};
    for (const r of rows) indices[r.activity as Activity] = r.costIndex;
    return { indices, source: "esi" };
  }
  const f = fixtures()?.indices[systemId];
  return f ? { indices: f, source: "fixtures" } : { indices: {}, source: "none" };
}
