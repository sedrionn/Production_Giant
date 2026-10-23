import { describe, expect, it } from "vitest";
import {
  acquisitionFeeRate,
  brokerFeeFromSkills,
  buyOrderAdvice,
  BUY_ORDER,
  quotePrice,
  saleFeeRate,
  salesTaxFromSkills,
  type MarketQuote,
  type PriceMode,
} from "@/engine/pricing";

const q: MarketQuote = { typeId: 1, buyMax: 90, sellMin: 110 };
const fees = { salesTax: 0.04, brokerFee: 0.01 };

describe("quotePrice", () => {
  it.each<[PriceMode, number]>([
    ["buy", 90],
    ["sell", 110],
    ["split", 100],
  ])("%s → %d", (mode, expected) => {
    expect(quotePrice(q, mode)).toBe(expected);
  });

  it("split falls back to the side that exists", () => {
    expect(quotePrice({ typeId: 1, buyMax: null, sellMin: 50 }, "split")).toBe(50);
    expect(quotePrice({ typeId: 1, buyMax: 40, sellMin: null }, "split")).toBe(40);
  });

  it("missing quote / missing side → null", () => {
    expect(quotePrice(undefined, "sell")).toBeNull();
    expect(quotePrice({ typeId: 1, buyMax: null, sellMin: 50 }, "buy")).toBeNull();
  });
});

describe("fee rules — all mode combinations", () => {
  it.each<[PriceMode, number]>([
    ["sell", 0],
    ["buy", 0.01],
    ["split", 0.01],
  ])("acquire via %s → %d", (mode, expected) => {
    expect(acquisitionFeeRate(mode, fees)).toBe(expected);
  });

  it.each<[PriceMode, number]>([
    ["buy", 0.04],
    ["sell", 0.05],
    ["split", 0.05],
  ])("sell via %s → %d", (mode, expected) => {
    expect(saleFeeRate(mode, fees)).toBeCloseTo(expected);
  });
});

describe("skill-based fees", () => {
  it("Accounting V", () => {
    expect(salesTaxFromSkills(5)).toBeCloseTo(0.075 * 0.45);
  });
  it("Broker Relations V, no standings", () => {
    expect(brokerFeeFromSkills(5)).toBeCloseTo(0.015);
  });
  it("never negative", () => {
    expect(brokerFeeFromSkills(5, 10, 10)).toBeGreaterThanOrEqual(0);
  });
});

describe("buyOrderAdvice (SYNTHETIC quotes)", () => {
  const fees = { salesTax: 0.03375, brokerFee: 0.015 };
  const q = { typeId: 1, buyMax: 100_000, sellMin: 500_000 };

  it("a wide spread on a big enough line: bid the best buy order, saving net of the broker fee", () => {
    const a = buyOrderAdvice(q, 10, fees)!;
    expect(a.price).toBe(100_000);
    expect(a.saving).toBeCloseTo(10 * (500_000 - 100_000 * 1.015));
    expect(a.days).toBeNull();
  });

  it("too small, too thin a spread, or too slow to fill → no advice", () => {
    expect(buyOrderAdvice(q, 1, fees)).toBeNull(); // saves < 1M
    expect(buyOrderAdvice({ ...q, buyMax: 490_000 }, 1000, fees)).toBeNull(); // < 5%
    expect(buyOrderAdvice(q, 10, fees, 1)).toBeNull(); // 10 days at 1 a day
    expect(buyOrderAdvice(q, 10, fees, 10)!.days).toBe(1);
    expect(buyOrderAdvice({ ...q, buyMax: null }, 10, fees)).toBeNull();
    expect(BUY_ORDER.maxDays).toBe(7);
  });
});
