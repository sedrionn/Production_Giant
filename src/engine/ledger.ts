/**
 * Money ledger (stage 3): where the ISK went, from wallet rows. Pure — rows come in as arguments.
 *
 * Cash view: the wallet journal is the truth for totals (every ISK that moved), split into
 * categories by ref_type. Item view: market transactions + finished industry jobs per type.
 */
import { JOB_ACTIVITY_IDS } from "./bonuses";

export type LedgerCategory = "sales" | "purchases" | "market_fees" | "industry" | "contracts" | "internal" | "other";

export const CATEGORY_LABEL: Record<LedgerCategory, string> = {
  sales: "Продажи",
  purchases: "Покупки",
  market_fees: "Налог и брокер",
  industry: "Джобы",
  contracts: "Контракты и доставка",
  internal: "Переводы между своими",
  other: "Прочее",
};

export interface JournalRow {
  characterId: number;
  date: string;
  refType: string;
  amount: number;
  firstPartyId: number | null;
  secondPartyId: number | null;
}

/** ref_type → category. Unknown types fall into "other" and are listed by name in the UI. */
export function categorize(row: JournalRow, ownIds: ReadonlySet<number>): LedgerCategory {
  const r = row.refType;
  const own = (id: number | null) => id !== null && ownIds.has(id);
  if (own(row.firstPartyId) && own(row.secondPartyId) && row.firstPartyId !== row.secondPartyId) return "internal";
  if (r === "market_transaction") return row.amount >= 0 ? "sales" : "purchases";
  if (r === "market_escrow") return "purchases";
  if (r === "brokers_fee" || r === "transaction_tax") return "market_fees";
  if (/industry|manufactur|reaction|research|copying|invention|reverse_engineering/.test(r)) return "industry";
  if (/contract|courier/.test(r)) return "contracts";
  return "other";
}

export interface CashSummary {
  /** Sum of every non-internal entry: what the wallets gained (+) or lost (−). */
  net: number;
  byCategory: Record<LedgerCategory, number>;
  /** ref_types that landed in "other", with their sums — to spot what needs its own category. */
  otherRefTypes: Record<string, number>;
  entries: number;
}

export function cashSummary(rows: JournalRow[], ownIds: ReadonlySet<number>, from?: string, to?: string): CashSummary {
  const byCategory = Object.fromEntries(Object.keys(CATEGORY_LABEL).map((k) => [k, 0])) as Record<LedgerCategory, number>;
  const otherRefTypes: Record<string, number> = {};
  let net = 0;
  let entries = 0;
  for (const r of rows) {
    if ((from && r.date < from) || (to && r.date >= to)) continue;
    const c = categorize(r, ownIds);
    byCategory[c] += r.amount;
    entries++;
    if (c === "internal") continue;
    net += r.amount;
    if (c === "other") otherRefTypes[r.refType] = (otherRefTypes[r.refType] ?? 0) + r.amount;
  }
  return { net, byCategory, otherRefTypes, entries };
}

export interface TransactionRow {
  date: string;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
}

export interface FinishedJobRow {
  productTypeId: number | null;
  activityId: number;
  runs: number;
  successfulRuns: number | null;
  /** Units per run of the product (from the blueprint). */
  unitsPerRun: number;
  cost: number | null;
  /** completed_date, else end_date. */
  date: string;
}

export interface ItemLedgerRow {
  typeId: number;
  built: number;
  jobCost: number;
  bought: number;
  boughtIsk: number;
  sold: number;
  soldIsk: number;
  /** Average realised sell price per unit. */
  avgSellPrice: number | null;
  lastSale: string | null;
}

/** Job activities that make items: manufacturing and reactions. */
export const PRODUCING_ACTIVITIES: ReadonlySet<number> = new Set([JOB_ACTIVITY_IDS.manufacturing, ...JOB_ACTIVITY_IDS.reactions]);

export function itemLedger(txs: TransactionRow[], jobs: FinishedJobRow[], from?: string, to?: string): ItemLedgerRow[] {
  const inRange = (d: string) => !((from && d < from) || (to && d >= to));
  const rows = new Map<number, ItemLedgerRow>();
  const row = (typeId: number) => {
    let r = rows.get(typeId);
    if (!r) rows.set(typeId, (r = { typeId, built: 0, jobCost: 0, bought: 0, boughtIsk: 0, sold: 0, soldIsk: 0, avgSellPrice: null, lastSale: null }));
    return r;
  };
  for (const j of jobs) {
    if (!j.productTypeId || !PRODUCING_ACTIVITIES.has(j.activityId) || !inRange(j.date)) continue;
    const r = row(j.productTypeId);
    r.built += (j.successfulRuns ?? j.runs) * j.unitsPerRun;
    r.jobCost += j.cost ?? 0;
  }
  for (const t of txs) {
    if (!inRange(t.date)) continue;
    const r = row(t.typeId);
    if (t.isBuy) {
      r.bought += t.quantity;
      r.boughtIsk += t.quantity * t.unitPrice;
    } else {
      r.sold += t.quantity;
      r.soldIsk += t.quantity * t.unitPrice;
      if (!r.lastSale || t.date > r.lastSale) r.lastSale = t.date;
    }
  }
  for (const r of rows.values()) r.avgSellPrice = r.sold ? r.soldIsk / r.sold : null;
  return [...rows.values()];
}

export interface OpenOrderRow {
  orderId: number;
  typeId: number;
  isBuy: boolean;
  price: number;
  volumeRemain: number;
}

export interface OrderAlert {
  orderId: number;
  typeId: number;
  isBuy: boolean;
  myPrice: number;
  bestPrice: number;
  volumeRemain: number;
}

/** Sell orders priced above the best ask, buy orders below the best bid (at the same hub). */
export function undercutOrders(orders: OpenOrderRow[], best: (typeId: number) => { buyMax: number | null; sellMin: number | null } | undefined): OrderAlert[] {
  const out: OrderAlert[] = [];
  for (const o of orders) {
    const q = best(o.typeId);
    const bestPrice = o.isBuy ? q?.buyMax : q?.sellMin;
    if (bestPrice == null) continue;
    const beaten = o.isBuy ? bestPrice > o.price : bestPrice < o.price;
    if (beaten) out.push({ orderId: o.orderId, typeId: o.typeId, isBuy: o.isBuy, myPrice: o.price, bestPrice, volumeRemain: o.volumeRemain });
  }
  return out;
}
