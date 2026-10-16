/** Pulls fresh prices from ESI into the app DB. Runs on Nick's machine (needs internet). */
import { sql } from "drizzle-orm";
import { adjustedPrices, costIndices, marketStats, priceCache } from "@/db/schema";
import { getIndustrySystems, getMarketHistory, getMarketPrices, getRegionOrders, mapLimit } from "@/esi/client";
import { aggregateOrders, costIndicesBySystem, volumeStats } from "@/esi/transform";
import { getDb } from "./data";

export interface RefreshResult {
  quotes: number;
  failed: number[];
  adjusted: number;
  systems: number;
  at: string;
}

const now = () => new Date().toISOString();

/** Adjusted prices + cost indices for all systems (2 calls, cached by ESI for ~1h). */
export async function refreshGlobal(): Promise<{ adjusted: number; systems: number }> {
  const db = getDb();
  const [prices, systems] = await Promise.all([getMarketPrices(), getIndustrySystems()]);
  const at = now();
  db.transaction((tx) => {
    for (const p of prices) {
      tx.insert(adjustedPrices)
        .values({ typeId: p.type_id, adjustedPrice: p.adjusted_price ?? null, averagePrice: p.average_price ?? null, updatedAt: at })
        .onConflictDoUpdate({
          target: adjustedPrices.typeId,
          set: { adjustedPrice: sql`excluded.adjusted_price`, averagePrice: sql`excluded.average_price`, updatedAt: at },
        })
        .run();
    }
    for (const [systemId, ci] of costIndicesBySystem(systems)) {
      for (const [activity, costIndex] of Object.entries(ci)) {
        tx.insert(costIndices)
          .values({ solarSystemId: systemId, activity: activity as never, costIndex: costIndex as number, updatedAt: at })
          .onConflictDoUpdate({ target: [costIndices.solarSystemId, costIndices.activity], set: { costIndex: costIndex as number, updatedAt: at } })
          .run();
      }
    }
  });
  return { adjusted: prices.length, systems: systems.length };
}

/** Best bid/ask at the hub for each type (one ESI call per type, 8 in parallel). */
export type Progress = (done: number, total: number) => void;

export async function refreshQuotes(
  typeIds: number[],
  regionId: number,
  locationId: number,
  onProgress?: Progress,
): Promise<{ quotes: number; failed: number[] }> {
  const db = getDb();
  const failed: number[] = [];
  const ids = [...new Set(typeIds)];
  let done = 0;
  const results = await mapLimit(ids, 8, async (typeId) => {
    try {
      return aggregateOrders(typeId, await getRegionOrders(regionId, typeId), locationId);
    } catch {
      failed.push(typeId);
      return null;
    } finally {
      onProgress?.(++done, ids.length);
    }
  });
  const at = now();
  db.transaction((tx) => {
    for (const q of results) {
      if (!q) continue;
      const values = { buyMax: q.buyMax, sellMin: q.sellMin, buyVolume: q.buyVolume ?? 0, sellVolume: q.sellVolume ?? 0, updatedAt: at };
      tx.insert(priceCache)
        .values({ typeId: q.typeId, locationId, ...values })
        .onConflictDoUpdate({ target: [priceCache.typeId, priceCache.locationId], set: values })
        .run();
    }
  });
  return { quotes: results.filter(Boolean).length, failed };
}

export async function refreshPrices(typeIds: number[], regionId: number, locationId: number): Promise<RefreshResult> {
  const [global, quotes] = await Promise.all([refreshGlobal(), refreshQuotes(typeIds, regionId, locationId)]);
  return { ...global, ...quotes, at: now() };
}

/** Average traded volume per day (region market history), one ESI call per type. */
export async function refreshVolumes(typeIds: number[], regionId: number, onProgress?: Progress): Promise<{ volumes: number; failed: number[] }> {
  const db = getDb();
  const ids = [...new Set(typeIds)];
  const failed: number[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let done = 0;
  const stats = await mapLimit(ids, 8, async (typeId) => {
    try {
      return volumeStats(typeId, await getMarketHistory(regionId, typeId), today);
    } catch {
      failed.push(typeId);
      return null;
    } finally {
      onProgress?.(++done, ids.length);
    }
  });
  const at = now();
  db.transaction((tx) => {
    for (const s of stats) {
      if (!s) continue;
      const values = { avgDailyVolume7d: s.avgDailyVolume7d, avgDailyVolume30d: s.avgDailyVolume30d, avgPrice30d: s.avgPrice30d, updatedAt: at };
      tx.insert(marketStats)
        .values({ typeId: s.typeId, regionId, ...values })
        .onConflictDoUpdate({ target: [marketStats.typeId, marketStats.regionId], set: values })
        .run();
    }
  });
  return { volumes: stats.filter(Boolean).length, failed };
}
