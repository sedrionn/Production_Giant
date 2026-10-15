/** Pure transforms from raw ESI data to engine-friendly shapes. Fully unit-tested. */
import type { Activity } from "@/engine/types";
import type { MarketQuote } from "@/engine/pricing";
import type { EsiIndustrySystem, EsiMarketOrder, EsiMarketPrice } from "./types";

/**
 * Best bid/ask at one station.
 * Simplification: only orders located AT the station. Region/system-range buy
 * orders placed elsewhere that could also be filled in Jita are ignored.
 */
export function aggregateOrders(typeId: number, orders: EsiMarketOrder[], locationId: number): MarketQuote {
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
      if (sellMin === null || o.price < sellMin) sellMin = o.price;
    }
  }
  return { typeId, buyMax, sellMin, buyVolume, sellVolume };
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
