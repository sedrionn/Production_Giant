import { describe, expect, it } from "vitest";
import { adjustedPriceMap, aggregateOrders, costIndicesBySystem, volumeStats } from "@/esi/transform";
import { STATION_JITA_4_4 } from "@/esi/types";
import type { EsiMarketOrder } from "@/esi/types";

const o = (p: Partial<EsiMarketOrder>): EsiMarketOrder => ({
  order_id: Math.random(),
  type_id: 34,
  location_id: STATION_JITA_4_4,
  price: 1,
  volume_remain: 1,
  is_buy_order: false,
  ...p,
});

describe("aggregateOrders (old sheet bug #4: region-wide min)", () => {
  const orders = [
    o({ price: 4.0, volume_remain: 100 }),
    o({ price: 3.9, volume_remain: 50 }),
    o({ price: 3.5, location_id: 60008494 }), // Amarr — must be ignored
    o({ price: 3.6, is_buy_order: true, volume_remain: 1000 }),
    o({ price: 3.7, is_buy_order: true, volume_remain: 10 }),
    o({ price: 3.8, is_buy_order: true, location_id: 1 }), // elsewhere — ignored
    o({ price: 0.1, type_id: 35 }), // other type — ignored
  ];

  it("best bid / ask at Jita 4-4 only", () => {
    const q = aggregateOrders(34, orders, STATION_JITA_4_4);
    expect(q).toMatchObject({ typeId: 34, buyMax: 3.7, sellMin: 3.9, buyVolume: 1010, sellVolume: 150 });
  });

  it("empty book → nulls", () => {
    expect(aggregateOrders(34, [], STATION_JITA_4_4)).toMatchObject({ buyMax: null, sellMin: null });
  });
});

describe("adjustedPriceMap", () => {
  it("skips types without adjusted price", () => {
    const m = adjustedPriceMap([{ type_id: 34, adjusted_price: 4.2 }, { type_id: 35, average_price: 9 }]);
    expect([...m.entries()]).toEqual([[34, 4.2]]);
  });
});

describe("costIndicesBySystem", () => {
  it("maps ESI activity names", () => {
    const m = costIndicesBySystem([
      {
        solar_system_id: 30000142,
        cost_indices: [
          { activity: "manufacturing", cost_index: 0.05 },
          { activity: "researching_material_efficiency", cost_index: 0.01 },
          { activity: "reaction", cost_index: 0.02 },
          { activity: "something_new", cost_index: 9 },
        ],
      },
    ]);
    expect(m.get(30000142)).toEqual({ manufacturing: 0.05, research_material: 0.01, reaction: 0.02 });
  });
});

describe("volumeStats", () => {
  // SYNTHETIC history: ESI omits days without trades.
  const h = (date: string, volume: number, average = 100) => ({ date, volume, average, highest: average, lowest: average, order_count: 1 });
  it("averages over 7/30 days, missing days count as zero, today excluded", () => {
    const s = volumeStats(1, [h("2026-10-16", 999), h("2026-10-15", 70), h("2026-10-09", 7), h("2026-10-08", 30), h("2026-09-16", 3000)], "2026-10-16");
    expect(s.avgDailyVolume7d).toBeCloseTo((70 + 7) / 7);
    expect(s.avgDailyVolume30d).toBeCloseTo((70 + 7 + 30 + 3000) / 30);
  });
  it("market sanity: VWAP, median of daily averages, days with trades", () => {
    const s = volumeStats(1, [h("2026-10-15", 1, 100), h("2026-10-14", 3, 200), h("2026-10-01", 1, 1000), h("2026-10-16", 50, 5)], "2026-10-16");
    expect(s).toMatchObject({ daysTraded7d: 2, daysTraded30d: 3, median30d: 200 });
    expect(s.vwap7d).toBeCloseTo(175);
    expect(s.vwap30d).toBeCloseTo((100 + 600 + 1000) / 5);
    expect(volumeStats(1, [], "2026-10-16")).toMatchObject({ vwap7d: null, vwap30d: null, median30d: null, daysTraded7d: 0, daysTraded30d: 0 });
  });
  it("volume-weighted price, null when nothing traded", () => {
    expect(volumeStats(1, [h("2026-10-15", 1, 100), h("2026-10-14", 3, 200)], "2026-10-16").avgPrice30d).toBeCloseTo(175);
    expect(volumeStats(1, [], "2026-10-16").avgPrice30d).toBeNull();
  });
});

describe("market depth (SYNTHETIC orders)", () => {
  it("counts hub sell orders and those repriced in the last 24 h", async () => {
    const { aggregateOrders } = await import("@/esi/transform");
    const now = Date.parse("2026-10-17T12:00:00Z");
    const o = (id: number, issued: string, buy = false, loc = 60003760) => ({ order_id: id, type_id: 1, location_id: loc, price: 100 + id, volume_remain: 1, is_buy_order: buy, issued });
    const q = aggregateOrders(1, [o(1, "2026-10-17T08:00:00Z"), o(2, "2026-10-10T08:00:00Z"), o(3, "2026-10-17T09:00:00Z", true), o(4, "2026-10-17T09:00:00Z", false, 1)], 60003760, now);
    expect(q).toMatchObject({ sellOrders: 2, sellOrdersFresh: 1, sellMin: 101, buyMax: 103 });
  });
  it("7-day average price next to the 30-day one", async () => {
    const { volumeStats } = await import("@/esi/transform");
    const h = (date: string, average: number, volume: number) => ({ date, average, volume, highest: average, lowest: average, order_count: 1 });
    const v = volumeStats(1, [h("2026-10-16", 90, 10), h("2026-10-01", 110, 10)], "2026-10-17");
    expect(v.avgPrice7d).toBe(90);
    expect(v.avgPrice30d).toBe(100);
  });
});
