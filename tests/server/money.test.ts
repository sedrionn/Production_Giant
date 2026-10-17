import { beforeAll, describe, expect, it } from "vitest";
import type { MoneyApi } from "@/server/money";

process.env.PG_SDE = "fixtures";
process.env.PG_APP_DB = ":memory:";
process.env.PG_SECRET_KEY = "test-key";
process.env.EVE_CLIENT_ID = "client123";
process.env.EVE_CLIENT_SECRET = "secret456";

let ch: typeof import("@/server/characters");
let money: typeof import("@/server/money");
let ledger: typeof import("@/server/ledger");
let sso: typeof import("@/esi/sso");

// SYNTHETIC ESI payloads in the documented shapes. Two own characters; ALT gets ISK from NICK.
const NICK = 90000001;
const ALT = 90000002;
const JACKDAW = 34828;
const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const api = (): MoneyApi => ({
  balance: async () => 1_500_000_000,
  journal: async () => [
    { id: 1, date: recent(2), ref_type: "market_transaction", amount: 300_000_000, description: "sold", first_party_id: 123, second_party_id: NICK },
    { id: 2, date: recent(2), ref_type: "transaction_tax", amount: -10_125_000, description: "tax" },
    { id: 3, date: recent(3), ref_type: "brokers_fee", amount: -4_500_000, description: "broker" },
    { id: 4, date: recent(5), ref_type: "industry_job_tax", amount: -20_000_000, description: "job" },
    { id: 5, date: recent(4), ref_type: "contract_reward", amount: -60_000_000, description: "courier" },
    { id: 6, date: recent(1), ref_type: "player_donation", amount: -100_000_000, description: "to alt", first_party_id: NICK, second_party_id: ALT },
    { id: 7, date: recent(6), ref_type: "market_transaction", amount: -50_000_000, description: "bought" },
    { id: 8, date: recent(60), ref_type: "market_transaction", amount: 999_000_000, description: "old sale" },
    { id: 9, date: recent(2), ref_type: "planetary_import_tax", amount: -1_000_000, description: "pi" },
  ],
  transactions: async () => [
    { transaction_id: 11, date: recent(2), type_id: JACKDAW, quantity: 5, unit_price: 60_000_000, is_buy: false, is_personal: true, location_id: 60003760, client_id: 123, journal_ref_id: 1 },
  ],
  orders: async () => [
    { order_id: 21, type_id: JACKDAW, location_id: 60003760, region_id: 10000002, price: 70_000_000, volume_total: 10, volume_remain: 4, issued: recent(3), duration: 90 },
  ],
  orderHistory: async () => [
    { order_id: 22, type_id: JACKDAW, location_id: 60003760, region_id: 10000002, price: 60_000_000, volume_total: 5, volume_remain: 0, issued: recent(10), duration: 90, state: "expired" },
  ],
  contracts: async () => [
    { contract_id: 31, type: "courier", status: "finished", issuer_id: NICK, for_corporation: false, reward: 60_000_000, collateral: 1e9, volume: 180_000, date_issued: recent(4), date_completed: recent(3) },
  ],
});

beforeAll(async () => {
  ch = await import("@/server/characters");
  money = await import("@/server/money");
  ledger = await import("@/server/ledger");
  sso = await import("@/esi/sso");
  const tokens = { access_token: "tok", expires_in: 1200, token_type: "Bearer", refresh_token: "ref" };
  ch.saveCharacter({ characterId: NICK, name: "Nick", scopes: sso.SCOPES, expiresAt: 0 }, tokens, null);
  ch.saveCharacter({ characterId: ALT, name: "Alt", scopes: [], expiresAt: 0 }, tokens, null);
});

describe("money sync (SYNTHETIC ESI)", () => {
  it("stores journal, transactions, orders, contracts and balance", async () => {
    const r = await money.syncMoney(NICK, "tok", api());
    expect(r).toMatchObject({ journal: 9, transactions: 1, orders: 2, contracts: 1, balance: 1_500_000_000, notes: [] });
  });

  it("re-sync is idempotent (upsert, no duplicates)", async () => {
    await money.syncMoney(NICK, "tok", api());
    const l = ledger.buildLedger(null);
    expect(l.cash.entries).toBe(9);
  });

  it("character without the new scopes gets a note and no calls", async () => {
    const r = await money.syncMoney(ALT, "tok", { ...api(), balance: async () => { throw new Error("must not be called"); } });
    expect(r.notes.join(" ")).toMatch(/перезайди/);
    expect(r.balance).toBeNull();
  });
});

describe("ledger", () => {
  it("cash for 30 days: categories, internal transfer excluded, old entries out", () => {
    const l = ledger.buildLedger(30);
    const c = l.cash.byCategory;
    expect(c.sales).toBe(300_000_000);
    expect(c.purchases).toBe(-50_000_000);
    expect(c.market_fees).toBe(-14_625_000);
    expect(c.industry).toBe(-20_000_000);
    expect(c.contracts).toBe(-60_000_000);
    expect(c.internal).toBe(-100_000_000);
    expect(l.cash.otherRefTypes).toEqual({ planetary_import_tax: -1_000_000 });
    expect(l.cash.net).toBe(300_000_000 - 50_000_000 - 14_625_000 - 20_000_000 - 60_000_000 - 1_000_000);
  });

  it("all time includes the old sale", () => {
    expect(ledger.buildLedger(null).cash.byCategory.sales).toBe(1_299_000_000);
  });

  it("per item: sold units, average price, units on sale", () => {
    const item = ledger.buildLedger(30).items.find((i) => i.typeId === JACKDAW)!;
    expect(item).toMatchObject({ sold: 5, soldIsk: 300_000_000, avgSellPrice: 60_000_000, onSale: 4 });
  });

  it("characters: balance and who still needs to log in again", () => {
    const l = ledger.buildLedger(30);
    expect(l.totalBalance).toBe(1_500_000_000);
    expect(l.characters.find((c) => c.characterId === ALT)?.moneyAccess).toBe(false);
    expect(l.characters.find((c) => c.characterId === NICK)?.moneyAccess).toBe(true);
  });
});
