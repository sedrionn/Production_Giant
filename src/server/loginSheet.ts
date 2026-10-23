/**
 * One page per login: what to deliver, start, sell and fix right now. Combines the saved plan
 * (what was planned for this login) with live data synced from the game (jobs, slots, hangars,
 * orders). Reads the app DB.
 */
import { eq } from "drizzle-orm";
import { characters, industryJobs, marketOrders } from "@/db/schema";
import { currentLogin } from "@/engine/planner";
import { undercutOrders, type OrderAlert } from "@/engine/ledger";
import type { Stages } from "@/engine/stages";
import { stockIndex } from "./assets";
import { getDb, getSde, getSettings, priceBook } from "./data";
import { characterSlots, type SlotSummary } from "./plan";
import { loginsOf, savedPlanView, type SavedLogin } from "./savedPlan";

export interface LoginSheet {
  plan: { id: number; title: string; createdAt: string; cadenceDays: number; horizonDays: number } | null;
  /** Days since the plan was saved. */
  planDay: number;
  /** All logins of the plan and the one shown (index). */
  logins: SavedLogin[];
  current: number;
  /** Finished jobs waiting to be delivered, per character (from the game). */
  deliver: { owner: string; items: { name: string; runs: number; jobs: number }[] }[];
  /** Slots per character right now (busy = running, not finished). */
  slots: SlotSummary[];
  /** Products of the plan lying in the stock hangars: to sell / haul to Jita. */
  sell: { typeId: number; name: string; quantity: number; price: number | null }[];
  /** Your orders at the hub that someone has beaten. */
  undercut: (OrderAlert & { name: string })[];
  /** Purchase list of the saved plan (as saved). */
  buy: Stages | null;
  syncedAt: string | null;
}

const DAY = 86_400_000;

export function loginSheet(day?: number, now = Date.now()): LoginSheet {
  const db = getDb();
  const s = getSettings();
  const { source: sde } = getSde();
  const name = (id: number) => sde.getType(id)?.name ?? `#${id}`;
  const view = savedPlanView();
  const chars = db.select().from(characters).all();
  const who = new Map(chars.map((c) => [c.characterId, c.name]));

  const planDay = view ? (now - Date.parse(view.createdAt)) / DAY : 0;
  const logins = view ? loginsOf(view.data) : [];
  const shown = logins.findIndex((l) => l.day === day);
  const current = shown >= 0 ? shown : view ? currentLogin(logins.map((l) => l.day), planDay, view.data.request.cadenceDays) : 0;

  // Finished but not delivered jobs are still "active" in ESI.
  const ready = new Map<string, Map<string, { name: string; runs: number; jobs: number }>>();
  for (const j of db.select().from(industryJobs).all()) {
    if (j.status !== "active" || Date.parse(j.endDate) > now) continue;
    const owner = who.get(j.installerId) ?? `#${j.installerId}`;
    const item = j.productTypeId ? name(j.productTypeId) : name(j.blueprintTypeId);
    const m = ready.get(owner) ?? new Map();
    const x = m.get(item) ?? { name: item, runs: 0, jobs: 0 };
    x.runs += j.runs;
    x.jobs++;
    m.set(item, x);
    ready.set(owner, m);
  }

  const products = new Set(view?.data.batches.map((b) => b.typeId) ?? []);
  const { stock } = stockIndex();
  const onHand = [...products].filter((id) => (stock.get(id) ?? 0) > 0);
  const openOrders = db.select().from(marketOrders).where(eq(marketOrders.state, "open")).all();
  const hub = openOrders.filter((o) => o.locationId === s.priceLocationId);
  const prices = priceBook([...onHand, ...hub.map((o) => o.typeId)], s.priceLocationId);

  return {
    plan: view && { id: view.id, title: view.title, createdAt: view.createdAt, cadenceDays: view.data.request.cadenceDays, horizonDays: view.data.request.horizonDays },
    planDay,
    logins,
    current,
    deliver: [...ready.entries()].map(([owner, m]) => ({ owner, items: [...m.values()] })),
    slots: characterSlots(now).summary,
    sell: onHand.map((id) => ({ typeId: id, name: name(id), quantity: stock.get(id)!, price: prices.quote(id)?.sellMin ?? null })).sort((a, b) => (b.price ?? 0) * b.quantity - (a.price ?? 0) * a.quantity),
    undercut: undercutOrders(hub, (id) => prices.quote(id)).map((a) => ({ ...a, name: name(a.typeId) })),
    buy: view?.data.stages ?? null,
    syncedAt: chars.map((c) => c.lastSyncAt).filter((x): x is string => !!x).sort()[0] ?? null,
  };
}
