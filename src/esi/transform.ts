/** Pure transforms from raw ESI data to engine-friendly shapes. Fully unit-tested. */
import type { Activity } from "@/engine/types";
import type { MarketQuote } from "@/engine/pricing";
import type { EsiIndustrySystem, EsiMarketHistoryDay, EsiMarketOrder, EsiMarketPrice } from "./types";

export interface HubQuote extends MarketQuote {
  /** Sell orders at the hub, and how many of them were placed or repriced in the last 24 h. */
  sellOrders: number;
  sellOrdersFresh: number;
}

/**
 * Best bid/ask at one station.
 * Simplification: only orders located AT the station. Region/system-range buy
 * orders placed elsewhere that could also be filled in Jita are ignored.
 */
export function aggregateOrders(typeId: number, orders: EsiMarketOrder[], locationId: number, now = Date.now()): HubQuote {
  let sellOrders = 0;
  let sellOrdersFresh = 0;
  let buyMax: number | null = null;
  let sellMin: number | null = null;
  let buyVolume = 0;
  let sellVolume = 0;
  for (const o of orders) {
    if (o.type_id !== typeId || o.location_id !== locationId) continue;
    if (o.is_buy_order) {
      buyVolume += o.volume_remain;
      if (buyMax === null || o.price > buyMax) buyMax = o.price;
    } else {
      sellVolume += o.volume_remain;
      sellOrders++;
      if (o.issued && now - Date.parse(o.issued) < 86_400_000) sellOrdersFresh++;
      if (sellMin === null || o.price < sellMin) sellMin = o.price;
    }
  }
  return { typeId, buyMax, sellMin, buyVolume, sellVolume, sellOrders, sellOrdersFresh };
}

export function adjustedPriceMap(prices: EsiMarketPrice[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of prices) if (typeof p.adjusted_price === "number") m.set(p.type_id, p.adjusted_price);
  return m;
}

const ESI_ACTIVITY: Record<string, Activity> = {
  manufacturing: "manufacturing",
  reaction: "reaction",
  invention: "invention",
  copying: "copying",
  researching_material_efficiency: "research_material",
  researching_time_efficiency: "research_time",
};

export type CostIndices = Partial<Record<Activity, number>>;

export function costIndicesBySystem(systems: EsiIndustrySystem[]): Map<number, CostIndices> {
  const m = new Map<number, CostIndices>();
  for (const s of systems) {
    const ci: CostIndices = {};
    for (const c of s.cost_indices) {
      const a = ESI_ACTIVITY[c.activity];
      if (a) ci[a] = c.cost_index;
    }
    m.set(s.solar_system_id, ci);
  }
  return m;
}

export interface VolumeStats {
  typeId: number;
  /** Units traded per day, averaged over the last 7 / 30 days (days without trades count as 0). */
  avgDailyVolume7d: number;
  avgDailyVolume30d: number;
  /** Volume-weighted average price over 30 days; null if nothing traded. */
  avgPrice30d: number | null;
  /** Volume-weighted average price over the last 7 days; null if nothing traded. */
  avgPrice7d: number | null;
}

/** Region market history → average daily volume. `today` = YYYY-MM-DD (UTC). */
export function volumeStats(typeId: number, history: EsiMarketHistoryDay[], today: string): VolumeStats {
  const end = Date.parse(today + "T00:00:00Z");
  const day = 86_400_000;
  let v7 = 0;
  let v30 = 0;
  let isk30 = 0;
  let isk7 = 0;
  for (const h of history) {
    const age = (end - Date.parse(h.date + "T00:00:00Z")) / day;
    // ESI history ends yesterday; "last 7 days" = ages 1..7.
    if (age >= 1 && age <= 7) {
      v7 += h.volume;
      isk7 += h.volume * h.average;
    }
    if (age >= 1 && age <= 30) {
      v30 += h.volume;
      isk30 += h.volume * h.average;
    }
  }
  return {
    typeId,
    avgDailyVolume7d: v7 / 7,
    avgDailyVolume30d: v30 / 30,
    avgPrice30d: v30 ? isk30 / v30 : null,
    avgPrice7d: v7 ? isk7 / v7 : null,
  };
}
