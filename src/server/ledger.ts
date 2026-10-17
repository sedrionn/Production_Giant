/** Ledger page data: cash summary, per-item production/sales, alerts. Reads the app DB. */
import { and, eq, inArray } from "drizzle-orm";
import { characters, industryJobs, marketOrders, walletBalances, walletJournal, walletTransactions } from "@/db/schema";
import { cashSummary, itemLedger, PRODUCING_ACTIVITIES, undercutOrders, type CashSummary, type ItemLedgerRow, type OrderAlert } from "@/engine/ledger";
import { calculate } from "./calculate";
import { getDb, getSde, getSettings, priceBook } from "./data";
import { MONEY_SCOPES } from "./money";

export interface LedgerCharacter {
  characterId: number;
  name: string;
  balance: number | null;
  balanceAt: string | null;
  /** False until the character logs in again with the wallet/orders/contracts scopes. */
  moneyAccess: boolean;
}

export interface LedgerItem extends ItemLedgerRow {
  name: string;
  /** Our calculated cost per unit today (batch = typical job runs); null if not buildable/unpriced. */
  estUnitCost: number | null;
  /** (avg sell price after tax and broker − estimated cost) / estimated cost. */
  realisedMargin: number | null;
  /** Jita best sell now, for comparison with what you got. */
  marketPrice: number | null;
  /** Units still on your open sell orders. */
  onSale: number;
}

export interface Ledger {
  from: string | null;
  to: string;
  characters: LedgerCharacter[];
  totalBalance: number | null;
  cash: CashSummary;
  items: LedgerItem[];
  alerts: {
    undercut: (OrderAlert & { name: string })[];
    /** Running jobs whose product would lose money at today's prices. */
    losingJobs: { jobId: number; typeId: number; name: string; runs: number; endDate: string; profit: number }[];
  };
  /** Market data the alerts compare against (Jita, price cache). */
  pricesOldest: string | null;
}

const DAY = 86_400_000;

export function buildLedger(days: number | null): Ledger {
  const db = getDb();
  const { source: sde } = getSde();
  const s = getSettings();
  const name = (id: number) => sde.getType(id)?.name ?? `#${id}`;
  const to = new Date().toISOString();
  const from = days ? new Date(Date.now() - days * DAY).toISOString() : null;

  const chars = db.select().from(characters).all();
  const ownIds = new Set(chars.map((c) => c.characterId));
  const charRows: LedgerCharacter[] = chars.map((c) => {
    const last = db
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.characterId, c.characterId))
      .all()
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    return {
      characterId: c.characterId,
      name: c.name,
      balance: last?.balance ?? null,
      balanceAt: last?.at ?? null,
      moneyAccess: Object.values(MONEY_SCOPES).every((x) => c.scopes.includes(x)),
    };
  });
  const balances = charRows.filter((c) => c.balance !== null);

  const journal = db.select().from(walletJournal).all();
  const cash = cashSummary(journal, ownIds, from ?? undefined, to);

  const txs = db.select().from(walletTransactions).where(eq(walletTransactions.isPersonal, true)).all();
  const jobs = db.select().from(industryJobs).all();
  const unitsPerRun = (bp: number, product: number | null) => {
    const b = sde.getBlueprint(bp);
    const act = b?.activities.manufacturing ?? b?.activities.reaction;
    return act?.products.find((p) => p.typeId === product)?.quantity ?? 1;
  };
  const finished = jobs
    .filter((j) => j.status === "delivered" || j.status === "ready")
    .map((j) => ({
      productTypeId: j.productTypeId,
      activityId: j.activityId,
      runs: j.runs,
      successfulRuns: j.successfulRuns,
      unitsPerRun: unitsPerRun(j.blueprintTypeId, j.productTypeId),
      cost: j.cost,
      date: j.completedDate ?? j.endDate,
    }));
  const rows = itemLedger(txs, finished, from ?? undefined, to);

  const openOrders = db.select().from(marketOrders).where(eq(marketOrders.state, "open")).all();
  const hubOrders = openOrders.filter((o) => o.locationId === s.priceLocationId);
  const running = jobs.filter((j) => j.status === "active" && j.productTypeId && PRODUCING_ACTIVITIES.has(j.activityId));
  const prices = priceBook([...rows.map((r) => r.typeId), ...openOrders.map((o) => o.typeId)], s.priceLocationId);

  const fee = s.salesTax + s.brokerFee;
  const typicalRuns = (typeId: number) => {
    const mine = jobs.filter((j) => j.productTypeId === typeId && PRODUCING_ACTIVITIES.has(j.activityId)).map((j) => j.runs);
    return mine.length ? Math.max(1, Math.round(mine.reduce((a, b) => a + b, 0) / mine.length)) : 1;
  };
  const estCost = new Map<number, number | null>();
  const unitCost = (typeId: number) => {
    if (!estCost.has(typeId)) {
      try {
        estCost.set(typeId, calculate({ typeId, runs: typicalRuns(typeId) }).summary.costPerUnit || null);
      } catch {
        estCost.set(typeId, null);
      }
    }
    return estCost.get(typeId)!;
  };

  const items: LedgerItem[] = rows
    .filter((r) => r.sold || r.built)
    .map((r) => {
      const est = r.built || r.sold ? unitCost(r.typeId) : null;
      const net = r.avgSellPrice === null ? null : r.avgSellPrice * (1 - fee);
      return {
        ...r,
        name: name(r.typeId),
        estUnitCost: est,
        realisedMargin: net !== null && est ? (net - est) / est : null,
        marketPrice: prices.quote(r.typeId)?.sellMin ?? null,
        onSale: openOrders.filter((o) => o.typeId === r.typeId && !o.isBuy).reduce((a, o) => a + o.volumeRemain, 0),
      };
    })
    .sort((a, b) => b.soldIsk - a.soldIsk || b.built - a.built);

  const undercut = undercutOrders(hubOrders, (id) => prices.quote(id)).map((a) => ({ ...a, name: name(a.typeId) }));

  const losingJobs: Ledger["alerts"]["losingJobs"] = [];
  for (const j of running) {
    try {
      const r = calculate({ typeId: j.productTypeId!, runs: Math.max(1, j.runs), blueprintSource: "owned" });
      if (r.summary.profit !== null && r.summary.profit < 0) {
        losingJobs.push({ jobId: j.jobId, typeId: j.productTypeId!, name: name(j.productTypeId!), runs: j.runs, endDate: j.endDate, profit: r.summary.profit });
      }
    } catch {
      /* not calculable — skip */
    }
  }

  return {
    from,
    to,
    characters: charRows,
    totalBalance: balances.length ? balances.reduce((a, c) => a + (c.balance ?? 0), 0) : null,
    cash,
    items,
    alerts: { undercut, losingJobs },
    pricesOldest: prices.meta().oldest,
  };
}

/** Type ids the ledger compares against the market (refresh these with prices). */
export function ledgerPriceTypes(): number[] {
  const db = getDb();
  const open = db.select({ t: marketOrders.typeId }).from(marketOrders).where(eq(marketOrders.state, "open")).all();
  const active = db
    .select({ t: industryJobs.productTypeId })
    .from(industryJobs)
    .where(and(eq(industryJobs.status, "active"), inArray(industryJobs.activityId, [...PRODUCING_ACTIVITIES])))
    .all();
  return [...new Set([...open.map((r) => r.t), ...active.map((r) => r.t).filter((t): t is number => t !== null)])];
}
