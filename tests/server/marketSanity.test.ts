import { beforeAll, describe, expect, it } from "vitest";
import { saleNote } from "@/lib/marketSanity";

// REAL fixtures (recipes, prices) + SYNTHETIC market history written into market_stats.
process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";

let calc: typeof import("@/server/calculate");
let data: typeof import("@/server/data");
let schema: typeof import("@/db/schema");

beforeAll(async () => {
  calc = await import("@/server/calculate");
  data = await import("@/server/data");
  schema = await import("@/db/schema");
});

const HAMMERHEAD_II = 2185;
const history = (typeId: number, h: { vwap7d: number | null; daysTraded7d: number; daysTraded30d: number }) =>
  data
    .getDb()
    .insert(schema.marketStats)
    .values({ typeId, regionId: data.getSettings().priceRegionId, avgDailyVolume7d: 1, avgDailyVolume30d: 1, avgPrice7d: h.vwap7d, avgPrice30d: h.vwap7d, vwap7d: h.vwap7d, vwap30d: h.vwap7d, median30d: h.vwap7d, daysTraded7d: h.daysTraded7d, daysTraded30d: h.daysTraded30d })
    .onConflictDoUpdate({ target: [schema.marketStats.typeId, schema.marketStats.regionId], set: { vwap7d: h.vwap7d, vwap30d: h.vwap7d, median30d: h.vwap7d, daysTraded7d: h.daysTraded7d, daysTraded30d: h.daysTraded30d } })
    .run();

describe("calculate: the product sale price goes through realisticPrice", () => {
  it("no history row → order book price, unchecked", () => {
    const r = calc.calculate({ typeId: HAMMERHEAD_II, runs: 10 });
    expect(r.summary.priceCheck.checked).toBe(false);
    expect(r.summary.unitPrice).toBe(r.summary.priceCheck.raw);
  });

  it("a wall far above history → revenue at history + 15%, flagged, with a warning", () => {
    const raw = calc.calculate({ typeId: HAMMERHEAD_II, runs: 10 }).summary.priceCheck.raw!;
    history(HAMMERHEAD_II, { vwap7d: raw / 10, daysTraded7d: 7, daysTraded30d: 30 });
    const r = calc.calculate({ typeId: HAMMERHEAD_II, runs: 10 });
    expect(r.summary.unitPrice).toBeCloseTo((raw / 10) * 1.15);
    expect(r.summary.priceCheck.flags[0]).toMatchObject({ kind: "spike", label: "цена выше истории ×10.0" });
    expect(saleNote(r.summary.priceCheck, r.summary.unitPrice)).toMatch(/^в стакане .*, по истории .*, считаю .* \(цена выше истории ×10\.0\)$/);
  });

  it("no market → buy order only; the overview row carries the flag", async () => {
    history(HAMMERHEAD_II, { vwap7d: null, daysTraded7d: 0, daysTraded30d: 2 });
    const r = calc.calculate({ typeId: HAMMERHEAD_II, runs: 10 });
    expect(r.summary.unitPrice).toBe(r.summary.priceCheck.flags[0].kind === "no_market" ? data.priceBook([HAMMERHEAD_II], data.getSettings().priceLocationId).quote(HAMMERHEAD_II)?.buyMax ?? 0 : NaN);
    const { overviewRows } = await import("@/server/overview");
    const row = overviewRows([data.getSde().source.getType(HAMMERHEAD_II)!]).rows[0];
    expect(row.priceFlags.map((f) => f.kind)).toContain("no_market");
    expect(row.priceNote).toMatch(/нет рынка/);
  });
});
