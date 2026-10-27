/**
 * Weekly production planner (pure). Nick logs in every `cadenceDays`; a slot that finishes
 * between logins sits idle until the next one. The plan is 7 days: every job in it starts inside
 * the week (a hull may end later); what cannot start in time is carried over to the next plan.
 *
 * Conveyor (how Nick runs it): the hulls of this week are built from what is already there (stock,
 * or running jobs once they end); the components and reactions for next week's hulls are built this
 * week, merged across all batches (one job per intermediate type, not one per batch). A hull whose
 * chain finishes inside the week on a slot that is still free starts this week too. The first week
 * with an empty stock is a ramp-up: components only.
 *  - order: pins → hulls from stock → components for next week → (hulls of those that finish early);
 *  - batch size: the product job should end right before a login — best profit per *occupied*
 *    slot-day, ties → longer jobs (fewer logins);
 *  - product jobs start only at logins, on the earliest free slot of their kind (a reaction sold
 *    as a product goes to a reaction slot, not a factory one);
 *  - intermediates are pooled per type and must fit in the slots left over in the period;
 *  - greedy by tier (e.g. Caldari ships first), then profit per slot-day, within budget, a
 *    market cap per item and a per-item share of the budget (variety over one big hull);
 *  - pinned items go first, with their batch count, past the market cap and the budget share;
 *  - invention for the next round is pooled like components and must fit the lab slots;
 *  - stock: what a batch takes from the hangars is not paid from the budget; the stock is used up
 *    batch by batch, and batches made largely from stock go first within their tier;
 *  - jobs of a kind may have a length cap (reactions ≤ 2 days): longer ones run as parallel jobs.
 */
import { splitRuns } from "./stages";
import type { Activity } from "./types";

export type SlotKind = "manufacturing" | "reaction" | "science";
const KINDS: SlotKind[] = ["manufacturing", "reaction", "science"];
const DAY = 86_400;

/** The plan is one week: jobs start inside it (they may end later). Nick's rule, not a game constant. */
export const PLAN_HORIZON_DAYS = 7;

export interface PlanJob {
  typeId: number;
  name: string;
  activity: Activity;
  runs: number;
  seconds: number;
  /** 0 = the product; 1 = its direct inputs; … Higher levels must finish first. */
  depth: number;
  /** Blueprint production limit: most runs one job may have. */
  maxRunsPerJob?: number;
  /**
   * Product only: the runs as sequential jobs of the same blueprint (one blueprint runs one job at
   * a time), from `splitSequential`. Each starts at the login after the previous one ends.
   */
  parts?: number[];
  /** Built inputs (type ids) this job waits for; without it, every deeper level waits. */
  inputs?: number[];
}

export interface PlanBatch {
  typeId: number;
  name: string;
  runs: number;
  units: number;
  profit: number;
  /** ISK needed up front: materials + job fees + blueprint + freight. */
  capital: number;
  jobs: PlanJob[];
  /** How many batches of this item are possible at all (e.g. owned BPC copies); undefined = no limit. */
  maxBatches?: number;
  /** Preference multiplier on the ranking score (1 = neutral). */
  weight?: number;
  /** Lower tiers are planned first (e.g. 0 = Caldari ships); same tier → by score. */
  tier?: number;
  /** Distinguishes routes of the same item (own BPC vs invention); defaults to typeId. */
  key?: string;
  /** Pinned by Nick: this many units are planned first (whole batches, rounded up), whatever the ranking. */
  pinned?: number;
  /** Small batch that only fills slots left idle (set with the last tier); shown as such. */
  filler?: boolean;
}

export interface SlotState {
  kind: SlotKind;
  /** Character the slot belongs to (for the schedule); free text. */
  owner: string;
  /** Day (from now) when the slot is free; 0 = free now. */
  freeAt: number;
}

export interface ScheduledJob extends PlanJob {
  batchTypeId: number;
  slot: number;
  owner: string;
  /** Login day the job starts, and the day it ends (fractional). */
  start: number;
  end: number;
  /** One of several sequential jobs of the same blueprint (1-based). */
  part?: { index: number; of: number };
}

/** An intermediate pooled over all batches of the plan. */
export interface PrepJob {
  typeId: number;
  name: string;
  activity: Activity;
  /** Invention: expected attempts (rounded up over the pool). */
  runs: number;
  seconds: number;
  depth: number;
  /** Login day to start it: deepest level first, one level per login. */
  start: number;
  /** Parallel jobs it is split into so each one ends inside the plan. */
  jobs: number;
  maxRunsPerJob?: number;
  inputs?: number[];
}

/** A hull whose components are made this week: it starts next week. */
export type NextWeekBatch = PlanBatch & { fromStock: number; /** Day its components are ready; null = not inside this week. */ ready: number | null };

export interface Plan {
  /** fromStock: market value taken from stock (capital − fromStock = ISK spent). */
  batches: (PlanBatch & { start: number; end: number; fromStock: number })[];
  /** Product jobs on slots. */
  jobs: ScheduledJob[];
  /** Components, reactions and invention, merged per type: for this week's hulls that wait for them and for next week's. */
  prep: PrepJob[];
  /** Hulls the components of this plan are for, starting next week (their capital is spent this week). */
  nextWeek: NextWeekBatch[];
  /** Profit of the next-week hulls (not in `profit`). */
  nextWeekProfit: number;
  /** No hulls this week, only components for the next one (the first week with an empty stock). */
  rampUp: boolean;
  /** Intermediate jobs that cannot start inside the week: the next plan picks them up. */
  carried: { name: string; activity: Activity; runs: number; jobs: number }[];
  /** Login days with something to do, and what. */
  logins: { day: number; start: ScheduledJob[]; finish: ScheduledJob[]; prep: PrepJob[] }[];
  /** Profit of the hulls that start this week. */
  profit: number;
  /** ISK to spend this week (this week's and next week's hulls): capital minus what comes from stock. */
  capital: number;
  /** Market value of what the plan takes from stock (not paid from the budget). */
  fromStock: number;
  /** Share of slot-days within the horizon that are busy (products + prep), per kind. */
  utilization: Record<SlotKind, number>;
  skipped: { name: string; reason: string }[];
  /** Things the plan cannot do as asked (e.g. more parallel jobs than free slots before the end). */
  warnings: string[];
  /** Every pinned item: units asked and planned; short ones say why and how many slot-days are missing. */
  pins: PinResult[];
}

export interface PinResult {
  typeId: number;
  name: string;
  want: number;
  planned: number;
  reason?: string;
  missingSlotDays?: number;
}

/**
 * What a batch takes from stock: units by type, their market value, and the runs of each
 * intermediate still to build after that (all of them when `build` is missing). Computed by the
 * caller (it knows the recipe tree).
 */
export type StockUse = (batch: PlanBatch, left: ReadonlyMap<number, number>) => { take: Map<number, number>; value: number; build?: Map<number, number> };

/** A batch with at least this share of its cost covered by stock counts as "made from stock" (goes first in its tier). UX choice. */
export const STOCK_FIRST_SHARE = 0.3;

/**
 * Which login of a saved plan is "now": the last one whose day has come (half a cadence early
 * counts: you rarely log in on the hour), else the first one.
 */
export function currentLogin(days: number[], planDay: number, cadenceDays: number): number {
  let at = 0;
  days.forEach((d, i) => {
    if (d <= planDay + cadenceDays / 2 + 1e-9) at = i;
  });
  return at;
}

/** Round a day up to the next login. */
export const nextLogin = (day: number, cadence: number) => Math.max(0, Math.ceil(day / cadence - 1e-9)) * cadence + 0;

/**
 * Run count for one batch: the product job should end just before a login.
 * Returns the runs maximising profit per occupied day of the product slot.
 */
export function batchRunsForCadence(p: {
  secondsPerRun: number;
  profitPerRun: number;
  maxRuns: number;
  cadenceDays: number;
  horizonDays: number;
  /** Batches earning less are only taken when nothing bigger fits. */
  minProfit?: number;
}): number {
  const { secondsPerRun, profitPerRun, maxRuns, cadenceDays, horizonDays } = p;
  if (secondsPerRun <= 0) return Math.max(1, maxRuns || 1);
  let best = 1;
  let bestScore = -Infinity;
  let bestBig = false;
  for (let k = 1; k * cadenceDays <= horizonDays + 1e-9; k++) {
    let runs = Math.max(1, Math.floor((k * cadenceDays * DAY) / secondsPerRun));
    if (maxRuns > 0) runs = Math.min(runs, maxRuns);
    const occupied = nextLogin((runs * secondsPerRun) / DAY, cadenceDays) || cadenceDays;
    const score = (profitPerRun * runs) / occupied;
    // A batch above the minimum always beats one below it: fewer, bigger jobs.
    const big = profitPerRun * runs >= (p.minProfit ?? 0);
    if (bestBig && !big) continue;
    if (big && !bestBig) {
      [best, bestScore, bestBig] = [runs, score, true];
      continue;
    }
    // ≥: a longer batch with the same daily profit means fewer logins.
    if (score >= bestScore - 1e-6 * Math.abs(bestScore)) {
      best = runs;
      bestScore = Math.max(score, bestScore);
    }
  }
  return best;
}

const slotKind = (a: Activity): SlotKind | null =>
  a === "manufacturing" ? "manufacturing" : a === "reaction" ? "reaction" : isLab(a) ? "science" : null;
/** Lab jobs (copying the T1 blueprint, then invention) feed only the hull: they live outside the component chain. */
const isLab = (a: Activity) => a === "invention" || a === "copying";

/**
 * Factory and reaction slot-days a batch costs: the product job snaps to logins (its slot waits
 * for you), the intermediates count at their real length (they are pooled and fill otherwise idle
 * slots). Lab time is a separate resource and does not count here.
 */
export function slotDays(b: PlanBatch, cadence: number): number {
  const snapped = (j: PlanJob) => (j.parts ?? [j.runs]).reduce((s, r) => s + (nextLogin((j.seconds * r) / j.runs / DAY, cadence) || cadence), 0);
  return b.jobs.reduce((s, j) => s + (slotKind(j.activity) === "science" ? 0 : j.depth === 0 ? snapped(j) : j.seconds / DAY), 0);
}

/**
 * Splits one blueprint's runs into sequential jobs no longer than `capDays` each (a single run may
 * be longer). Best split: fewest slot-days snapped to logins, then the lowest material cost (the
 * game rounds materials per job, so short jobs lose the ME saving), then fewer jobs. Longest first.
 * Without a cap, or when it fits, it is one job.
 */
export function splitSequential(p: {
  runs: number;
  secondsPerRun: number;
  capDays?: number;
  cadenceDays: number;
  /** Cost of what one job of `runs` runs consumes; omitted = only slot-days count. */
  partCost?: (runs: number) => number;
}): { parts: number[]; slotDays: number; extraCost: number } {
  const { runs, secondsPerRun, cadenceDays: cad } = p;
  const days = (k: number) => nextLogin((k * secondsPerRun) / DAY, cad) || cad;
  const memo = new Map<number, number>();
  const cost = (k: number) => {
    if (!p.partCost) return 0;
    if (!memo.has(k)) memo.set(k, p.partCost(k));
    return memo.get(k)!;
  };
  const maxRuns = p.capDays && secondsPerRun > 0 ? Math.max(1, Math.floor((p.capDays * DAY) / secondsPerRun + 1e-9)) : runs;
  if (runs <= maxRuns) return { parts: [runs], slotDays: days(runs), extraCost: 0 };
  type Best = { days: number; cost: number; n: number; first: number };
  const best: Best[] = [{ days: 0, cost: 0, n: 0, first: 0 }];
  const better = (a: Best, b: Best) =>
    a.days < b.days - 1e-9 || (Math.abs(a.days - b.days) <= 1e-9 && (a.cost < b.cost - 1e-6 || (Math.abs(a.cost - b.cost) <= 1e-6 && a.n < b.n)));
  for (let r = 1; r <= runs; r++) {
    let b: Best | null = null;
    for (let k = 1; k <= Math.min(r, maxRuns); k++) {
      const rest = best[r - k];
      const c = { days: rest.days + days(k), cost: rest.cost + cost(k), n: rest.n + 1, first: k };
      if (!b || better(c, b)) b = c;
    }
    best.push(b!);
  }
  const parts: number[] = [];
  for (let r = runs; r > 0; r -= best[r].first) parts.push(best[r].first);
  parts.sort((a, b) => b - a);
  return { parts, slotDays: best[runs].days, extraCost: p.partCost ? best[runs].cost - cost(runs) : 0 };
}

export interface PlanInput {
  candidates: PlanBatch[];
  slots: SlotState[];
  budget: number;
  cadenceDays: number;
  horizonDays: number;
  /** Max batches of one item per week (market cap is applied by the caller via units). */
  maxBatchesPerItem: number;
  /** Max units of one item a week. */
  unitCap: (typeId: number) => number;
  /** Max share of the budget one item may take (all its batches together); default 1 = no cap. */
  maxItemShare?: number;
  /** Longest single job per slot kind, days (e.g. reactions: 2); longer ones are split into parallel jobs. */
  maxJobDays?: Partial<Record<SlotKind, number>>;
  /** Units on hand by type and how a batch uses them; without it everything is bought and built. */
  stock?: Map<number, number>;
  stockUse?: StockUse;
  /** The part of `stock` that running jobs deliver: usable from the day they end. */
  jobStock?: Map<number, { quantity: number; day: number }>;
  /** Batches made largely from stock go first within their tier (profitable ones only). */
  stockFirst?: boolean;
}

type Use = ReturnType<StockUse>;
/** Internal stop signals of `fill` (never shown). */
const NEEDS_BUILD = "needs build";
const LIMIT = "limit";
const isPrepJob = (j: PlanJob) => j.depth > 0 && slotKind(j.activity) !== null;
const poolKey = (j: { typeId: number; activity: Activity }) => `${j.typeId}:${j.activity}`;

export function planWeek(input: PlanInput): Plan {
  const { cadenceDays: cad, horizonDays: horizon } = input;
  const stockLeft = new Map(input.stock ?? []);
  // What lies in the hangars (usable today); the rest of `stock` comes out of running jobs.
  const hangarLeft = new Map([...stockLeft].map(([id, q]) => [id, Math.max(0, q - (input.jobStock?.get(id)?.quantity ?? 0))]));
  const stockTakenBy = (c: PlanBatch): Use => (input.stockUse && stockLeft.size ? input.stockUse(c, stockLeft) : { take: new Map<number, number>(), value: 0 });
  // Static share at the start: decides the order only; the real use is taken batch by batch.
  const fromStockFirst = (c: PlanBatch) => (input.stockFirst && c.profit > 0 && c.capital > 0 && stockTakenBy(c).value / c.capital >= STOCK_FIRST_SHARE ? 0 : 1);
  const slots = input.slots.map((s) => ({ ...s, freeAt: nextLogin(s.freeAt, cad) }));
  const ranked = input.candidates
    .filter((c) => c.profit > 0 || c.pinned)
    .map((c) => ({ c, score: (c.profit / Math.max(cad, slotDays(c, cad))) * (c.weight ?? 1), stock: fromStockFirst(c) }))
    .sort((a, b) => (a.c.tier ?? 0) - (b.c.tier ?? 0) || a.stock - b.stock || b.score - a.score);

  // Slot-days available per kind this week, after what is already running.
  const capacity: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  for (const s of slots) capacity[s.kind] += Math.max(0, horizon - s.freeAt);
  const used: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  // Product slot-days next week taken by the hulls whose components are made now.
  const nextUsed: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  const nextCapacity = (kind: SlotKind) => slots.filter((s) => s.kind === kind).reduce((n, s) => n + Math.max(0, 2 * horizon - Math.max(horizon, s.freeAt)), 0) - nextUsed[kind];

  let budget = input.budget;
  const batches: Plan["batches"] = [];
  const nextWeek: NextWeekBatch[] = [];
  /** Per next-week batch: the batch as planned and what it builds (for moving it to this week). */
  const nextInfo = new Map<NextWeekBatch, { c: PlanBatch; build: (j: PlanJob) => number; pinned: boolean }>();
  const jobs: ScheduledJob[] = [];
  const skipped: Plan["skipped"] = [];
  const warnings: string[] = [];
  const unitsNow = new Map<number, number>();
  const unitsNext = new Map<number, number>();
  const spentPerItem = new Map<number, number>();
  const itemCap = input.budget * Math.min(1, Math.max(0, input.maxItemShare ?? 1));
  const prep = new Map<string, PrepJob>();
  const madeNow = new Map<PlanBatch, number>();
  const madeNext = new Map<PlanBatch, number>();
  const made = (c: PlanBatch) => (madeNow.get(c) ?? 0) + (madeNext.get(c) ?? 0);
  const lastWhy = new Map<string, string>();
  const bump = (m: Map<PlanBatch, number>, c: PlanBatch) => m.set(c, (m.get(c) ?? 0) + 1);

  /** Runs of an intermediate the batch still has to build after stock. */
  const builder = (use: Use) => (j: PlanJob) => (use.build ? Math.min(j.runs, use.build.get(j.typeId) ?? 0) : j.runs);
  /** The batch needs something built first: an intermediate not covered by stock, or a BPC from invention. */
  const needsBuild = (c: PlanBatch, use: Use) => c.jobs.some((j) => j.depth > 0 && (isLab(j.activity) || (slotKind(j.activity) && builder(use)(j) > 0)));
  /** Day the stock a batch takes is there: the hangars now, running jobs when they end. */
  const stockReady = (use: Use) => {
    let day = 0;
    for (const [id, q] of use.take) if (q > (hangarLeft.get(id) ?? 0) + 1e-9) day = Math.max(day, input.jobStock?.get(id)?.day ?? 0);
    return day;
  };

  /** Puts the product job(s) on the earliest free slots from `earliest`; null when the first does not start inside the week. */
  const placeProduct = (c: PlanBatch, earliest: number, free: number[]) => {
    const product = c.jobs.find((j) => j.depth === 0)!;
    const kind: SlotKind = slotKind(product.activity) ?? "manufacturing";
    const cap = input.maxJobDays?.[kind];
    // Sequential parts of one blueprint stay on one slot, back to back; the first must start inside
    // the plan, the last may end next week. Otherwise: parallel jobs, each on its own slot.
    const sequential = (product.parts?.length ?? 0) > 1;
    const parts = product.parts ?? splitRuns(product.runs, product.seconds / product.runs, cap ? cap * DAY : undefined);
    const f = [...free];
    const placed: { slot: number; runs: number; start: number; end: number }[] = [];
    let days = 0;
    for (const runs of parts) {
      let best = -1;
      if (sequential && placed.length) best = placed[0].slot;
      else
        for (let i = 0; i < slots.length; i++) {
          if (slots[i].kind !== kind) continue;
          if (best === -1 || Math.max(f[i], earliest) < Math.max(f[best], earliest)) best = i;
        }
      if (best === -1) return null;
      const start = nextLogin(Math.max(f[best], earliest), cad);
      if (start >= horizon && !(sequential && placed.length)) return null;
      const end = start + (product.seconds * runs) / product.runs / DAY;
      days += Math.max(0, Math.min(nextLogin(end, cad) - start || cad, horizon - start));
      placed.push({ slot: best, runs, start, end });
      f[best] = nextLogin(end, cad);
    }
    return { product, kind, sequential, placed, days, free: f };
  };

  const commitProduct = (c: PlanBatch, p: NonNullable<ReturnType<typeof placeProduct>>) => {
    for (const [i, x] of p.placed.entries()) {
      jobs.push({
        ...p.product,
        runs: x.runs,
        seconds: (p.product.seconds * x.runs) / p.product.runs,
        batchTypeId: c.typeId,
        slot: x.slot,
        owner: slots[x.slot].owner,
        start: x.start,
        end: x.end,
        ...(p.sequential ? { part: { index: i + 1, of: p.placed.length } } : {}),
      });
    }
    return { start: Math.min(...p.placed.map((x) => x.start)), end: Math.max(...p.placed.map((x) => x.end)) };
  };

  /** Budget, stock and per-item spend of a placed batch. */
  const pay = (c: PlanBatch, use: Use, cash: number) => {
    budget -= cash;
    for (const [id, q] of use.take) {
      stockLeft.set(id, Math.max(0, (stockLeft.get(id) ?? 0) - q));
      hangarLeft.set(id, Math.max(0, (hangarLeft.get(id) ?? 0) - q));
    }
    spentPerItem.set(c.typeId, (spentPerItem.get(c.typeId) ?? 0) + cash);
  };

  /** Budget, the item's budget share and the market cap of the week; null = fine. */
  const limits = (c: PlanBatch, cash: number, pinned: boolean, units: Map<number, number>): string | null => {
    if (cash > budget) return "не хватает бюджета";
    if (pinned) return null;
    // Spread the budget: one expensive hull must not crowd out the rest of the week.
    if ((spentPerItem.get(c.typeId) ?? 0) + cash > itemCap + 1e-6) return `одна позиция не больше ${Math.round((itemCap / input.budget) * 100)}% бюджета`;
    if ((units.get(c.typeId) ?? 0) + c.units > input.unitCap(c.typeId)) return "рынок не возьмёт больше";
    return null;
  };

  /** A hull from what is there: the product job only, this week. */
  const placeNow = (c: PlanBatch, use: Use, pinned: boolean): string | null => {
    const cash = Math.max(0, c.capital - use.value);
    const why = limits(c, cash, pinned, unitsNow);
    if (why) return why;
    const p = placeProduct(c, nextLogin(stockReady(use), cad), slots.map((s) => s.freeAt));
    if (!p) return "нет свободных слотов в пределах недели";
    if (used[p.kind] + p.days > capacity[p.kind] + 1e-9) return "нет свободных слотов в пределах недели";
    used[p.kind] += p.days;
    for (const [i, f] of p.free.entries()) slots[i].freeAt = f;
    const { start, end } = commitProduct(c, p);
    batches.push({ ...c, start, end, fromStock: c.capital - cash });
    pay(c, use, cash);
    unitsNow.set(c.typeId, (unitsNow.get(c.typeId) ?? 0) + c.units);
    bump(madeNow, c);
    return null;
  };

  /** A hull whose components (or BPC) are made this week: they go to the pool, the hull to next week. */
  const placeNext = (c: PlanBatch, use: Use, pinned: boolean): string | null => {
    const cash = Math.max(0, c.capital - use.value);
    const why = limits(c, cash, pinned, unitsNext);
    if (why) return why;
    const build = builder(use);
    const todo = c.jobs.filter(isPrepJob).map((j) => ({ j, runs: isLab(j.activity) ? j.runs : build(j) })).filter((x) => x.runs > 0);
    const after = { ...used };
    for (const { j, runs } of todo) after[slotKind(j.activity)!] += (j.seconds * runs) / j.runs / DAY;
    if (after.manufacturing > capacity.manufacturing + 1e-9 || after.reaction > capacity.reaction + 1e-9) return "не хватит слотов на компоненты и реакции";
    if (after.science > capacity.science + 1e-9) return "не хватит лабораторных слотов на инвент";
    const product = c.jobs.find((j) => j.depth === 0)!;
    const kind = slotKind(product.activity) ?? "manufacturing";
    // Next week's slot-days of the hull: it has to start next week, not end in it (one track per parallel job).
    const cap = input.maxJobDays?.[kind];
    const perRun = product.seconds / product.runs / DAY;
    const snap = (runs: number) => nextLogin(runs * perRun, cad) || cad;
    const tracks = (product.parts?.length ?? 0) > 1 ? [product.parts!.reduce((n, r) => n + snap(r), 0)] : splitRuns(product.runs, perRun * DAY, cap ? cap * DAY : undefined).map(snap);
    const days = tracks.reduce((n, d) => n + Math.min(d, horizon), 0);
    if (days > nextCapacity(kind) + 1e-9) return "на следующей неделе нет слотов под этот корпус";
    Object.assign(used, after);
    nextUsed[kind] += days;
    for (const { j, runs } of todo) {
      const k = poolKey(j);
      const cur = prep.get(k) ?? { typeId: j.typeId, name: j.name, activity: j.activity, runs: 0, seconds: 0, depth: 0, start: 0, jobs: 1, maxRunsPerJob: j.maxRunsPerJob, inputs: j.inputs };
      cur.runs += runs;
      cur.seconds += (j.seconds * runs) / j.runs;
      cur.depth = Math.max(cur.depth, j.depth);
      prep.set(k, cur);
    }
    const nb: NextWeekBatch = { ...c, fromStock: c.capital - cash, ready: null };
    nextWeek.push(nb);
    nextInfo.set(nb, { c, build, pinned });
    pay(c, use, cash);
    unitsNext.set(c.typeId, (unitsNext.get(c.typeId) ?? 0) + c.units);
    bump(madeNext, c);
    return null;
  };

  /** One batch: this week if everything is there, else its chain now and the hull next week. */
  const place = (c: PlanBatch, pinned: boolean, onlyReady = false, nowFull = false): string | null => {
    if (!c.jobs.some((j) => j.depth === 0)) return "нет джобы продукта";
    const use = stockTakenBy(c);
    if (!needsBuild(c, use)) {
      if (nowFull) return LIMIT;
      const why = placeNow(c, use, pinned);
      // A pinned hull from stock with no slot left this week goes first thing next week.
      return why && pinned && why.includes("слот") ? placeNext(c, use, pinned) : why;
    }
    return onlyReady ? NEEDS_BUILD : placeNext(c, use, pinned);
  };

  const keyOf = (c: PlanBatch) => c.key ?? String(c.typeId);
  /** Batches of an item while they fit: `onlyReady` = from stock only (stops at the first that needs building). */
  const fill = (c: PlanBatch, upTo: number, onlyReady: boolean) => {
    while (made(c) < (c.maxBatches ?? Infinity) && ((onlyReady ? madeNow : madeNext).get(c) ?? 0) < upTo) {
      const why = place(c, false, onlyReady, (madeNow.get(c) ?? 0) >= upTo);
      if (!why) continue;
      if (why !== NEEDS_BUILD && why !== LIMIT) lastWhy.set(keyOf(c), why);
      break;
    }
  };

  // Pinned first (they may lose money: Nick decided). The count is units per item, rounded up to whole
  // batches; when one route runs out (own BPCs used up), the next one (invention) adds the rest.
  // A pinned item gets exactly that: nothing is added on top by the ranking. A hull whose components
  // are made now and that starts next week counts as planned.
  const pinnedItems = new Map<number, PlanBatch[]>();
  for (const { c } of ranked) if (c.pinned && c.jobs.some((j) => j.depth === 0)) pinnedItems.set(c.typeId, [...(pinnedItems.get(c.typeId) ?? []), c]);
  const pins: PinResult[] = [];
  for (const routes of pinnedItems.values()) {
    const want = Math.max(...routes.map((c) => c.pinned ?? 0));
    const units = () => routes.reduce((n, c) => n + made(c) * c.units, 0);
    let why: string | null = null;
    let stuck: PlanBatch | null = null;
    for (const c of routes) {
      while (units() < want && made(c) < (c.maxBatches ?? Infinity)) {
        why = place(c, true);
        if (why) {
          stuck = c;
          break;
        }
      }
      if (units() >= want) break;
    }
    const got = units();
    const short = Math.max(0, want - got);
    // Slot-days the rest would need, at the size of the batch that did not fit.
    const missingSlotDays = short && stuck && why?.includes("слот") ? Math.ceil(short / Math.max(1, stuck.units)) * slotDays(stuck, cad) : 0;
    pins.push({ typeId: routes[0].typeId, name: routes[0].name, want, planned: got, ...(short ? { reason: why ?? "кончились свои BPC, инвента нет", missingSlotDays } : {}) });
    if (short) skipped.push({ name: routes[0].name, reason: `закреплено ${want} шт., влезло ${got}: ${why ?? "кончились свои BPC, инвента нет"}${missingSlotDays ? `, не хватает ~${Math.round(missingSlotDays * 10) / 10} слот-дней` : ""}` });
    // Past the limits the ranking keeps: shown, not blocked (Nick decided).
    const id = routes[0].typeId;
    const cap = input.unitCap(id);
    const week = Math.max(unitsNow.get(id) ?? 0, unitsNext.get(id) ?? 0);
    if (week > cap + 1e-9) warnings.push(`${routes[0].name}: закреплено ${week} шт. за неделю — больше ${Math.round(cap)} шт., которые возьмёт рынок при заданной доле`);
    if ((spentPerItem.get(id) ?? 0) > itemCap + 1e-6) warnings.push(`${routes[0].name}: закреп берёт ${Math.round(((spentPerItem.get(id) ?? 0) / Math.max(1, input.budget)) * 100)}% бюджета — больше лимита одной позиции`);
  }
  const free = ranked.filter(({ c }) => c.profit > 0 && !pinnedItems.has(c.typeId));
  // Hulls from what is there; then the components for next week; fillers last.
  for (const { c } of free) if (!c.filler) fill(c, input.maxBatchesPerItem, true);
  for (const { c } of free) if (!c.filler) fill(c, input.maxBatchesPerItem, false);
  for (const { c } of free) if (c.filler) fill(c, input.maxBatchesPerItem, false);
  // Reported only when nothing of the item fit (per route).
  for (const { c } of free) {
    const why = lastWhy.get(keyOf(c));
    if (why && !made(c) && !skipped.some((s) => s.name === c.name)) skipped.push({ name: c.name, reason: why });
  }

  // The pool: parallel jobs per type so each fits the week (and the blueprint's run limit).
  const prepJobs = [...prep.values()];
  for (const p of prepJobs) {
    const kind = slotKind(p.activity);
    const cap = kind ? input.maxJobDays?.[kind] : undefined;
    const byTime = Math.ceil(p.seconds / DAY / (cap ? Math.min(cap, Math.max(cad, horizon)) : Math.max(cad, horizon)) - 1e-9);
    const byRuns = p.maxRunsPerJob ? Math.ceil(p.runs / p.maxRunsPerJob) : 1;
    p.jobs = Math.min(Math.ceil(p.runs - 1e-9), Math.max(1, byTime, byRuns));
    // Invention attempts (and the T1 copies they eat) are an expectation per batch: round up once over the pool.
    if (isLab(p.activity)) {
      const runs = Math.ceil(p.runs - 1e-9);
      p.seconds = p.runs > 0 ? (p.seconds * runs) / p.runs : 0;
      p.runs = runs;
      p.jobs = Math.min(runs, Math.max(1, Math.ceil(p.seconds / DAY / Math.max(cad, horizon) - 1e-9)));
    }
  }
  const sched = schedulePrep(prepJobs, slots, cad, horizon);
  warnings.push(...sched.warnings);

  // A next-week hull whose chain is done inside the week, on a slot still free: it starts this week.
  for (const nb of [...nextWeek]) {
    const info = nextInfo.get(nb)!;
    let ready = 0;
    for (const j of info.c.jobs) if (isPrepJob(j) && (isLab(j.activity) || info.build(j) > 0)) ready = Math.max(ready, sched.ready.get(poolKey(j)) ?? Infinity);
    nb.ready = Number.isFinite(ready) && ready < horizon ? ready : null;
    if (nb.ready === null) continue;
    if (!info.pinned && (unitsNow.get(nb.typeId) ?? 0) + nb.units > input.unitCap(nb.typeId)) continue;
    const p = placeProduct(info.c, nextLogin(nb.ready, cad), sched.free);
    if (!p) continue;
    sched.free.splice(0, sched.free.length, ...p.free);
    used[p.kind] += p.days;
    const { start, end } = commitProduct(info.c, p);
    batches.push({ ...info.c, fromStock: nb.fromStock, start, end });
    nextWeek.splice(nextWeek.indexOf(nb), 1);
    unitsNow.set(nb.typeId, (unitsNow.get(nb.typeId) ?? 0) + nb.units);
    unitsNext.set(nb.typeId, (unitsNext.get(nb.typeId) ?? 0) - nb.units);
  }

  const days = new Map<number, Plan["logins"][number]>();
  const at = (d: number) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { day: d, start: [], finish: [], prep: [] }));
    return x;
  };
  // The week only: what ends later is picked up by the next plan.
  for (const j of jobs) {
    if (j.start < horizon) at(j.start).start.push(j);
    if (nextLogin(j.end, cad) < horizon) at(nextLogin(j.end, cad)).finish.push(j);
  }
  for (const p of sched.prep) at(p.start).prep.push(p);

  const utilization: Record<SlotKind, number> = { manufacturing: 0, reaction: 0, science: 0 };
  for (const kind of KINDS) {
    const n = slots.filter((s) => s.kind === kind).length;
    if (n) utilization[kind] = Math.min(1, used[kind] / (n * horizon));
  }
  const all = [...batches, ...nextWeek];
  return {
    batches,
    jobs,
    prep: sched.prep,
    nextWeek,
    nextWeekProfit: nextWeek.reduce((s, b) => s + b.profit, 0),
    rampUp: !batches.some((b) => !b.filler) && nextWeek.length > 0,
    carried: sched.carried,
    warnings,
    logins: [...days.values()].sort((a, b) => a.day - b.day),
    profit: batches.reduce((s, b) => s + b.profit, 0),
    capital: all.reduce((s, b) => s + b.capital - b.fromStock, 0),
    fromStock: all.reduce((s, b) => s + b.fromStock, 0),
    utilization,
    skipped,
    pins,
  };
}

/** Extra budget the "what one more billion gives" figure is computed for. UX choice. */
export const BUDGET_STEP = 1e9;

export interface MarginalValues {
  /** Extra profit over the plan from one more free slot of a kind. */
  slot: Record<SlotKind, number>;
  /** The same per slot-day: what a day of that slot earns on the next batch that did not fit. */
  slotDay: Record<SlotKind, number>;
  /** Extra profit from one more character with the slots of the biggest one (all free). */
  character: { like: string; gain: number } | null;
  /** Extra profit from BUDGET_STEP more ISK. */
  budget: { step: number; gain: number };
}

/**
 * What one more slot, character or billion would add to the plan: the same plan is made again
 * with it. Shows the bottleneck (slots or ISK) and is the bar an intermediate must clear to take
 * a slot from the hulls. The planner is greedy, so a gain can be lumpy; it is never below 0.
 */
export function marginalValues(input: PlanInput, base: Plan = planWeek(input)): MarginalValues {
  // Next week's hulls count too: in a ramp-up week this week's profit is 0 whatever is added.
  const total = (p: Plan) => p.profit + p.nextWeekProfit;
  const gain = (more: Partial<PlanInput>) => Math.max(0, total(planWeek({ ...input, ...more })) - total(base));
  const horizon = Math.max(input.cadenceDays, input.horizonDays);
  const slot = { manufacturing: 0, reaction: 0, science: 0 };
  const slotDay = { ...slot };
  for (const kind of KINDS) {
    slot[kind] = gain({ slots: [...input.slots, { kind, owner: "+1 слот", freeAt: 0 }] });
    slotDay[kind] = slot[kind] / horizon;
  }
  const owners = [...new Set(input.slots.map((s) => s.owner))];
  const biggest = owners.sort((a, b) => input.slots.filter((s) => s.owner === b).length - input.slots.filter((s) => s.owner === a).length)[0];
  const twin = input.slots.filter((s) => s.owner === biggest).map((s) => ({ ...s, owner: `+${biggest}`, freeAt: 0 }));
  return {
    slot,
    slotDay,
    character: biggest === undefined ? null : { like: biggest, gain: gain({ slots: [...input.slots, ...twin] }) },
    budget: { step: BUDGET_STEP, gain: gain({ budget: input.budget + BUDGET_STEP }) },
  };
}

const KIND_NAME: Record<SlotKind, string> = { manufacturing: "производственных", reaction: "реакционных", science: "лабораторных" };

/**
 * Puts the parallel jobs of every pooled intermediate on real free slots (after the product jobs),
 * at logins. A job starts no earlier than the login after its inputs are done (its own inputs when
 * known, else every deeper level); invention waits for its T1 copies. A job that cannot start
 * inside the week is carried over to the next plan. Entries are split by start day.
 * Returns the free slots after that and the day each pooled type is ready (Infinity = not this week).
 */
function schedulePrep(
  pool: PrepJob[],
  slots: SlotState[],
  cad: number,
  horizon: number,
): { prep: PrepJob[]; warnings: string[]; carried: Plan["carried"]; free: number[]; ready: Map<string, number> } {
  const free = slots.map((s) => s.freeAt);
  const out: PrepJob[] = [];
  const warnings: string[] = [];
  const carried: Plan["carried"] = [];
  const ready = new Map<string, number>();
  /** End of the last job of each built type (manufacturing / reaction), and of each depth. */
  const typeEnd = new Map<number, number>();
  const depthEnd = new Map<number, number>();
  const rank = (a: Activity) => (a === "copying" ? 0 : a === "invention" ? 1 : 2);
  const order = [...pool].sort((a, b) => rank(a.activity) - rank(b.activity) || b.depth - a.depth || b.seconds - a.seconds);
  for (const p of order) {
    const kind = slotKind(p.activity) ?? "manufacturing";
    const key = poolKey(p);
    let earliest = 0;
    if (p.activity === "invention") earliest = ready.get(`${p.typeId}:copying`) ?? 0;
    else if (!isLab(p.activity)) {
      if (p.inputs) for (const id of p.inputs) earliest = Math.max(earliest, typeEnd.get(id) ?? 0);
      else for (const [d, end] of depthEnd) if (d > p.depth) earliest = Math.max(earliest, end);
    }
    const runs = splitRuns(p.runs, p.runs ? p.seconds / p.runs : 0, undefined, Math.ceil(p.runs / p.jobs));
    const byDay = new Map<number, PrepJob>();
    let late = 0;
    let lateRuns = 0;
    let end = 0;
    for (const r of runs) {
      const seconds = p.runs ? (p.seconds * r) / p.runs : 0;
      let best = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].kind !== kind) continue;
        if (best === -1 || Math.max(free[i], earliest) < Math.max(free[best], earliest)) best = i;
      }
      const start = best === -1 || !Number.isFinite(earliest) ? Infinity : nextLogin(Math.max(free[best], earliest), cad);
      if (start >= horizon) {
        late++;
        lateRuns += r;
        continue;
      }
      free[best] = nextLogin(start + seconds / DAY, cad);
      end = Math.max(end, start + seconds / DAY);
      const e = byDay.get(start) ?? { ...p, runs: 0, seconds: 0, jobs: 0, start };
      e.runs += r;
      e.seconds += seconds;
      e.jobs++;
      byDay.set(start, e);
    }
    const done = late ? Infinity : end;
    ready.set(key, done);
    if (!isLab(p.activity)) {
      typeEnd.set(p.typeId, Math.max(typeEnd.get(p.typeId) ?? 0, done));
      depthEnd.set(p.depth, Math.max(depthEnd.get(p.depth) ?? 0, done));
    }
    out.push(...byDay.values());
    if (late) {
      carried.push({ name: p.name, activity: p.activity, runs: lateRuns, jobs: late });
      const where = !slots.some((s) => s.kind === kind)
        ? `нет ${KIND_NAME[kind]} слотов`
        : Number.isFinite(earliest) && earliest < horizon
          ? `не хватает свободных ${KIND_NAME[kind]} слотов до конца недели`
          : "то, из чего она строится, не готово до конца недели";
      warnings.push(`${p.name}: ${late} из ${runs.length} джоб — ${where}, переносится на следующую неделю`);
    }
  }
  return { prep: out.sort((a, b) => a.start - b.start || b.depth - a.depth || b.seconds - a.seconds), warnings, carried, free, ready };
}
