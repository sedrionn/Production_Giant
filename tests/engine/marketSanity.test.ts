import { describe, expect, it } from "vitest";
import { MARKET_SANITY, materialFlags, realisticPrice, referencePrice, type MarketHistory } from "@/engine/marketSanity";
import type { MarketQuote } from "@/engine/pricing";

// SYNTHETIC histories that repeat real cases from Nick's database (22.10).
const quote = (sellMin: number | null, buyMax: number | null): MarketQuote => ({ typeId: 1, sellMin, buyMax });
const liquid = (vwap7d: number, vwap30d = vwap7d): MarketHistory => ({ vwap7d, vwap30d, median30d: vwap30d, daysTraded7d: 7, daysTraded30d: 30 });

describe("realisticPrice: Capital Algid Energy Administrations Unit II (1 sell order at 220M, 0 trades)", () => {
  const q = quote(220_000_000, 19_140);
  const h: MarketHistory = { vwap7d: null, vwap30d: null, median30d: null, daysTraded7d: 0, daysTraded30d: 0 };

  it("no market → sells only into the buy order (19 140)", () => {
    const r = realisticPrice(q, h, "sell");
    expect(r.price).toBe(19_140);
    expect(r.raw).toBe(220_000_000);
    expect(r.flags.map((f) => f.kind)).toEqual(["no_market", "wide_spread"]);
  });

  it("a margin built on it stays real, not 900%+", () => {
    const cost = 85_700_000; // adjusted price as a stand-in for the build cost
    const margin = (p: number) => (p - cost) / cost;
    expect(margin(realisticPrice(q, h, "sell").price!)).toBeLessThan(0);
    expect(margin(220_000_000)).toBeGreaterThan(1.5);
  });

  it("no buy orders either → 0", () => {
    expect(realisticPrice(quote(220_000_000, null), h, "sell").price).toBe(0);
  });
});

describe("realisticPrice: Small Explosive Shield Reinforcer II (wall at 19.87M, traded at 1.56M)", () => {
  const q = quote(19_870_000, 1_800_000);
  const h: MarketHistory = { vwap7d: 1_559_900, vwap30d: 1_274_336, median30d: 1_270_000, daysTraded7d: 7, daysTraded30d: 30 };
  const cap = 1_559_900 * (1 + MARKET_SANITY.maxPremium);

  it("sell: capped at the 7-day VWAP + 15%, flagged ×12.7", () => {
    const r = realisticPrice(q, h, "sell");
    expect(r.price).toBeCloseTo(cap);
    expect(r.ref).toBe(1_559_900);
    expect(r.flags[0]).toMatchObject({ kind: "spike", label: "цена выше истории ×12.7" });
    expect(r.flags.map((f) => f.kind)).toContain("wide_spread");
  });

  it("buy: the buy order is also capped by history", () => {
    expect(realisticPrice(q, h, "buy").price).toBeCloseTo(Math.min(1_800_000, cap));
  });

  it("split: middle of buy and the realistic sell", () => {
    expect(realisticPrice(q, h, "split").price).toBeCloseTo((Math.min(1_800_000, cap) + cap) / 2);
  });
});

describe("realisticPrice: a normal item", () => {
  it("sell_min within +15% of history → sell_min, no flags", () => {
    const r = realisticPrice(quote(1_100_000, 1_000_000), liquid(1_000_000), "sell");
    expect(r).toMatchObject({ price: 1_100_000, raw: 1_100_000, checked: true, flags: [] });
  });

  it("all three modes on a normal book", () => {
    const q = quote(1_050_000, 1_000_000);
    expect(realisticPrice(q, liquid(1_020_000), "sell").price).toBe(1_050_000);
    expect(realisticPrice(q, liquid(1_020_000), "buy").price).toBe(1_000_000);
    expect(realisticPrice(q, liquid(1_020_000), "split").price).toBe(1_025_000);
  });
});

describe("realisticPrice: edge cases", () => {
  it("empty sell side but a live market → listed at the reference", () => {
    expect(realisticPrice(quote(null, 900), liquid(1000), "sell").price).toBe(1000);
  });

  it("no buy orders: buy mode has no price; split falls back to the realistic sell", () => {
    expect(realisticPrice(quote(1000, null), liquid(1000), "buy").price).toBeNull();
    expect(realisticPrice(quote(1000, null), liquid(1000), "split").price).toBe(1000);
  });

  it("history not loaded yet → the order book as is, unchecked", () => {
    expect(realisticPrice(quote(220_000_000, 19_140), undefined, "sell")).toMatchObject({ price: 220_000_000, checked: false, flags: [] });
    expect(realisticPrice(undefined, null, "sell").price).toBeNull();
  });

  it("few days in the last week → 30-day VWAP, then the median", () => {
    const h: MarketHistory = { vwap7d: 5000, vwap30d: 1000, median30d: 900, daysTraded7d: 2, daysTraded30d: 15 };
    expect(referencePrice(h)).toBe(1000);
    expect(referencePrice({ ...h, vwap30d: null })).toBe(900);
  });

  it("thresholds come from the config", () => {
    const h: MarketHistory = { ...liquid(1000), daysTraded30d: 5 };
    expect(realisticPrice(quote(1000, 800), h, "sell").flags[0].kind).toBe("no_market");
    expect(realisticPrice(quote(1000, 800), h, "sell", { ...MARKET_SANITY, minDaysTraded30: 5 }).flags).toEqual([]);
  });
});

describe("materialFlags (the price is never replaced)", () => {
  it("not on sale / far above history / fine", () => {
    expect(materialFlags(quote(null, 10), liquid(100), "sell")).toEqual([{ kind: "not_for_sale", label: "нет в продаже" }]);
    expect(materialFlags(quote(400, 10), liquid(100), "sell")[0]).toMatchObject({ kind: "spike", label: "дороже истории ×4.0" });
    expect(materialFlags(quote(120, 10), liquid(100), "sell")).toEqual([]);
    expect(materialFlags(quote(400, 10), undefined, "sell")).toEqual([]);
  });
});
