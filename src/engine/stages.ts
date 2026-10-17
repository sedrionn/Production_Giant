/**
 * Production stages of a plan (like EVE Guru's Production Ledger), with stock taken off.
 *
 * All batches of the plan are merged into one graph. Each built type gets one line per stage,
 * and its depth is the longest path from any product. Stock is used top-down: a component
 * that is already in the hangar is not built, so its own inputs are not bought either. Products
 * (the hulls) are never taken from stock: what is in the hangar is for sale.
 *
 * Quantities scale linearly with runs (inputs per run = the job's input / its runs, rounded up
 * per line). With ME the game rounds per job, so a line can be off by one unit.
 */
import type { Activity } from "./types";

export interface StageRecipe {
  typeId: number;
  name: string;
  activity: Activity;
  outputPerRun: number;
  secondsPerRun: number;
  /** Inputs per run (may be fractional after ME). */
  inputs: { typeId: number; perRun: number }[];
}

export interface StageBuyInfo {
  typeId: number;
  name: string;
  unitPrice: number | null;
  /** m³ per unit. */
  volume: number;
}

export interface StageInput {
  /** One entry per product job of the plan. */
  products: { typeId: number; runs: number }[];
  /** Everything that is built, by type (first recipe wins when batches disagree). */
  recipes: Map<number, StageRecipe>;
  /** Everything that is bought. */
  buy: Map<number, StageBuyInfo>;
  /** Units on hand, by type. */
  stock: Map<number, number>;
  /** Extra purchases outside the build graph (invention: datacores, decryptors). */
  extraBuy?: { typeId: number; quantity: number; note: string }[];
}

export interface StageLine {
  typeId: number;
  name: string;
  activity: Activity;
  depth: number;
  /** Units the stage above needs. */
  need: number;
  fromStock: number;
  runs: number;
  /** Units the jobs make (runs × output, can exceed what's needed). */
  output: number;
  seconds: number;
  isProduct: boolean;
}

export interface BuyLine {
  typeId: number;
  name: string;
  need: number;
  fromStock: number;
  toBuy: number;
  unitPrice: number | null;
  /** toBuy × unitPrice; null when unpriced. */
  cost: number | null;
  /** m³ of what is bought. */
  volume: number;
  note?: string;
}

export interface Stages {
  /** Deepest first: the order to build in. */
  stages: { depth: number; lines: StageLine[] }[];
  buy: BuyLine[];
  /** ISK of purchases saved by stock (bought items only, at market price). */
  savedByStock: number;
  /** Same list without stock, for comparison. */
  costWithoutStock: number;
  costWithStock: number;
}

export function planStages(input: StageInput): Stages {
  const { recipes, buy, stock } = input;

  // Longest path from any product.
  const depth = new Map<number, number>();
  const visit = (id: number, d: number, path: Set<number>) => {
    if (path.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    const r = recipes.get(id);
    if (!r) return;
    path.add(id);
    for (const i of r.inputs) visit(i.typeId, d + 1, path);
    path.delete(id);
  };
  for (const p of input.products) visit(p.typeId, 0, new Set());

  const demand = new Map<number, number>();
  const runsOf = new Map<number, number>();
  const add = (m: Map<number, number>, id: number, q: number) => m.set(id, (m.get(id) ?? 0) + q);
  const productIds = new Set(input.products.map((p) => p.typeId));
  for (const p of input.products) {
    const r = recipes.get(p.typeId);
    add(runsOf, p.typeId, p.runs);
    add(demand, p.typeId, p.runs * (r?.outputPerRun ?? 1));
    // Each product job consumes its own inputs (rounded per job, as in game).
    if (r) for (const i of r.inputs) add(demand, i.typeId, Math.ceil(p.runs * i.perRun - 1e-9));
  }

  const left = new Map(stock);
  const take = (id: number, need: number) => {
    const have = Math.max(0, left.get(id) ?? 0);
    const used = Math.min(have, need);
    left.set(id, have - used);
    return used;
  };

  const order = [...depth.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const lines: StageLine[] = [];
  for (const id of order) {
    const r = recipes.get(id);
    if (!r) continue;
    const d = depth.get(id)!;
    if (productIds.has(id) && d === 0) {
      const runs = runsOf.get(id) ?? 0;
      lines.push({ typeId: id, name: r.name, activity: r.activity, depth: 0, need: demand.get(id) ?? 0, fromStock: 0, runs, output: runs * r.outputPerRun, seconds: runs * r.secondsPerRun, isProduct: true });
      continue;
    }
    const need = demand.get(id) ?? 0;
    const fromStock = take(id, need);
    const runs = Math.ceil((need - fromStock) / r.outputPerRun - 1e-9);
    for (const i of r.inputs) add(demand, i.typeId, Math.ceil(runs * i.perRun - 1e-9));
    lines.push({ typeId: id, name: r.name, activity: r.activity, depth: d, need, fromStock, runs, output: runs * r.outputPerRun, seconds: runs * r.secondsPerRun, isProduct: false });
  }

  const buyLines: BuyLine[] = [];
  let costWithout = 0;
  let costWith = 0;
  let saved = 0;
  const line = (id: number, need: number, note?: string): BuyLine => {
    const b = buy.get(id);
    const fromStock = take(id, need);
    const toBuy = need - fromStock;
    const price = b?.unitPrice ?? null;
    if (price !== null) {
      costWithout += need * price;
      costWith += toBuy * price;
      saved += fromStock * price;
    }
    return { typeId: id, name: b?.name ?? `#${id}`, need, fromStock, toBuy, unitPrice: price, cost: price === null ? null : toBuy * price, volume: toBuy * (b?.volume ?? 0), ...(note ? { note } : {}) };
  };
  for (const [id, need] of demand) {
    if (recipes.has(id) || need <= 0) continue;
    buyLines.push(line(id, need));
  }
  for (const e of input.extraBuy ?? []) {
    const existing = buyLines.find((l) => l.typeId === e.typeId && !l.note);
    if (existing) {
      // Same item used in the chain and for invention: one line, stock already applied to the chain.
      const extra = line(e.typeId, e.quantity);
      existing.need += extra.need;
      existing.fromStock += extra.fromStock;
      existing.toBuy += extra.toBuy;
      existing.cost = existing.cost === null || extra.cost === null ? null : existing.cost + extra.cost;
      existing.volume += extra.volume;
      existing.note = e.note;
    } else buyLines.push(line(e.typeId, e.quantity, e.note));
  }

  const byDepth = new Map<number, StageLine[]>();
  for (const l of lines) byDepth.set(l.depth, [...(byDepth.get(l.depth) ?? []), l]);
  return {
    stages: [...byDepth.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([d, ls]) => ({ depth: d, lines: ls.sort((a, b) => a.activity.localeCompare(b.activity) || b.seconds - a.seconds) })),
    buy: buyLines.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
    savedByStock: saved,
    costWithoutStock: costWithout,
    costWithStock: costWith,
  };
}

// ---- progress ----------------------------------------------------------------

export interface ProgressJob {
  productTypeId: number | null;
  activity: Activity | null;
  runs: number;
  /** ESI status: active, ready, delivered, cancelled, paused, reverted. */
  status: string;
  startDate: string;
  endDate: string;
}

export interface LineProgress {
  /** Runs of jobs started since the plan was saved. */
  started: number;
  /** Of those, finished (ready to deliver or delivered). */
  done: number;
  /** Runs still to start (0 when the line is covered). */
  left: number;
  /** When the last running job of this line ends (ISO), null = nothing running. */
  runningUntil: string | null;
  state: "todo" | "partial" | "running" | "done";
}

/**
 * Matches the industry jobs started after the plan was saved to its lines, by product and
 * activity. Jobs are handed out to lines first-come, so two lines of one type share fairly.
 */
export function stageProgress(lines: { typeId: number; activity: Activity; runs: number }[], jobs: ProgressJob[], since: string, now: Date): LineProgress[] {
  const pool = new Map<string, { started: number; done: number; until: string | null }>();
  const key = (t: number | null, a: Activity | null) => `${t}:${a}`;
  for (const j of jobs) {
    if (!j.productTypeId || !j.activity || j.startDate < since || j.status === "cancelled" || j.status === "reverted") continue;
    const p = pool.get(key(j.productTypeId, j.activity)) ?? { started: 0, done: 0, until: null };
    p.started += j.runs;
    const finished = j.status === "delivered" || j.status === "ready" || Date.parse(j.endDate) <= now.getTime();
    if (finished) p.done += j.runs;
    else if (!p.until || j.endDate > p.until) p.until = j.endDate;
    pool.set(key(j.productTypeId, j.activity), p);
  }
  return lines.map((l) => {
    const p = pool.get(key(l.typeId, l.activity));
    const started = Math.min(l.runs, p?.started ?? 0);
    const done = Math.min(started, p?.done ?? 0);
    if (p) {
      p.started -= started;
      p.done -= done;
    }
    const left = Math.max(0, l.runs - started);
    const state = l.runs === 0 || (left === 0 && done >= started) ? "done" : left === 0 ? "running" : started > 0 ? "partial" : "todo";
    return { started, done, left, runningUntil: started > done ? p?.until ?? null : null, state };
  });
}
