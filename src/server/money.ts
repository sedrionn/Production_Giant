/**
 * Money side of a character (stage 3): wallet journal and transactions, market orders,
 * contracts, balance. Everything is upserted and never cleared, so the history grows past
 * ESI's windows (journal 30 days, transactions ~2500 rows, closed orders 90 days).
 */
import { eq } from "drizzle-orm";
import { characters, contracts, marketOrders, walletBalances, walletJournal, walletTransactions } from "@/db/schema";
import { EsiError, esiGet, esiGetAllPages } from "@/esi/client";
import { getDb } from "./data";

export const MONEY_SCOPES = {
  wallet: "esi-wallet.read_character_wallet.v1",
  orders: "esi-markets.read_character_orders.v1",
  contracts: "esi-contracts.read_character_contracts.v1",
} as const;

// ---- ESI shapes (subset, per the ESI swagger) --------------------------------

export interface EsiJournalEntry {
  id: number;
  date: string;
  ref_type: string;
  amount?: number;
  balance?: number;
  description: string;
  first_party_id?: number;
  second_party_id?: number;
  context_id?: number;
  context_id_type?: string;
  reason?: string;
  tax?: number;
}
export interface EsiTransaction {
  transaction_id: number;
  date: string;
  type_id: number;
  quantity: number;
  unit_price: number;
  is_buy: boolean;
  is_personal: boolean;
  location_id: number;
  client_id: number;
  journal_ref_id: number;
}
export interface EsiCharacterOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  region_id: number;
  is_buy_order?: boolean;
  price: number;
  volume_total: number;
  volume_remain: number;
  issued: string;
  duration: number;
  escrow?: number;
  /** Only in /orders/history/: cancelled | expired. Open orders have none. */
  state?: string;
}
export interface EsiContract {
  contract_id: number;
  type: string;
  status: string;
  issuer_id: number;
  acceptor_id?: number;
  for_corporation: boolean;
  price?: number;
  reward?: number;
  collateral?: number;
  volume?: number;
  start_location_id?: number;
  end_location_id?: number;
  title?: string;
  date_issued: string;
  date_completed?: string;
}

/** Injectable for tests; default talks to ESI. */
export interface MoneyApi {
  balance(id: number, t: string): Promise<number>;
  journal(id: number, t: string): Promise<EsiJournalEntry[]>;
  transactions(id: number, t: string): Promise<EsiTransaction[]>;
  orders(id: number, t: string): Promise<EsiCharacterOrder[]>;
  orderHistory(id: number, t: string): Promise<EsiCharacterOrder[]>;
  contracts(id: number, t: string): Promise<EsiContract[]>;
}

export const esiMoneyApi: MoneyApi = {
  balance: (id, t) => esiGet(`/characters/${id}/wallet/`, {}, t),
  journal: (id, t) => esiGetAllPages(`/characters/${id}/wallet/journal/`, {}, t),
  transactions: (id, t) => esiGet(`/characters/${id}/wallet/transactions/`, {}, t),
  orders: (id, t) => esiGet(`/characters/${id}/orders/`, {}, t),
  orderHistory: (id, t) => esiGetAllPages(`/characters/${id}/orders/history/`, {}, t),
  contracts: (id, t) => esiGetAllPages(`/characters/${id}/contracts/`, {}, t),
};

export interface MoneySyncResult {
  journal: number;
  transactions: number;
  orders: number;
  contracts: number;
  balance: number | null;
  notes: string[];
}

/** Pulls whatever the character's token allows; a missing scope is a note, not an error. */
export async function syncMoney(characterId: number, token: string, api: MoneyApi = esiMoneyApi): Promise<MoneySyncResult> {
  const db = getDb();
  const c = db.select().from(characters).where(eq(characters.characterId, characterId)).get();
  if (!c) throw new Error(`Персонаж ${characterId} не найден`);
  const has = (s: string) => c.scopes.includes(s);
  const notes: string[] = [];
  const missing = Object.values(MONEY_SCOPES).filter((s) => !has(s));
  if (missing.length) notes.push("Нет доступа к кошельку, ордерам или контрактам — перезайди этим персонажем на странице «Персонажи»");

  const soft = <T>(p: Promise<T>, what: string, fallback: T): Promise<T> =>
    p.catch((e) => {
      notes.push(e instanceof EsiError && e.status === 403 ? `${what}: нет доступа — перезайди персонажем` : `${what} не загрузились: ${(e as Error).message}`);
      return fallback;
    });

  const [balance, journal, txs] = has(MONEY_SCOPES.wallet)
    ? await Promise.all([
        soft(api.balance(characterId, token), "Баланс", null as number | null),
        soft(api.journal(characterId, token), "Журнал кошелька", [] as EsiJournalEntry[]),
        soft(api.transactions(characterId, token), "Сделки", [] as EsiTransaction[]),
      ])
    : [null, [], []];
  const [open, closed] = has(MONEY_SCOPES.orders)
    ? await Promise.all([
        soft(api.orders(characterId, token), "Ордера", [] as EsiCharacterOrder[]),
        soft(api.orderHistory(characterId, token), "История ордеров", [] as EsiCharacterOrder[]),
      ])
    : [[], []];
  const cons = has(MONEY_SCOPES.contracts) ? await soft(api.contracts(characterId, token), "Контракты", [] as EsiContract[]) : [];

  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const j of journal) {
      const v = {
        characterId,
        date: j.date,
        refType: j.ref_type,
        amount: j.amount ?? 0,
        balance: j.balance ?? null,
        description: j.description ?? "",
        firstPartyId: j.first_party_id ?? null,
        secondPartyId: j.second_party_id ?? null,
        contextId: j.context_id ?? null,
        contextIdType: j.context_id_type ?? null,
        reason: j.reason ?? null,
        tax: j.tax ?? null,
      };
      tx.insert(walletJournal).values({ id: j.id, ...v }).onConflictDoUpdate({ target: walletJournal.id, set: v }).run();
    }
    for (const t of txs) {
      const v = {
        characterId,
        date: t.date,
        typeId: t.type_id,
        quantity: t.quantity,
        unitPrice: t.unit_price,
        isBuy: t.is_buy,
        isPersonal: t.is_personal,
        locationId: t.location_id,
        clientId: t.client_id ?? null,
        journalRefId: t.journal_ref_id ?? null,
      };
      tx.insert(walletTransactions).values({ transactionId: t.transaction_id, ...v }).onConflictDoUpdate({ target: walletTransactions.transactionId, set: v }).run();
    }
    // An order missing from both lists is gone (filled orders leave /orders/ and may lag in history).
    const seen = new Set<number>();
    const putOrder = (o: EsiCharacterOrder, state: string) => {
      seen.add(o.order_id);
      const v = {
        characterId,
        typeId: o.type_id,
        locationId: o.location_id,
        regionId: o.region_id,
        isBuy: o.is_buy_order ?? false,
        price: o.price,
        volumeTotal: o.volume_total,
        volumeRemain: o.volume_remain,
        issued: o.issued,
        duration: o.duration,
        escrow: o.escrow ?? null,
        state,
        updatedAt: now,
      };
      tx.insert(marketOrders).values({ orderId: o.order_id, ...v }).onConflictDoUpdate({ target: marketOrders.orderId, set: v }).run();
    };
    // History marks a fully sold order "expired" too; volume_remain 0 tells it apart.
    for (const o of closed) putOrder(o, o.volume_remain === 0 ? "filled" : o.state ?? "closed");
    for (const o of open) putOrder(o, "open");
    if (has(MONEY_SCOPES.orders) && notes.every((n) => !n.startsWith("Ордера"))) {
      // Orders we still think are open but ESI no longer lists: filled or gone.
      for (const o of tx.select().from(marketOrders).where(eq(marketOrders.characterId, characterId)).all()) {
        if (o.state === "open" && !seen.has(o.orderId)) tx.update(marketOrders).set({ state: "filled", updatedAt: now }).where(eq(marketOrders.orderId, o.orderId)).run();
      }
    }
    for (const k of cons) {
      const v = {
        characterId,
        type: k.type,
        status: k.status,
        issuerId: k.issuer_id,
        acceptorId: k.acceptor_id ?? null,
        forCorporation: k.for_corporation,
        price: k.price ?? null,
        reward: k.reward ?? null,
        collateral: k.collateral ?? null,
        volume: k.volume ?? null,
        startLocationId: k.start_location_id ?? null,
        endLocationId: k.end_location_id ?? null,
        title: k.title ?? null,
        dateIssued: k.date_issued,
        dateCompleted: k.date_completed ?? null,
      };
      tx.insert(contracts).values({ contractId: k.contract_id, ...v }).onConflictDoUpdate({ target: contracts.contractId, set: v }).run();
    }
    if (balance !== null) tx.insert(walletBalances).values({ characterId, at: now, balance }).onConflictDoNothing().run();
  });

  return { journal: journal.length, transactions: txs.length, orders: open.length + closed.length, contracts: cons.length, balance, notes };
}
