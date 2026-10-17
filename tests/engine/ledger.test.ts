import { describe, expect, it } from "vitest";
import { categorize, itemLedger, undercutOrders } from "@/engine/ledger";

// SYNTHETIC rows.
const own = new Set([1, 2]);
const j = (refType: string, amount: number, a: number | null = null, b: number | null = null) => ({ characterId: 1, date: "2026-10-10", refType, amount, firstPartyId: a, secondPartyId: b });

describe("categorize", () => {
  it("market by sign, fees, industry, contracts", () => {
    expect(categorize(j("market_transaction", 5), own)).toBe("sales");
    expect(categorize(j("market_transaction", -5), own)).toBe("purchases");
    expect(categorize(j("market_escrow", -5), own)).toBe("purchases");
    expect(categorize(j("brokers_fee", -1), own)).toBe("market_fees");
    expect(categorize(j("transaction_tax", -1), own)).toBe("market_fees");
    expect(categorize(j("industry_job_tax", -1), own)).toBe("industry");
    expect(categorize(j("reaction", -1), own)).toBe("industry");
    expect(categorize(j("contract_reward", -1), own)).toBe("contracts");
    expect(categorize(j("bounty_prizes", 1), own)).toBe("other");
  });
  it("transfers between own characters are internal; to strangers are not", () => {
    expect(categorize(j("player_donation", -5, 1, 2), own)).toBe("internal");
    expect(categorize(j("player_donation", -5, 1, 99), own)).toBe("other");
  });
});

describe("itemLedger", () => {
  it("built units = runs × units per run for manufacturing/reactions only", () => {
    const rows = itemLedger(
      [],
      [
        { productTypeId: 7, activityId: 11, runs: 3, successfulRuns: null, unitsPerRun: 200, cost: 10, date: "2026-10-10" },
        { productTypeId: 8, activityId: 8, runs: 10, successfulRuns: 4, unitsPerRun: 1, cost: 5, date: "2026-10-10" },
      ],
    );
    expect(rows).toEqual([expect.objectContaining({ typeId: 7, built: 600, jobCost: 10 })]);
  });
});

describe("undercutOrders", () => {
  const best = () => ({ buyMax: 90, sellMin: 100 });
  it("sell above best ask and buy below best bid are flagged", () => {
    const a = undercutOrders(
      [
        { orderId: 1, typeId: 1, isBuy: false, price: 105, volumeRemain: 1 },
        { orderId: 2, typeId: 1, isBuy: false, price: 100, volumeRemain: 1 },
        { orderId: 3, typeId: 1, isBuy: true, price: 85, volumeRemain: 1 },
        { orderId: 4, typeId: 1, isBuy: true, price: 90, volumeRemain: 1 },
      ],
      best,
    );
    expect(a.map((x) => x.orderId)).toEqual([1, 3]);
  });
});
